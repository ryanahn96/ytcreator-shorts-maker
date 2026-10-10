"""Google OAuth 2.0 sign-in of creators: consent URL, tokens, sessions."""

from __future__ import annotations

import time
from urllib import parse as urllib_parse

import httpx

from src.core import config
from src.core import models
from src.infra import storage
from src.youtube import common

SESSION_COOKIE = 'ytcreator_session'
STATE_COOKIE = 'ytcreator_oauth_state'

OAUTH_SCOPES = (
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
)

_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'
_REFRESH_MARGIN_SEC = 60.0


def auth_status(
    settings: config.Settings, session: models.OAuthSession | None
) -> models.AuthStatus:
  """Builds the AuthStatus reported in StudioConfig and /auth/session."""
  configured = not settings.oauth_setup_error
  return models.AuthStatus(
      authenticated=session is not None,
      oauth_configured=configured,
      oauth_setup_error=settings.oauth_setup_error,
      user=session.user if session is not None else None,
  )


def authorization_url(
    settings: config.Settings, redirect_uri: str, state: str
) -> str:
  """Builds the Google OAuth 2.0 consent URL for YouTube creator sign-in."""
  if settings.oauth_setup_error:
    raise common.YouTubeError(settings.oauth_setup_error)
  params = {
      'client_id': settings.oauth_client_id,
      'redirect_uri': redirect_uri,
      'response_type': 'code',
      'scope': ' '.join(OAUTH_SCOPES),
      'access_type': 'offline',
      'prompt': 'consent',
      'include_granted_scopes': 'true',
      'state': state,
  }
  return f'{_AUTH_ENDPOINT}?{urllib_parse.urlencode(params)}'


def _fetch_creator_profile(
    client: httpx.Client, access_token: str
) -> models.CreatorProfile:
  """Fetches the signed-in user's Google info and YouTube channel metadata."""
  headers = common.auth_headers(access_token)
  info_resp = client.get(_USERINFO_ENDPOINT, headers=headers)
  info = (
      common.as_dict(info_resp.json()) if info_resp.status_code == 200 else {}
  )
  ch_resp = client.get(
      f'{common.YOUTUBE_API}/channels',
      params={'part': 'snippet', 'mine': 'true'},
      headers=headers,
  )
  ch_data = common.as_dict(ch_resp.json()) if ch_resp.status_code == 200 else {}
  items = ch_data.get('items')
  first = items[0] if isinstance(items, list) and items else None
  snippet = common.as_dict(common.as_dict(first).get('snippet'))
  channel_thumb = common.thumbnail_url(
      snippet.get('thumbnails'), ('default', 'medium', 'high')
  )
  email = str(info.get('email') or '').strip()
  channel_title = str(snippet.get('title') or '').strip()
  return models.CreatorProfile(
      email=email,
      name=str(info.get('name') or '').strip() or channel_title or email,
      picture_url=channel_thumb or str(info.get('picture') or '').strip(),
      channel_title=channel_title,
      channel_handle=str(snippet.get('customUrl') or '').strip(),
  )


def exchange_code(
    settings: config.Settings,
    code: str,
    redirect_uri: str,
    session_id: str,
) -> models.OAuthSession:
  """Exchanges an OAuth 2.0 authorization code for a session."""
  if settings.oauth_setup_error:
    raise common.YouTubeError(settings.oauth_setup_error)
  with common.http_client() as client:
    try:
      response = client.post(
          _TOKEN_ENDPOINT,
          data={
              'code': code,
              'client_id': settings.oauth_client_id,
              'client_secret': settings.oauth_client_secret,
              'redirect_uri': redirect_uri,
              'grant_type': 'authorization_code',
          },
      )
    except httpx.HTTPError as exc:
      raise common.YouTubeError(f'Google OAuth 토큰 요청 실패: {exc}') from exc
    if response.status_code != 200:
      raise common.YouTubeError(
          common.api_error_message(response, 'Google OAuth 토큰 교환에 실패했습니다')
      )
    token_data = response.json()
    access_token = str(token_data.get('access_token') or '').strip()
    if not access_token:
      raise common.YouTubeError('Google OAuth 응답에 access_token이 없습니다.')
    refresh_token = str(token_data.get('refresh_token') or '').strip()
    expires_in = float(token_data.get('expires_in') or 3600.0)
    profile = _fetch_creator_profile(client, access_token)
  return models.OAuthSession(
      session_id=session_id,
      access_token=access_token,
      refresh_token=refresh_token,
      expires_at_epoch=time.time() + expires_in,
      user=profile,
  )


def ensure_fresh_session(
    settings: config.Settings,
    workspace: storage.Workspace,
    session: models.OAuthSession,
) -> models.OAuthSession:
  """Returns session with a valid access_token, refreshing it when needed."""
  if session.expires_at_epoch - _REFRESH_MARGIN_SEC > time.time():
    return session
  if not session.refresh_token or settings.oauth_setup_error:
    return session
  with common.http_client() as client:
    try:
      response = client.post(
          _TOKEN_ENDPOINT,
          data={
              'client_id': settings.oauth_client_id,
              'client_secret': settings.oauth_client_secret,
              'refresh_token': session.refresh_token,
              'grant_type': 'refresh_token',
          },
      )
    except httpx.HTTPError as exc:
      raise common.YouTubeError(
          f'OAuth 토큰 갱신에 실패했습니다. 다시 로그인하세요: {exc}'
      ) from exc
  if response.status_code != 200:
    raise common.YouTubeError(
        common.api_error_message(
            response, 'OAuth 세션이 만료되었습니다. 다시 로그인하세요'
        )
    )
  data = response.json()
  access_token = str(data.get('access_token') or '').strip()
  if not access_token:
    raise common.YouTubeError('갱신된 access_token이 없습니다. 다시 로그인하세요.')
  expires_in = float(data.get('expires_in') or 3600.0)
  refreshed = models.OAuthSession(
      session_id=session.session_id,
      access_token=access_token,
      refresh_token=str(data.get('refresh_token') or session.refresh_token),
      expires_at_epoch=time.time() + expires_in,
      user=session.user,
  )
  workspace.save_session(refreshed)
  return refreshed
