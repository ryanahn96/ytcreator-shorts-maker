"""OAuth 2.0 helpers shared by the YouTube API samples.

세 가지 API(Data, Analytics, Reporting)를 하나의 토큰으로 사용하기 위해
필요한 스코프를 한 번에 요청하고 `token.json`에 캐시한다.
"""

from __future__ import annotations

import os
from typing import Sequence

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import Resource
from googleapiclient.discovery import build

# Data API 읽기 + Analytics/Reporting 읽기 스코프.
SCOPES: tuple[str, ...] = (
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
    'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
)

_CLIENT_SECRETS_FILE = os.environ.get(
    'YT_CLIENT_SECRETS', 'client_secret.json'
)
_TOKEN_FILE = os.environ.get('YT_TOKEN_FILE', 'token.json')


def get_credentials(
    scopes: Sequence[str] = SCOPES,
) -> Credentials:
  """사용자 OAuth 자격증명을 반환한다.

  캐시된 토큰이 있으면 재사용하고, 만료된 경우 갱신하며, 없으면 로컬
  브라우저를 띄워 동의 절차를 진행한다.

  Args:
    scopes: 요청할 OAuth 스코프 목록.

  Returns:
    유효한 `Credentials` 객체.

  Raises:
    FileNotFoundError: 클라이언트 시크릿 파일이 없을 때.
  """
  creds: Credentials | None = None
  if os.path.exists(_TOKEN_FILE):
    creds = Credentials.from_authorized_user_file(_TOKEN_FILE, list(scopes))

  if creds and creds.valid:
    return creds

  if creds and creds.expired and creds.refresh_token:
    creds.refresh(Request())
  else:
    if not os.path.exists(_CLIENT_SECRETS_FILE):
      raise FileNotFoundError(
          f'클라이언트 시크릿 파일을 찾을 수 없습니다: {_CLIENT_SECRETS_FILE}'
      )
    flow = InstalledAppFlow.from_client_secrets_file(
        _CLIENT_SECRETS_FILE, list(scopes)
    )
    # port=0 이면 빈 포트를 자동 할당한다. 원격(cloudtop) 환경에서는
    # 콘솔에 출력되는 URL을 로컬 브라우저에 붙여넣어 진행한다.
    creds = flow.run_local_server(port=0, open_browser=False)

  with open(_TOKEN_FILE, 'w', encoding='utf-8') as token:
    token.write(creds.to_json())
  return creds


def build_service(api: str, version: str) -> Resource:
  """인증된 Google API 클라이언트를 생성한다.

  Args:
    api: API 이름 (예: 'youtube', 'youtubeAnalytics', 'youtubereporting').
    version: API 버전 (예: 'v3', 'v2', 'v1').

  Returns:
    호출 가능한 `Resource` 객체.
  """
  return build(api, version, credentials=get_credentials(), cache_discovery=False)
