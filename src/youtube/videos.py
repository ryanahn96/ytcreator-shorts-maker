"""The creator's long-form channel videos (YouTube Data API v3)."""

from __future__ import annotations

from collections.abc import Sequence

import httpx

from src.core import models
from src.youtube import common

def parse_iso_duration(raw: str) -> float:
  """Parses a YouTube ISO-8601 duration (e.g. 'PT14M23S') into seconds."""
  text = raw.strip().upper()
  if not text.startswith('PT'):
    return 0.0
  text = text[2:]
  hours = 0.0
  minutes = 0.0
  seconds = 0.0
  buf = ''
  for char in text:
    if char.isdigit() or char == '.':
      buf += char
      continue
    if not buf:
      continue
    val = float(buf)
    buf = ''
    if char == 'H':
      hours = val
    elif char == 'M':
      minutes = val
    elif char == 'S':
      seconds = val
  return hours * 3600.0 + minutes * 60.0 + seconds


def _has_shorts_tag(title: str, description: str, tags: Sequence[str]) -> bool:
  """Returns True when title, description, or tags contain #shorts/#쇼츠."""
  haystack = f'{title}\n{description}'.lower()
  if '#shorts' in haystack or '#쇼츠' in haystack:
    return True
  return any(
      str(tag).strip().lower().lstrip('#') in ('shorts', '쇼츠') for tag in tags
  )


def _pick_thumbnail_url(thumbs: dict[str, object]) -> str:
  """Picks the highest-resolution 16:9 thumbnail URL available."""
  for key in ('maxres', 'standard', 'high', 'medium', 'default'):
    entry = thumbs.get(key)
    if isinstance(entry, dict) and entry.get('url'):
      return str(entry['url']).strip()
  return ''


def video_item(
    raw: dict[str, object], untitled: str | None = None
) -> models.YouTubeVideoItem:
  """Parses one videos.list item (snippet, contentDetails, statistics, status).

  Args:
    raw: The item from the videos.list response.
    untitled: The title of a video whose snippet has none; None uses the
      video id.

  Returns:
    The video; fields whose part is missing or malformed keep their defaults.
  """
  vid = str(raw.get('id') or '').strip()
  snippet = common.as_dict(raw.get('snippet'))
  content = common.as_dict(raw.get('contentDetails'))
  stats = common.as_dict(raw.get('statistics'))
  status = common.as_dict(raw.get('status'))
  fallback_title = vid if untitled is None else untitled
  thumbs = snippet.get('thumbnails')
  return models.YouTubeVideoItem(
      video_id=vid,
      title=str(snippet.get('title') or fallback_title).strip(),
      description=str(snippet.get('description') or '').strip(),
      thumbnail_url=(
          _pick_thumbnail_url(thumbs) if isinstance(thumbs, dict) else ''
      ),
      published_at=str(snippet.get('publishedAt') or '').strip(),
      duration_sec=parse_iso_duration(str(content.get('duration') or '')),
      view_count=common.int_stat(stats, 'viewCount'),
      like_count=common.int_stat(stats, 'likeCount'),
      comment_count=common.int_stat(stats, 'commentCount'),
      privacy_status=str(status.get('privacyStatus') or 'public').strip(),
      has_captions=str(content.get('caption') or '').lower() == 'true',
  )


def list_channel_videos(access_token: str) -> models.YouTubeVideoList:
  """Lists uploaded long-form videos (without #shorts) sorted by upload date."""
  headers = common.auth_headers(access_token)
  with common.http_client() as client:
    try:
      ch_resp = client.get(
          f'{common.YOUTUBE_API}/channels',
          params={'part': 'contentDetails', 'mine': 'true'},
          headers=headers,
      )
    except httpx.HTTPError as exc:
      raise common.YouTubeError(f'YouTube 채널 조회 실패: {exc}') from exc
    if ch_resp.status_code != 200:
      raise common.YouTubeError(
          common.api_error_message(ch_resp, 'YouTube 채널 정보를 불러오지 못했습니다')
      )
    ch_data = ch_resp.json()
    items = ch_data.get('items') if isinstance(ch_data, dict) else None
    if not isinstance(items, list) or not items:
      return models.YouTubeVideoList()
    channel = items[0] if isinstance(items[0], dict) else {}
    uploads_id = str(
        ((channel.get('contentDetails') or {}).get('relatedPlaylists') or {})
        .get('uploads')
        or ''
    ).strip()
    if not uploads_id:
      return models.YouTubeVideoList()

    video_ids: list[str] = []
    page_token = ''
    for _ in range(2):
      pl_params: dict[str, str | int] = {
          'part': 'contentDetails',
          'playlistId': uploads_id,
          'maxResults': 50,
      }
      if page_token:
        pl_params['pageToken'] = page_token
      try:
        pl_resp = client.get(
            f'{common.YOUTUBE_API}/playlistItems',
            params=pl_params,
            headers=headers,
        )
      except httpx.HTTPError as exc:
        raise common.YouTubeError(f'업로드 영상 목록 조회 실패: {exc}') from exc
      if pl_resp.status_code != 200:
        raise common.YouTubeError(
            common.api_error_message(
                pl_resp, '업로드 영상 목록을 불러오지 못했습니다'
            )
        )
      pl_body = pl_resp.json() or {}
      pl_items = pl_body.get('items') or []
      for item in pl_items:
        if isinstance(item, dict):
          vid = str(
              (item.get('contentDetails') or {}).get('videoId') or ''
          ).strip()
          if vid and vid not in video_ids:
            video_ids.append(vid)
      page_token = str(pl_body.get('nextPageToken') or '').strip()
      if not page_token:
        break

    if not video_ids:
      return models.YouTubeVideoList()

    videos: list[models.YouTubeVideoItem] = []
    for offset in range(0, len(video_ids), 50):
      batch_ids = video_ids[offset : offset + 50]
      try:
        v_resp = client.get(
            f'{common.YOUTUBE_API}/videos',
            params={
                'part': 'snippet,contentDetails,statistics,status',
                'id': ','.join(batch_ids),
            },
            headers=headers,
        )
      except httpx.HTTPError as exc:
        raise common.YouTubeError(f'영상 상세 정보 조회 실패: {exc}') from exc
      if v_resp.status_code != 200:
        raise common.YouTubeError(
            common.api_error_message(
                v_resp, '영상 상세 정보를 불러오지 못했습니다'
            )
        )
      for raw in (v_resp.json() or {}).get('items') or []:
        if not isinstance(raw, dict):
          continue
        video = video_item(raw)
        raw_tags = common.as_dict(raw.get('snippet')).get('tags')
        tags = raw_tags if isinstance(raw_tags, list) else []
        if not _has_shorts_tag(video.title, video.description, tags):
          videos.append(video)
    videos.sort(key=lambda item: item.published_at, reverse=True)
  return models.YouTubeVideoList(videos=videos[:40])
