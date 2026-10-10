"""YouTube Video Context: audience retention, comments, official captions.

Collected for the channel video a creator links to a Source Video
(YouTube Analytics API v2 and Data API v3) and kept in the Workspace.
"""

from __future__ import annotations

from collections.abc import Sequence
import datetime
import re
from urllib import parse as urllib_parse

import httpx

from src.core import models
from src.media import ingestion
from src.youtube import common
from src.youtube import videos

_ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports'
_MAX_PEAKS = 4
_COMMENT_TIME_RE = re.compile(r'(?<!\d)(\d{1,2}:\d{2}(?::\d{2})?)(?!\d)')


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
      f'{common.YOUTUBE_API}/commentThreads',
      params={
          'part': 'snippet',
          'videoId': video_id,
          'maxResults': 30,
          'order': 'relevance',
          'textFormat': 'plainText',
      },
      headers=common.auth_headers(access_token),
  )
  if resp.status_code != 200:
    return []
  items = (resp.json() or {}).get('items') or []
  if not isinstance(items, list):
    return []
  comments: list[models.YouTubeComment] = []
  for raw in items:
    item = common.as_dict(raw)
    top_comment = common.as_dict(
        common.as_dict(item.get('snippet')).get('topLevelComment')
    )
    cid = str(top_comment.get('id') or item.get('id') or '').strip()
    c_snippet = common.as_dict(top_comment.get('snippet'))
    text = str(
        c_snippet.get('textDisplay') or c_snippet.get('textOriginal') or ''
    ).strip()
    if not text:
      continue
    author = str(c_snippet.get('authorDisplayName') or '시청자').strip()
    likes = common.int_stat(c_snippet, 'likeCount')
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
      headers=common.auth_headers(access_token),
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
  headers = common.auth_headers(access_token)
  resp = client.get(
      f'{common.YOUTUBE_API}/captions',
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
  quoted_id = urllib_parse.quote(caption_id, safe='')
  dl_resp = client.get(
      f'{common.YOUTUBE_API}/captions/{quoted_id}',
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
  headers = common.auth_headers(access_token)
  item = models.YouTubeVideoItem(video_id=video_id, title='')
  with common.http_client() as client:
    try:
      v_resp = client.get(
          f'{common.YOUTUBE_API}/videos',
          params={
              'part': 'snippet,contentDetails,statistics,status',
              'id': video_id,
          },
          headers=headers,
      )
      if v_resp.status_code == 200:
        items = (v_resp.json() or {}).get('items') or []
        if items and isinstance(items[0], dict):
          item = videos.video_item(items[0], untitled='')
      duration_sec = item.duration_sec or fallback_duration_sec
      points = _fetch_retention_points(client, access_token, video_id)
      captions, language = _fetch_official_captions(
          client, access_token, video_id
      )
      comments = _fetch_video_comments(
          client, access_token, video_id, duration_sec
      )
    except httpx.HTTPError as exc:
      raise common.YouTubeError(f'YouTube 영상 데이터 조회 실패: {exc}') from exc

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
