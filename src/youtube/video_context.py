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
# Peak scores ramp up from _INTRO_WEIGHT at the start of the video to full
# weight at _INTRO_RATIO of its length.
_INTRO_RATIO = 0.3
_INTRO_WEIGHT = 0.3
# A point must beat its neighbors' mean watch ratio by this much to count
# as a re-watch spike.
_MIN_BUMP = 0.01
# relativeRetentionPerformance is 0.5 for the median video of similar
# length; a point without a spike must clearly beat that.
_MIN_RELATIVE = 0.55
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

  # Score each bucket by relative performance and how much it beats the
  # local trend (re-watches / spikes). The raw watch ratio is left out: it
  # only falls as viewers leave, so it would always favor earlier parts.
  scored: list[tuple[float, int, str]] = []
  for idx, point in enumerate(ordered):
    # Skip the very first 3% where 100% initial dropoff skews watch_ratio.
    if point.elapsed_ratio < 0.03:
      continue
    # A symmetric window, so the falling curve near either end does not
    # look like a spike.
    half = min(3, idx, len(ordered) - 1 - idx)
    neighbors = ordered[idx - half : idx + half + 1]
    local_mean = sum(n.watch_ratio for n in neighbors) / len(neighbors)
    bump = point.watch_ratio - local_mean
    if bump < _MIN_BUMP:
      bump = 0.0
      # Neither above similar videos nor a local spike: not a peak.
      if point.relative_performance < _MIN_RELATIVE:
        continue
    score = point.relative_performance * 0.65 + bump
    # Retention always starts high, so the opening of the video counts for
    # less.
    score *= _INTRO_WEIGHT + (1.0 - _INTRO_WEIGHT) * min(
        1.0, point.elapsed_ratio / _INTRO_RATIO
    )
    if point.relative_performance >= 0.7:
      label = '시청 집중 피크 (동일 길이 영상 대비 상위 유지율)'
    elif bump > 0.0:
      label = '반복·집중 시청 구간'
    else:
      label = '주요 시청 유지 구간'
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


_CHAPTER_PAD = ' \t[]()-–—~:|•·'
_CHAPTER_SEP = ' \t-–—~:|•·'


def _parse_single_clock(raw: str) -> float | None:
  """Parses a single MM:SS or HH:MM:SS token into seconds."""
  token = raw.strip(_CHAPTER_PAD)
  parts = token.split(':')
  if len(parts) not in (2, 3) or any(not part.isdigit() for part in parts):
    return None
  if len(parts[-1]) != 2 or int(parts[-1]) >= 60:
    return None
  if len(parts) == 3:
    if len(parts[1]) != 2 or int(parts[1]) >= 60 or len(parts[0]) > 2:
      return None
    return int(parts[0]) * 3600.0 + int(parts[1]) * 60.0 + int(parts[2])
  if len(parts[0]) > 3:
    return None
  return int(parts[0]) * 60.0 + int(parts[1])


def _parse_chapter_token(raw: str) -> float | None:
  """Parses a MM:SS / HH:MM:SS token or compact range into start seconds."""
  sec = _parse_single_clock(raw)
  if sec is not None:
    return sec
  token = raw.strip(_CHAPTER_PAD)
  for sep in ('~', '-', '–', '—'):
    if sep in token:
      left, _, right = token.partition(sep)
      start = _parse_single_clock(left)
      if start is not None and _parse_single_clock(right) is not None:
        return start
  return None


def _strip_list_prefix(line: str) -> str:
  """Removes an optional bullet or numbered list marker at line start."""
  text = line.lstrip(' \t-*•·#')
  first, sep, rest = text.partition(' ')
  if sep and first.endswith(('.', ')')) and first[:-1].isdigit():
    text = rest.lstrip()
  if text[:1] in ('[', '('):
    closer = ']' if text[0] == '[' else ')'
    close_idx = text.find(closer, 1, 24)
    if (
        close_idx > 1
        and _parse_chapter_token(text[1:close_idx]) is not None
        and close_idx + 1 < len(text)
        and not text[close_idx + 1].isspace()
    ):
      text = f'{text[: close_idx + 1]} {text[close_idx + 1 :]}'
  return text


def parse_description_chapters(
    description: str, duration_sec: float = 0.0
) -> list[models.YouTubeChapter]:
  """Extracts chapter timestamps and titles from a video description."""
  chapters: list[models.YouTubeChapter] = []
  seen_secs: set[float] = set()
  for raw_line in description.splitlines():
    line = _strip_list_prefix(raw_line.strip())
    if not line or len(line) > 160:
      continue
    tokens = line.split()
    if len(tokens) < 2:
      continue
    sec = _parse_chapter_token(tokens[0])
    if sec is not None:
      rest = line[len(tokens[0]) :].lstrip(_CHAPTER_SEP)
      rest_tokens = rest.split()
      if (
          len(rest_tokens) >= 2
          and _parse_chapter_token(rest_tokens[0]) is not None
      ):
        rest = rest[len(rest_tokens[0]) :].lstrip(_CHAPTER_SEP)
      title = rest.strip(_CHAPTER_SEP)
    else:
      sec = _parse_chapter_token(tokens[-1])
      if sec is None:
        continue
      title = line[: len(line) - len(tokens[-1])].strip(_CHAPTER_SEP)
    if (
        not title
        or title.lower().startswith(('http://', 'https://'))
        or (duration_sec > 0 and sec >= duration_sec)
    ):
      continue
    rounded = round(sec, 1)
    if rounded not in seen_secs:
      seen_secs.add(rounded)
      chapters.append(models.YouTubeChapter(start_sec=rounded, title=title))
  chapters.sort(key=lambda item: item.start_sec)
  return chapters if len(chapters) >= 2 else []


def _query_shorts_analytics_rows(
    client: httpx.Client, access_token: str
) -> tuple[list[list[object]], bool]:
  """Queries YouTube Analytics API v2 for top Shorts metrics."""
  today = datetime.datetime.now(datetime.UTC).date().isoformat()
  base_params = {
      'ids': 'channel==MINE',
      'startDate': '2005-01-01',
      'endDate': today,
      'metrics': (
          'views,averageViewDuration,averageViewPercentage,'
          'likes,subscribersGained'
      ),
      'dimensions': 'video',
      'sort': '-views',
      'maxResults': 25,
  }
  headers = common.auth_headers(access_token)
  resp = client.get(
      _ANALYTICS_API,
      params={**base_params, 'filters': 'creatorContentType==SHORTS'},
      headers=headers,
  )
  if resp.status_code == 200:
    rows = common.as_dict(resp.json()).get('rows')
    if isinstance(rows, list) and rows:
      return [r for r in rows if isinstance(r, list)], True
  resp = client.get(
      _ANALYTICS_API,
      params={**base_params, 'maxResults': 50},
      headers=headers,
  )
  if resp.status_code != 200:
    return [], False
  rows = common.as_dict(resp.json()).get('rows')
  if not isinstance(rows, list):
    return [], False
  return [r for r in rows if isinstance(r, list)], False


def _fetch_channel_shorts_stats(
    client: httpx.Client, access_token: str
) -> list[models.YouTubeShortStat]:
  """Fetches top-performing Shorts metrics from the creator's channel."""
  rows, filtered_by_type = _query_shorts_analytics_rows(client, access_token)
  parsed: list[tuple[str, int, float, float, int, int]] = []
  for row in rows:
    if len(row) < 6:
      continue
    vid = str(row[0] or '').strip()
    if not vid:
      continue
    try:
      views = max(0, int(float(row[1] or 0)))
      avg_dur = round(max(0.0, float(row[2] or 0.0)), 1)
      avg_pct = round(max(0.0, float(row[3] or 0.0)), 1)
      likes = max(0, int(float(row[4] or 0)))
      subs = max(0, int(float(row[5] or 0)))
    except (TypeError, ValueError):
      continue
    parsed.append((vid, views, avg_dur, avg_pct, likes, subs))
  if not parsed:
    return []

  v_resp = client.get(
      f'{common.YOUTUBE_API}/videos',
      params={
          'part': 'snippet,contentDetails',
          'id': ','.join(vid for vid, *_ in parsed[:50]),
      },
      headers=common.auth_headers(access_token),
  )
  meta: dict[str, tuple[str, float, bool]] = {}
  if v_resp.status_code == 200:
    for raw in common.as_dict(v_resp.json()).get('items') or []:
      if not isinstance(raw, dict):
        continue
      item = videos.video_item(raw, untitled='')
      raw_tags = common.as_dict(raw.get('snippet')).get('tags')
      tags = raw_tags if isinstance(raw_tags, list) else []
      is_short = videos.has_shorts_tag(
          item.title, item.description, tags
      ) or (0.0 < item.duration_sec <= 65.0)
      meta[item.video_id] = (item.title, item.duration_sec, is_short)

  stats: list[models.YouTubeShortStat] = []
  for vid, views, avg_dur, avg_pct, likes, subs in parsed:
    info = meta.get(vid)
    if info is None or not info[0] or (not filtered_by_type and not info[2]):
      continue
    title, duration_sec, _ = info
    stats.append(
        models.YouTubeShortStat(
            video_id=vid,
            title=title,
            duration_sec=duration_sec,
            views=views,
            average_view_duration_sec=avg_dur,
            average_view_percentage=avg_pct,
            likes=likes,
            subscribers_gained=subs,
        )
    )
    if len(stats) >= 10:
      break
  return stats


def fetch_channel_shorts_stats(
    access_token: str,
) -> list[models.YouTubeShortStat]:
  """Fetches top Shorts performance metrics for the signed-in channel."""
  with common.http_client() as client:
    try:
      return _fetch_channel_shorts_stats(client, access_token)
    except httpx.HTTPError:
      return []


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
      channel_shorts = _fetch_channel_shorts_stats(client, access_token)
    except httpx.HTTPError as exc:
      raise common.YouTubeError(f'YouTube 영상 데이터 조회 실패: {exc}') from exc

  chapters = parse_description_chapters(item.description, duration_sec)
  peaks = extract_retention_peaks(points, duration_sec)
  return models.YouTubeVideoContext(
      video_id=video_id,
      title=item.title,
      description=item.description,
      published_at=item.published_at,
      duration_sec=duration_sec,
      view_count=item.view_count,
      like_count=item.like_count,
      comment_count=item.comment_count,
      privacy_status=item.privacy_status,
      chapters=chapters,
      retention_points=points,
      retention_peaks=peaks,
      comments=comments,
      channel_shorts=channel_shorts,
      caption_words=list(captions.words),
      caption_line_starts=list(captions.line_starts),
      caption_language=language,
  )
