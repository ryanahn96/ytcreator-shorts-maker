"""Google OAuth 2.0, YouTube Data API v3 and YouTube Analytics API v2 client.

Creators sign in with their Google / YouTube account so the studio can:
  * show their YouTube channel profile in the header;
  * list their channel's uploaded videos and link one to a Source Video;
  * fetch Audience Retention curves (elapsedVideoTimeRatio ->
    audienceWatchRatio, relativeRetentionPerformance) and official captions
    for the linked video so Gemini prioritizes the moments viewers actually
    watched;
  * upload a rendered 9:16 Shorts MP4 directly to the creator's channel.
"""

from __future__ import annotations

from collections.abc import Sequence
import datetime
import pathlib
import re
import time
from urllib import parse as urllib_parse

import httpx

from src.core import config
from src.core import models
from src.infra import storage
from src.media import ingestion

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
_YOUTUBE_API = 'https://www.googleapis.com/youtube/v3'
_YOUTUBE_UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos'
_ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports'
_REFRESH_MARGIN_SEC = 60.0
_MAX_PEAKS = 4


class YouTubeError(RuntimeError):
  """Raised when an OAuth or YouTube API request fails."""


def _http_client(timeout_sec: float = 60.0) -> httpx.Client:
  return httpx.Client(timeout=httpx.Timeout(timeout_sec, connect=15.0))


def _auth_headers(access_token: str) -> dict[str, str]:
  return {'Authorization': f'Bearer {access_token}'}


def _api_error_message(response: httpx.Response, prefix: str) -> str:
  try:
    payload = response.json()
  except ValueError:
    payload = None
  if isinstance(payload, dict):
    err = payload.get('error')
    if isinstance(err, dict) and isinstance(err.get('message'), str):
      return f'{prefix}: {err["message"]} (HTTP {response.status_code})'
    if isinstance(err, str):
      desc = payload.get('error_description')
      detail = f'{err} ({desc})' if isinstance(desc, str) else err
      return f'{prefix}: {detail} (HTTP {response.status_code})'
  return f'{prefix} (HTTP {response.status_code})'


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
    raise YouTubeError(settings.oauth_setup_error)
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
  headers = _auth_headers(access_token)
  info_resp = client.get(_USERINFO_ENDPOINT, headers=headers)
  info = _as_dict(info_resp.json()) if info_resp.status_code == 200 else {}
  ch_resp = client.get(
      f'{_YOUTUBE_API}/channels',
      params={'part': 'snippet', 'mine': 'true'},
      headers=headers,
  )
  ch_data = _as_dict(ch_resp.json()) if ch_resp.status_code == 200 else {}
  items = ch_data.get('items')
  first = items[0] if isinstance(items, list) and items else None
  snippet = _as_dict(_as_dict(first).get('snippet'))
  thumbs = _as_dict(snippet.get('thumbnails'))
  channel_thumb = ''
  for key in ('default', 'medium', 'high'):
    entry = thumbs.get(key)
    if isinstance(entry, dict) and entry.get('url'):
      channel_thumb = str(entry['url']).strip()
      break
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
    raise YouTubeError(settings.oauth_setup_error)
  with _http_client() as client:
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
      raise YouTubeError(f'Google OAuth 토큰 요청 실패: {exc}') from exc
    if response.status_code != 200:
      raise YouTubeError(
          _api_error_message(response, 'Google OAuth 토큰 교환에 실패했습니다')
      )
    token_data = response.json()
    access_token = str(token_data.get('access_token') or '').strip()
    if not access_token:
      raise YouTubeError('Google OAuth 응답에 access_token이 없습니다.')
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
  with _http_client() as client:
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
      raise YouTubeError(
          f'OAuth 토큰 갱신에 실패했습니다. 다시 로그인하세요: {exc}'
      ) from exc
  if response.status_code != 200:
    raise YouTubeError(
        _api_error_message(
            response, 'OAuth 세션이 만료되었습니다. 다시 로그인하세요'
        )
    )
  data = response.json()
  access_token = str(data.get('access_token') or '').strip()
  if not access_token:
    raise YouTubeError('갱신된 access_token이 없습니다. 다시 로그인하세요.')
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


# --------------------------------------------------------------------------
# ISO-8601 duration & SRT/VTT caption parsing
# --------------------------------------------------------------------------


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


def _parse_clock_timestamp(raw: str) -> float | None:
  """Parses '00:01:23,450' or '00:01:23.450' or '01:23.450' into seconds."""
  token = raw.strip().replace(',', '.')
  parts = token.split(':')
  try:
    nums = [float(part) for part in parts]
  except ValueError:
    return None
  if len(nums) == 3:
    return nums[0] * 3600.0 + nums[1] * 60.0 + nums[2]
  if len(nums) == 2:
    return nums[0] * 60.0 + nums[1]
  return None


def parse_srt_captions(text: str) -> ingestion.Transcript:
  """Parses SRT or WebVTT caption text into timed Transcript Words."""
  blocks = text.replace('\r\n', '\n').replace('\r', '\n').split('\n\n')
  lines: list[ingestion.CaptionLine] = []
  for block in blocks:
    rows = [row.strip() for row in block.splitlines() if row.strip()]
    arrow_idx = next(
        (idx for idx, row in enumerate(rows) if '-->' in row), -1
    )
    if arrow_idx < 0:
      continue
    timing = rows[arrow_idx]
    left, _, right = timing.partition('-->')
    start = _parse_clock_timestamp(left.split()[0] if left.split() else '')
    end = _parse_clock_timestamp(right.split()[0] if right.split() else '')
    if start is None or end is None or end <= start:
      continue
    body = ' '.join(rows[arrow_idx + 1 :]).strip()
    if body:
      lines.append(ingestion.CaptionLine(start=start, end=end, text=body))
  return ingestion.transcript_from_lines(lines)


# --------------------------------------------------------------------------
# Channel video list
# --------------------------------------------------------------------------

_COMMENT_TIME_RE = re.compile(r'(?<!\d)(\d{1,2}:\d{2}(?::\d{2})?)(?!\d)')


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


def _int_stat(stats: dict[str, object], key: str) -> int:
  try:
    return int(stats.get(key) or 0)
  except (TypeError, ValueError):
    return 0


def _as_dict(value: object) -> dict[str, object]:
  return value if isinstance(value, dict) else {}


def _video_item(
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
  snippet = _as_dict(raw.get('snippet'))
  content = _as_dict(raw.get('contentDetails'))
  stats = _as_dict(raw.get('statistics'))
  status = _as_dict(raw.get('status'))
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
      view_count=_int_stat(stats, 'viewCount'),
      like_count=_int_stat(stats, 'likeCount'),
      comment_count=_int_stat(stats, 'commentCount'),
      privacy_status=str(status.get('privacyStatus') or 'public').strip(),
      has_captions=str(content.get('caption') or '').lower() == 'true',
  )


def list_channel_videos(access_token: str) -> models.YouTubeVideoList:
  """Lists uploaded long-form videos (without #shorts) sorted by upload date."""
  headers = _auth_headers(access_token)
  with _http_client() as client:
    try:
      ch_resp = client.get(
          f'{_YOUTUBE_API}/channels',
          params={'part': 'contentDetails', 'mine': 'true'},
          headers=headers,
      )
    except httpx.HTTPError as exc:
      raise YouTubeError(f'YouTube 채널 조회 실패: {exc}') from exc
    if ch_resp.status_code != 200:
      raise YouTubeError(
          _api_error_message(ch_resp, 'YouTube 채널 정보를 불러오지 못했습니다')
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
            f'{_YOUTUBE_API}/playlistItems',
            params=pl_params,
            headers=headers,
        )
      except httpx.HTTPError as exc:
        raise YouTubeError(f'업로드 영상 목록 조회 실패: {exc}') from exc
      if pl_resp.status_code != 200:
        raise YouTubeError(
            _api_error_message(
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
            f'{_YOUTUBE_API}/videos',
            params={
                'part': 'snippet,contentDetails,statistics,status',
                'id': ','.join(batch_ids),
            },
            headers=headers,
        )
      except httpx.HTTPError as exc:
        raise YouTubeError(f'영상 상세 정보 조회 실패: {exc}') from exc
      if v_resp.status_code != 200:
        raise YouTubeError(
            _api_error_message(
                v_resp, '영상 상세 정보를 불러오지 못했습니다'
            )
        )
      for raw in (v_resp.json() or {}).get('items') or []:
        if not isinstance(raw, dict):
          continue
        video = _video_item(raw)
        raw_tags = _as_dict(raw.get('snippet')).get('tags')
        tags = raw_tags if isinstance(raw_tags, list) else []
        if not _has_shorts_tag(video.title, video.description, tags):
          videos.append(video)
    videos.sort(key=lambda item: item.published_at, reverse=True)
  return models.YouTubeVideoList(videos=videos[:40])


# --------------------------------------------------------------------------
# Audience Retention & Hotspots (YouTube Analytics API v2)
# --------------------------------------------------------------------------


def _top_spans(
    ordered: Sequence[models.YouTubeRetentionPoint],
    scored: list[tuple[float, int, str]],
    duration_sec: float,
) -> list[models.YouTubeRetentionPeak]:
  """Turns the best-scored retention points into spans in seconds.

  Args:
    ordered: Audience Retention points sorted by elapsed_ratio.
    scored: (score, index into ordered, label) of every candidate point.
    duration_sec: Total video duration in seconds.

  Returns:
    Up to _MAX_PEAKS non-overlapping spans around the highest scores,
    ordered by timestamp.
  """
  chosen: list[tuple[int, str]] = []
  min_index_gap = max(3, len(ordered) // 8)
  for _, idx, label in sorted(scored, reverse=True):
    if all(abs(idx - prev) >= min_index_gap for prev, _ in chosen):
      chosen.append((idx, label))
      if len(chosen) >= _MAX_PEAKS:
        break

  spans: list[models.YouTubeRetentionPeak] = []
  half_window_sec = min(20.0, max(8.0, duration_sec * 0.025))
  for idx, label in sorted(chosen):
    point = ordered[idx]
    center_sec = point.elapsed_ratio * duration_sec
    start_sec = round(max(0.0, center_sec - half_window_sec), 1)
    end_sec = round(min(duration_sec, center_sec + half_window_sec), 1)
    if end_sec <= start_sec:
      continue
    spans.append(
        models.YouTubeRetentionPeak(
            start_sec=start_sec,
            end_sec=end_sec,
            watch_ratio=round(point.watch_ratio, 4),
            relative_performance=round(point.relative_performance, 4),
            label=label,
        )
    )
  return spans


def extract_retention_peaks(
    points: Sequence[models.YouTubeRetentionPoint], duration_sec: float
) -> list[models.YouTubeRetentionPeak]:
  """Identifies the top high-retention / re-watched windows in seconds.

  Args:
    points: Audience Retention points ordered by elapsed_ratio (0..1).
    duration_sec: Total video duration in seconds.

  Returns:
    Up to _MAX_PEAKS non-overlapping peak spans ordered by timestamp.
  """
  if not points or duration_sec <= 0:
    return []
  ordered = sorted(points, key=lambda p: p.elapsed_ratio)
  avg_watch = sum(p.watch_ratio for p in ordered) / len(ordered)

  # Score each bucket by relative performance and how much it beats the
  # local trend (re-watches / spikes).
  scored: list[tuple[float, int, str]] = []
  for idx, point in enumerate(ordered):
    # Skip the very first 3% where 100% initial dropoff skews watch_ratio.
    if point.elapsed_ratio < 0.03:
      continue
    neighbors = ordered[max(0, idx - 3) : min(len(ordered), idx + 4)]
    local_mean = sum(n.watch_ratio for n in neighbors) / len(neighbors)
    bump = max(0.0, point.watch_ratio - local_mean)
    score = point.relative_performance * 0.65 + point.watch_ratio * 0.35 + bump
    if point.relative_performance >= 0.7:
      label = '시청 집중 피크 (동일 길이 영상 대비 상위 유지율)'
    elif point.watch_ratio >= avg_watch * 1.05:
      label = '반복·집중 시청 구간'
    else:
      label = '주요 시청 유지 구간'
    scored.append((score, idx, label))
  return _top_spans(ordered, scored, duration_sec)


def extract_retention_lows(
    points: Sequence[models.YouTubeRetentionPoint], duration_sec: float
) -> list[models.YouTubeRetentionPeak]:
  """Identifies the lowest-retention / steep drop-off windows in seconds.

  Args:
    points: Audience Retention points ordered by elapsed_ratio (0..1).
    duration_sec: Total video duration in seconds.

  Returns:
    Up to _MAX_PEAKS non-overlapping low/drop-off spans ordered by timestamp.
  """
  if not points or duration_sec <= 0:
    return []
  ordered = sorted(points, key=lambda p: p.elapsed_ratio)
  avg_watch = sum(p.watch_ratio for p in ordered) / len(ordered)

  scored: list[tuple[float, int, str]] = []
  for idx, point in enumerate(ordered):
    if point.elapsed_ratio < 0.05 or point.elapsed_ratio > 0.96:
      continue
    prev_point = ordered[max(0, idx - 3)]
    drop = max(0.0, prev_point.watch_ratio - point.watch_ratio)
    low_rel = 1.0 - point.relative_performance
    low_watch = max(0.0, avg_watch - point.watch_ratio)
    if (
        point.relative_performance >= 0.52
        and point.watch_ratio >= avg_watch * 0.95
        and drop < 0.035
    ):
      continue
    score = low_rel * 0.55 + drop * 1.25 + low_watch * 0.45
    if drop >= 0.06:
      label = '급격한 시청자 이탈 구간 (Drop-off)'
    elif point.relative_performance <= 0.35:
      label = '시청 유지율 저조 구간 (동일 길이 영상 대비 하위)'
    else:
      label = '평균 이하 시청 구간 (이탈·스킵 주의)'
    scored.append((score, idx, label))
  return _top_spans(ordered, scored, duration_sec)


def _extract_comment_timestamp(
    text: str, duration_sec: float
) -> float | None:
  """Extracts the first MM:SS or HH:MM:SS timestamp mentioned in a comment."""
  for match in _COMMENT_TIME_RE.finditer(text):
    sec = _parse_clock_timestamp(match.group(1))
    if sec is not None and (duration_sec <= 0 or sec <= duration_sec):
      return round(sec, 1)
  return None


def _fetch_video_comments(
    client: httpx.Client,
    access_token: str,
    video_id: str,
    duration_sec: float,
) -> list[models.YouTubeComment]:
  """Fetches top viewer comments for video_id via commentThreads.list."""
  resp = client.get(
      f'{_YOUTUBE_API}/commentThreads',
      params={
          'part': 'snippet',
          'videoId': video_id,
          'maxResults': 30,
          'order': 'relevance',
          'textFormat': 'plainText',
      },
      headers=_auth_headers(access_token),
  )
  if resp.status_code != 200:
    return []
  items = (resp.json() or {}).get('items') or []
  if not isinstance(items, list):
    return []
  comments: list[models.YouTubeComment] = []
  for raw in items:
    item = _as_dict(raw)
    top_comment = _as_dict(_as_dict(item.get('snippet')).get('topLevelComment'))
    cid = str(top_comment.get('id') or item.get('id') or '').strip()
    c_snippet = _as_dict(top_comment.get('snippet'))
    text = str(
        c_snippet.get('textDisplay') or c_snippet.get('textOriginal') or ''
    ).strip()
    if not text:
      continue
    author = str(c_snippet.get('authorDisplayName') or '시청자').strip()
    likes = _int_stat(c_snippet, 'likeCount')
    published_at = str(c_snippet.get('publishedAt') or '').strip()
    ts = _extract_comment_timestamp(text, duration_sec)
    comments.append(
        models.YouTubeComment(
            comment_id=cid or f'c-{len(comments) + 1}',
            author=author,
            text=text,
            like_count=likes,
            published_at=published_at,
            timestamp_sec=ts,
        )
    )
  comments.sort(
      key=lambda c: (c.timestamp_sec is not None, c.like_count),
      reverse=True,
  )
  return comments[:25]


def _fetch_retention_points(
    client: httpx.Client, access_token: str, video_id: str
) -> list[models.YouTubeRetentionPoint]:
  """Queries YouTube Analytics API v2 for the video's Audience Retention."""
  today = datetime.datetime.now(datetime.UTC).date().isoformat()
  resp = client.get(
      _ANALYTICS_API,
      params={
          'ids': 'channel==MINE',
          'startDate': '2005-01-01',
          'endDate': today,
          'metrics': 'audienceWatchRatio,relativeRetentionPerformance',
          'dimensions': 'elapsedVideoTimeRatio',
          'filters': f'video=={video_id}',
          'sort': 'elapsedVideoTimeRatio',
      },
      headers=_auth_headers(access_token),
  )
  if resp.status_code != 200:
    return []
  data = resp.json()
  rows = data.get('rows') if isinstance(data, dict) else None
  if not isinstance(rows, list):
    return []
  points: list[models.YouTubeRetentionPoint] = []
  for row in rows:
    if not isinstance(row, list) or len(row) < 3:
      continue
    try:
      elapsed = float(row[0])
      watch = float(row[1])
      rel = float(row[2])
    except (TypeError, ValueError):
      continue
    points.append(
        models.YouTubeRetentionPoint(
            elapsed_ratio=min(max(elapsed, 0.0), 1.0),
            watch_ratio=max(watch, 0.0),
            relative_performance=min(max(rel, 0.0), 1.0),
        )
    )
  return points


def _fetch_official_captions(
    client: httpx.Client, access_token: str, video_id: str
) -> tuple[ingestion.Transcript, str]:
  """Downloads the creator's manual caption track for video_id."""
  headers = _auth_headers(access_token)
  resp = client.get(
      f'{_YOUTUBE_API}/captions',
      params={'part': 'snippet', 'videoId': video_id},
      headers=headers,
  )
  if resp.status_code != 200:
    return ingestion.Transcript(words=(), line_starts=()), ''
  items = (resp.json() or {}).get('items') or []
  # Exclude YouTube auto-generated ASR tracks ('trackKind' == 'asr'): their
  # SRT exports use overlapping 2-line rollup cues without word timestamps,
  # whereas Cloud Speech-to-Text V2 (Chirp 3) produces exact word-level offsets.
  tracks = [
      item
      for item in items
      if isinstance(item, dict)
      and item.get('id')
      and str((item.get('snippet') or {}).get('trackKind') or '').lower()
      != 'asr'
  ]
  if not tracks:
    return ingestion.Transcript(words=(), line_starts=()), ''
  chosen = tracks[0]
  caption_id = str(chosen['id'])
  language = str((chosen.get('snippet') or {}).get('language') or '').strip()
  dl_resp = client.get(
      f'{_YOUTUBE_API}/captions/{urllib_parse.quote(caption_id, safe="")}',
      params={'tfmt': 'srt'},
      headers=headers,
  )
  if dl_resp.status_code != 200 or not dl_resp.text.strip():
    return ingestion.Transcript(words=(), line_starts=()), ''
  return parse_srt_captions(dl_resp.text), language


def fetch_video_context(
    access_token: str, video_id: str, fallback_duration_sec: float = 0.0
) -> models.YouTubeVideoContext:
  """Fetches metadata, Audience Retention, comments and captions for video."""
  headers = _auth_headers(access_token)
  item = models.YouTubeVideoItem(video_id=video_id, title='')
  with _http_client() as client:
    try:
      v_resp = client.get(
          f'{_YOUTUBE_API}/videos',
          params={
              'part': 'snippet,contentDetails,statistics,status',
              'id': video_id,
          },
          headers=headers,
      )
      if v_resp.status_code == 200:
        items = (v_resp.json() or {}).get('items') or []
        if items and isinstance(items[0], dict):
          item = _video_item(items[0], untitled='')
      duration_sec = item.duration_sec or fallback_duration_sec
      points = _fetch_retention_points(client, access_token, video_id)
      captions, language = _fetch_official_captions(
          client, access_token, video_id
      )
      comments = _fetch_video_comments(
          client, access_token, video_id, duration_sec
      )
    except httpx.HTTPError as exc:
      raise YouTubeError(f'YouTube 영상 데이터 조회 실패: {exc}') from exc

  peaks = extract_retention_peaks(points, duration_sec)
  lows = extract_retention_lows(points, duration_sec)
  return models.YouTubeVideoContext(
      video_id=video_id,
      title=item.title,
      published_at=item.published_at,
      duration_sec=duration_sec,
      view_count=item.view_count,
      like_count=item.like_count,
      comment_count=item.comment_count,
      privacy_status=item.privacy_status,
      retention_points=points,
      retention_peaks=peaks,
      retention_lows=lows,
      comments=comments,
      caption_words=list(captions.words),
      caption_line_starts=list(captions.line_starts),
      caption_language=language,
  )


# --------------------------------------------------------------------------
# Resumable Shorts upload (YouTube Data API v3 videos.insert)
# --------------------------------------------------------------------------


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

  with _http_client(timeout_sec=600.0) as client:
    try:
      init_resp = client.post(
          _YOUTUBE_UPLOAD_API,
          params={'uploadType': 'resumable', 'part': 'snippet,status'},
          headers={
              **_auth_headers(access_token),
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Length': str(size),
              'X-Upload-Content-Type': 'video/mp4',
          },
          json=metadata,
      )
    except httpx.HTTPError as exc:
      raise YouTubeError(f'YouTube 업로드 세션 시작 실패: {exc}') from exc
    if init_resp.status_code not in (200, 201):
      raise YouTubeError(
          _api_error_message(
              init_resp, 'YouTube 업로드를 시작하지 못했습니다'
          )
      )
    upload_url = init_resp.headers.get('Location', '').strip()
    if not upload_url:
      raise YouTubeError('YouTube 업로드 URL(Location)을 받지 못했습니다.')

    try:
      with media_path.open('rb') as handle:
        put_resp = client.put(
            upload_url,
            headers={'Content-Type': 'video/mp4'},
            content=handle,
        )
    except httpx.HTTPError as exc:
      raise YouTubeError(f'YouTube 영상 전송 실패: {exc}') from exc
    if put_resp.status_code not in (200, 201):
      raise YouTubeError(
          _api_error_message(put_resp, 'YouTube 영상 업로드에 실패했습니다')
      )
    body = put_resp.json()
    video_id = (
        str(body.get('id') or '').strip() if isinstance(body, dict) else ''
    )
    if not video_id:
      raise YouTubeError('YouTube 업로드 응답에 영상 ID가 없습니다.')

  return models.YouTubeUploadResult(
      watch_url=f'https://www.youtube.com/shorts/{video_id}',
      studio_url=f'https://studio.youtube.com/video/{video_id}/edit',
  )
