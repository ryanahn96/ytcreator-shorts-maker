"""Gemini connection for the configured backend.

The studio calls Gemini either with a Gemini API key (Google AI Studio) or
through Vertex AI with Application Default Credentials (ADC).
config.Settings.gemini_backend picks one from the environment; this module
turns that choice into a client, a display label and a credential check.
"""

from __future__ import annotations

from google import auth as google_auth
from google import genai
from google.auth import exceptions as google_auth_exceptions
from google.auth.transport import requests as google_auth_requests
from google.genai import types

from yt.studio import config
from yt.studio import gcp
from yt.studio import models

_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
_LABELS: dict[models.GeminiBackend, str] = {
    'ai_studio': 'Gemini API',
    'vertex': 'Vertex AI',
}
_VERTEX_LOGIN_HINT = (
    '터미널에서 `gcloud auth application-default login`을 실행한 뒤 페이지를 '
    '새로고침하고 다시 시도하세요.'
)


def label(settings: config.Settings) -> str:
  """Returns the backend name used in error messages."""
  return _LABELS[settings.gemini_backend]


def make_client(settings: config.Settings) -> genai.Client:
  """Creates the Gemini client for the configured backend.

  Vertex AI loads ADC on the first request, so credential problems surface as
  google.auth exceptions from the call itself. Explicit project and location
  make the SDK ignore any API key in the environment.
  """
  http_options = types.HttpOptions(
      timeout=int(settings.gemini_timeout_sec * 1000)
  )
  if settings.gemini_backend == 'vertex':
    gcp.ensure_vertex_api_enabled(settings)
    return genai.Client(
        vertexai=True,
        project=settings.vertex_project,
        location=settings.vertex_location,
        http_options=http_options,
    )
  return genai.Client(
      vertexai=False,
      api_key=settings.gemini_api_key,
      http_options=http_options,
  )


def auth_failure_message(
    settings: config.Settings, exc: google_auth_exceptions.GoogleAuthError
) -> str:
  """Explains a credential failure and how to log in again."""
  detail = str(exc).rstrip('.')
  return f'{label(settings)} 인증에 실패했습니다: {detail}. {_VERTEX_LOGIN_HINT}'


def credentials_error(settings: config.Settings) -> str:
  """Checks that ADC can mint a Vertex AI access token.

  Makes a blocking token request, so keep it off the event loop.

  Returns:
    A user-facing message when credentials are missing or need a new login;
    otherwise an empty string. The Gemini API backend and network failures
    return an empty string too (an analysis reports the latter itself).
  """
  if settings.gemini_backend != 'vertex':
    return ''
  try:
    credentials, _ = google_auth.default(scopes=[_CLOUD_PLATFORM_SCOPE])
    credentials.refresh(google_auth_requests.Request())
  except google_auth_exceptions.TransportError:
    return ''
  except google_auth_exceptions.GoogleAuthError as exc:
    return auth_failure_message(settings, exc)
  # Verify and auto-enable Vertex AI API if disabled.
  return gcp.ensure_vertex_api_enabled(settings)
