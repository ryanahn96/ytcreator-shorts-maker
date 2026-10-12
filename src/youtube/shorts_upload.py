"""Uploads a rendered Shorts MP4 to the creator's channel (videos.insert)."""

from __future__ import annotations

import datetime
import pathlib

import httpx

from src.core import models
from src.youtube import common

_YOUTUBE_UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos'
_YOUTUBE_THUMBNAIL_UPLOAD_API = (
    'https://www.googleapis.com/upload/youtube/v3/thumbnails/set'
)


def _normalize_publish_at(raw: str | None) -> str | None:
  """Validates and normalizes an ISO-8601 publishAt timestamp to UTC."""
  if not raw or not raw.strip():
    return None
  text = raw.strip()
  try:
    dt = datetime.datetime.fromisoformat(text.replace('Z', '+00:00'))
  except ValueError as exc:
    raise common.YouTubeError(
        '예약 발행 시각 형식이 올바르지 않습니다.'
    ) from exc
  if dt.tzinfo is None:
    dt = dt.replace(tzinfo=datetime.UTC)
  else:
    dt = dt.astimezone(datetime.UTC)
  now = datetime.datetime.now(datetime.UTC)
  if dt <= now + datetime.timedelta(minutes=1):
    raise common.YouTubeError('예약 발행 시각은 현재 시각 이후여야 합니다.')
  return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def _upload_thumbnail(
    client: httpx.Client,
    access_token: str,
    video_id: str,
    thumbnail_path: pathlib.Path,
    warnings: list[str],
) -> bool:
  """Uploads a custom JPEG thumbnail via thumbnails.set."""
  try:
    data = thumbnail_path.read_bytes()
    resp = client.post(
        _YOUTUBE_THUMBNAIL_UPLOAD_API,
        params={'videoId': video_id, 'uploadType': 'media'},
        headers={
            **common.auth_headers(access_token),
            'Content-Type': 'image/jpeg',
        },
        content=data,
    )
  except (OSError, httpx.HTTPError) as exc:
    warnings.append(f'썸네일 업로드 실패: {exc}')
    return False
  if resp.status_code not in (200, 201):
    warnings.append(
        common.api_error_message(resp, '썸네일을 등록하지 못했습니다')
    )
    return False
  return True


def _post_first_comment(
    client: httpx.Client,
    access_token: str,
    video_id: str,
    comment_text: str,
    warnings: list[str],
) -> bool:
  """Posts a top-level comment on the uploaded video via commentThreads."""
  try:
    resp = client.post(
        f'{common.YOUTUBE_API}/commentThreads',
        params={'part': 'snippet'},
        headers=common.auth_headers(access_token),
        json={
            'snippet': {
                'videoId': video_id,
                'topLevelComment': {
                    'snippet': {'textOriginal': comment_text},
                },
            }
        },
    )
  except httpx.HTTPError as exc:
    warnings.append(f'첫 댓글 등록 실패: {exc}')
    return False
  if resp.status_code not in (200, 201):
    warnings.append(
        common.api_error_message(resp, '첫 댓글을 등록하지 못했습니다')
    )
    return False
  return True


def upload_short(
    access_token: str,
    media_path: pathlib.Path,
    request: models.YouTubeUploadRequest,
    thumbnail_path: pathlib.Path | None = None,
    pre_warnings: list[str] | None = None,
) -> models.YouTubeUploadResult:
  """Uploads a rendered 9:16 MP4 to the signed-in creator's YouTube channel."""
  size = media_path.stat().st_size
  title = request.title.strip()
  description = request.description.strip()
  if '#shorts' not in title.lower() and '#shorts' not in description.lower():
    description = f'{description}\n\n#Shorts'.strip()

  publish_at = _normalize_publish_at(request.publish_at)
  privacy_status = 'private' if publish_at else request.privacy_status
  status_body: dict[str, object] = {
      'privacyStatus': privacy_status,
      'selfDeclaredMadeForKids': False,
  }
  if publish_at:
    status_body['publishAt'] = publish_at

  metadata = {
      'snippet': {
          'title': title[:100],
          'description': description,
          'categoryId': '22',
      },
      'status': status_body,
  }

  warnings: list[str] = list(pre_warnings or [])
  thumbnail_set = False
  comment_posted = False

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
    video_id = str(common.as_dict(put_resp.json()).get('id') or '').strip()
    if not video_id:
      raise common.YouTubeError('YouTube 업로드 응답에 영상 ID가 없습니다.')

    if thumbnail_path is not None and thumbnail_path.is_file():
      thumbnail_set = _upload_thumbnail(
          client, access_token, video_id, thumbnail_path, warnings
      )

    first_comment = request.first_comment.strip()
    if first_comment:
      comment_posted = _post_first_comment(
          client, access_token, video_id, first_comment, warnings
      )

  return models.YouTubeUploadResult(
      watch_url=f'https://www.youtube.com/shorts/{video_id}',
      studio_url=f'https://studio.youtube.com/video/{video_id}/edit',
      comment_posted=comment_posted,
      thumbnail_set=thumbnail_set,
      warnings=warnings,
  )

