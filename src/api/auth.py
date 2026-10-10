"""Creator sign-in with Google OAuth 2.0: login, callback and logout."""

from __future__ import annotations

import contextlib
import secrets
from urllib import parse as urllib_parse

import fastapi
from fastapi import responses

from src.api import deps
from src.infra import storage
from src.youtube import common as youtube_common
from src.youtube import oauth

router = fastapi.APIRouter(prefix='/api/shortform/auth', tags=['auth'])


_SESSION_MAX_AGE_SEC = int(deps.settings.retention_hours * 3600)


def _proto(request: fastapi.Request) -> str:
  proto = request.headers.get('x-forwarded-proto') or request.url.scheme
  return proto.split(',')[0].strip()


def _oauth_redirect_uri(request: fastapi.Request) -> str:
  host = (
      request.headers.get('x-forwarded-host')
      or request.headers.get('host')
      or request.url.netloc
  ).split(',')[0].strip()
  return f'{_proto(request)}://{host}/api/shortform/auth/callback'


@router.get('/login', response_model=None)
def auth_login(request: fastapi.Request) -> fastapi.Response:
  """Redirects the creator to Google's OAuth 2.0 consent screen."""
  state = secrets.token_urlsafe(24)
  redirect_uri = _oauth_redirect_uri(request)
  try:
    url = oauth.authorization_url(deps.settings, redirect_uri, state)
  except youtube_common.YouTubeError as exc:
    return deps.error(str(exc), 500)
  response = responses.RedirectResponse(url, status_code=302)
  response.set_cookie(
      key=oauth.STATE_COOKIE,
      value=state,
      max_age=600,
      httponly=True,
      samesite='lax',
      secure=_proto(request).lower() == 'https',
      path='/',
  )
  return response


@router.get('/callback', response_model=None)
def auth_callback(
    request: fastapi.Request,
    code: str = '',
    state: str = '',
    error: str = '',
) -> fastapi.Response:
  """Handles the OAuth 2.0 callback, persists the session and redirects home."""
  if error:
    msg = urllib_parse.quote(f'Google 로그인이 취소되었거나 실패했습니다: {error}')
    return responses.RedirectResponse(f'/?auth_error={msg}', status_code=302)
  cookie_state = request.cookies.get(oauth.STATE_COOKIE, '').strip()
  if not code or not state or not cookie_state or state != cookie_state:
    msg = urllib_parse.quote(
        'OAuth 상태 검증에 실패했습니다. 다시 로그인해 주세요.'
    )
    return responses.RedirectResponse(f'/?auth_error={msg}', status_code=302)
  session_id = deps.workspace.new_session_id()
  redirect_uri = _oauth_redirect_uri(request)
  try:
    session = oauth.exchange_code(deps.settings, code, redirect_uri, session_id)
    deps.workspace.save_session(session)
  except (youtube_common.YouTubeError, storage.StorageError) as exc:
    msg = urllib_parse.quote(str(exc))
    return responses.RedirectResponse(f'/?auth_error={msg}', status_code=302)

  response = responses.RedirectResponse('/', status_code=302)
  response.delete_cookie(key=oauth.STATE_COOKIE, path='/')
  response.set_cookie(
      key=oauth.SESSION_COOKIE,
      value=session.session_id,
      max_age=_SESSION_MAX_AGE_SEC,
      httponly=True,
      samesite='lax',
      secure=_proto(request).lower() == 'https',
      path='/',
  )
  return response


@router.post('/logout')
def auth_logout(request: fastapi.Request) -> responses.JSONResponse:
  """Clears the creator's OAuth session cookie and stored token."""
  session_id = request.cookies.get(oauth.SESSION_COOKIE, '').strip()
  with contextlib.suppress(storage.StorageError):
    deps.workspace.discard_session(session_id)
  response = responses.JSONResponse(
      oauth.auth_status(deps.settings, None).to_json()
  )
  response.delete_cookie(key=oauth.SESSION_COOKIE, path='/')
  return response
