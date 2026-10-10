"""What the routers share: settings, the Workspace, errors, the session."""

from __future__ import annotations

import fastapi
from fastapi import responses
from starlette import exceptions as starlette_exceptions

from src.core import config
from src.core import models
from src.infra import storage
from src.youtube import common as youtube_common
from src.youtube import oauth

settings = config.get_settings()
workspace = storage.Workspace(
    settings.workdir, settings.retention_hours, settings.gcs_bucket
)


def error(message: str, status_code: int) -> responses.JSONResponse:
  return responses.JSONResponse({'error': message}, status_code=status_code)


def current_session(request: fastapi.Request) -> models.OAuthSession | None:
  """Loads and refreshes the signed-in OAuth session from the cookie."""
  session_id = request.cookies.get(oauth.SESSION_COOKIE, '').strip()
  try:
    session = workspace.load_session(session_id)
    if session is None:
      return None
    return oauth.ensure_fresh_session(settings, workspace, session)
  except (youtube_common.YouTubeError, storage.StorageError):
    return None


def require_session(request: fastapi.Request) -> models.OAuthSession:
  """Returns the signed-in creator session or raises HTTP 401."""
  session = current_session(request)
  if session is None:
    raise starlette_exceptions.HTTPException(
        status_code=401,
        detail='YouTube 크리에이터 계정으로 로그인이 필요합니다.',
    )
  return session
