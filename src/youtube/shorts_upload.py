"""Uploads a rendered Shorts MP4 to the creator's channel (videos.insert)."""

from __future__ import annotations

import pathlib

import httpx

from src.core import models
from src.youtube import common

_YOUTUBE_UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos'


def upload_short(
    access_token: str,
    media_path: pathlib.Path,
    request: models.YouTubeUploadRequest,
) -> models.YouTubeUploadResult:
  """Uploads a rendered 9:16 MP4 to the signed-in creator's YouTube channel."""
  size = media_path.stat().st_size
  title = request.title.strip()
  description = request.description.strip()
  if '#shorts' not in title.lower() and '#shorts' not in description.lower():
    description = f'{description}\n\n#Shorts'.strip()

  metadata = {
      'snippet': {
          'title': title[:100],
          'description': description,
          'categoryId': '22',
      },
      'status': {
          'privacyStatus': request.privacy_status,
          'selfDeclaredMadeForKids': False,
      },
  }

  with common.http_client(timeout_sec=600.0) as client:
    try:
      init_resp = client.post(
          _YOUTUBE_UPLOAD_API,
          params={'uploadType': 'resumable', 'part': 'snippet,status'},
          headers={
              **common.auth_headers(access_token),
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Length': str(size),
              'X-Upload-Content-Type': 'video/mp4',
          },
          json=metadata,
      )
    except httpx.HTTPError as exc:
      raise common.YouTubeError(f'YouTube 업로드 세션 시작 실패: {exc}') from exc
    if init_resp.status_code not in (200, 201):
      raise common.YouTubeError(
          common.api_error_message(
              init_resp, 'YouTube 업로드를 시작하지 못했습니다'
          )
      )
    upload_url = init_resp.headers.get('Location', '').strip()
    if not upload_url:
      raise common.YouTubeError('YouTube 업로드 URL(Location)을 받지 못했습니다.')

    try:
      with media_path.open('rb') as handle:
        put_resp = client.put(
            upload_url,
            headers={'Content-Type': 'video/mp4'},
            content=handle,
        )
    except httpx.HTTPError as exc:
      raise common.YouTubeError(f'YouTube 영상 전송 실패: {exc}') from exc
    if put_resp.status_code not in (200, 201):
      raise common.YouTubeError(
          common.api_error_message(put_resp, 'YouTube 영상 업로드에 실패했습니다')
      )
    body = put_resp.json()
    video_id = (
        str(body.get('id') or '').strip() if isinstance(body, dict) else ''
    )
    if not video_id:
      raise common.YouTubeError('YouTube 업로드 응답에 영상 ID가 없습니다.')

  return models.YouTubeUploadResult(
      watch_url=f'https://www.youtube.com/shorts/{video_id}',
      studio_url=f'https://studio.youtube.com/video/{video_id}/edit',
  )
