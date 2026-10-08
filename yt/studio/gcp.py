"""Google Cloud API enablement and verification helpers.

Automatically checks and enables required GCP APIs (such as Vertex AI / Agent
Platform API and Cloud Speech-to-Text API) during local development and testing
using Application Default Credentials (ADC) or the gcloud CLI.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from urllib import error as urllib_error
from urllib import request as urllib_request

from google import auth as google_auth
from google.auth import exceptions as google_auth_exceptions
from google.auth.transport import requests as google_auth_requests

from yt.studio import config

logger = logging.getLogger(__name__)

VERTEX_API_SERVICE = 'aiplatform.googleapis.com'
SPEECH_API_SERVICE = 'speech.googleapis.com'

_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
_SERVICE_USAGE_URL = 'https://serviceusage.googleapis.com/v1'

# In-memory cache of verified enabled services: (project_id, service_name).
_ENABLED_SERVICES: set[tuple[str, str]] = set()


def _get_adc_token() -> str | None:
  """Retrieves a fresh OAuth 2.0 access token from ADC.

  Returns:
    The bearer token string, or None if credentials are unavailable.
  """
  try:
    credentials, _ = google_auth.default(scopes=[_CLOUD_PLATFORM_SCOPE])
    credentials.refresh(google_auth_requests.Request())
    return credentials.token
  except (
      google_auth_exceptions.GoogleAuthError,
      google_auth_exceptions.TransportError,
  ) as exc:
    logger.debug('Failed to get ADC token: %s', exc)
    return None


def is_service_enabled(project_id: str, service_name: str) -> bool:
  """Checks whether a GCP service is enabled for the specified project.

  Args:
    project_id: The Google Cloud project ID.
    service_name: The GCP service name (e.g. 'aiplatform.googleapis.com').

  Returns:
    True if the service is currently enabled, False otherwise.
  """
  key = (project_id, service_name)
  if key in _ENABLED_SERVICES:
    return True

  # In managed container environments (such as Cloud Run where K_SERVICE is set),
  # services are provisioned declaratively via Terraform, and the runtime
  # service account intentionally lacks Service Usage Viewer/Admin permissions.
  if os.environ.get('K_SERVICE'):
    _ENABLED_SERVICES.add(key)
    return True

  token = _get_adc_token()
  if not token:
    return False

  url = f'{_SERVICE_USAGE_URL}/projects/{project_id}/services/{service_name}'
  req = urllib_request.Request(
      url,
      headers={
          'Authorization': f'Bearer {token}',
          'Accept': 'application/json',
      },
  )
  try:
    with urllib_request.urlopen(req, timeout=10.0) as resp:
      data = json.loads(resp.read().decode('utf-8'))
      if data.get('state') == 'ENABLED':
        _ENABLED_SERVICES.add(key)
        return True
  except urllib_error.HTTPError as exc:
    # 401/403 means the caller lacks permission to query Service Usage API (e.g.
    # runtime service account with least-privilege roles like aiplatform.user).
    # Do not treat this as the service being disabled.
    if exc.code in (401, 403):
      logger.info(
          'Caller lacks permission to inspect Service Usage for %s (%s); '
          'assuming service is enabled.',
          service_name,
          exc.code,
      )
      _ENABLED_SERVICES.add(key)
      return True
    logger.debug('Service state check failed for %s: %s', service_name, exc)
    return False
  except (urllib_error.URLError, TimeoutError) as exc:
    logger.debug('Service state check failed for %s: %s', service_name, exc)
    return False
  return False


def _enable_via_gcloud(project_id: str, service_name: str) -> bool:
  """Attempts to enable a service using gcloud CLI if available."""
  gcloud_bin = shutil.which('gcloud')
  if not gcloud_bin:
    return False
  try:
    result = subprocess.run(
        [
            gcloud_bin,
            'services',
            'enable',
            service_name,
            f'--project={project_id}',
            '--quiet',
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    return result.returncode == 0
  except (subprocess.SubprocessError, OSError):
    return False


def enable_service(
    project_id: str,
    service_name: str,
    *,
    timeout_sec: float = 40.0,
) -> bool:
  """Enables a GCP service in the project and waits for completion.

  Args:
    project_id: The Google Cloud project ID.
    service_name: The GCP service name (e.g. 'aiplatform.googleapis.com').
    timeout_sec: Maximum seconds to wait for the enable operation.

  Returns:
    True if the service was successfully enabled, False otherwise.
  """
  key = (project_id, service_name)
  if key in _ENABLED_SERVICES:
    return True

  token = _get_adc_token()
  if token:
    url = (
        f'{_SERVICE_USAGE_URL}/projects/{project_id}/services/'
        f'{service_name}:enable'
    )
    req = urllib_request.Request(
        url,
        data=b'{}',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
    )
    try:
      with urllib_request.urlopen(req, timeout=15.0) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        op_name = data.get('name')
        if op_name and not data.get('done', False):
          op_url = f'{_SERVICE_USAGE_URL}/{op_name}'
          deadline = time.monotonic() + timeout_sec
          while time.monotonic() < deadline:
            time.sleep(2.0)
            op_req = urllib_request.Request(
                op_url,
                headers={
                    'Authorization': f'Bearer {token}',
                    'Accept': 'application/json',
                },
            )
            with urllib_request.urlopen(op_req, timeout=10.0) as op_resp:
              op_data = json.loads(op_resp.read().decode('utf-8'))
              if op_data.get('done', False):
                _ENABLED_SERVICES.add(key)
                return True
        else:
          _ENABLED_SERVICES.add(key)
          return True
    except (urllib_error.HTTPError, urllib_error.URLError, TimeoutError) as exc:
      logger.warning(
          'Service Usage enable failed for %s: %s', service_name, exc
      )

  # Fallback to gcloud if REST API call didn't succeed.
  if _enable_via_gcloud(project_id, service_name):
    _ENABLED_SERVICES.add(key)
    return True

  # Final verification.
  return is_service_enabled(project_id, service_name)


def ensure_service_enabled(
    project_id: str,
    service_name: str,
    *,
    display_name: str = '',
) -> tuple[bool, str]:
  """Ensures a service is enabled, automatically enabling it if needed.

  Args:
    project_id: The Google Cloud project ID.
    service_name: The GCP service name (e.g. 'aiplatform.googleapis.com').
    display_name: Optional human-readable service name for error messages.

  Returns:
    A tuple (is_enabled, error_message). On success, error_message is empty.
  """
  project = project_id.strip()
  service = service_name.strip()
  label = display_name or service
  if not project:
    return False, 'GCP 프로젝트 ID가 지정되지 않았습니다.'

  if is_service_enabled(project, service):
    return True, ''

  logger.info(
      'Service %s is not enabled in %s; enabling automatically...',
      service,
      project,
  )
  if enable_service(project, service):
    return True, ''

  console_url = (
      f'https://console.developers.google.com/apis/api/'
      f'{service}/overview?project={project}'
  )
  return (
      False,
      f'{label} API가 활성화되어 있지 않으며 자동 활성화에 실패했습니다. '
      f'다음 링크에서 직접 활성화한 후 다시 시도해 주세요: {console_url}',
  )


def ensure_vertex_api_enabled(settings: config.Settings) -> str:
  """Verifies or auto-enables the Vertex AI / Agent Platform API.

  Args:
    settings: Studio configuration settings.

  Returns:
    An error message if disabled and auto-enable failed; otherwise empty.
  """
  if settings.gemini_backend != 'vertex' or not settings.vertex_project:
    return ''
  ok, err = ensure_service_enabled(
      settings.vertex_project,
      VERTEX_API_SERVICE,
      display_name='Vertex AI (Agent Platform)',
  )
  return err if not ok else ''
