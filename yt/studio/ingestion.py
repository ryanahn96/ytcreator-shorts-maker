"""Source Video ingestion: YouTube metadata, Transcript Words, uploaded media.

Parsing relies on urllib.parse, json, difflib and plain string methods. Caption
text is never interpreted semantically here; that is Gemini's job.

Word timing strategy:
  * Uploaded (manual) captions carry the best text but only line timing.
  * YouTube ASR captions carry per-word onsets but noisier text.
  * When both exist, manual tokens are aligned to ASR tokens inside each
    manual line window, so the text comes from the manual track and the
    timing from ASR. Unmatched tokens are interpolated by character length.
"""

from __future__ import annotations

import bisect
from collections.abc import Sequence
import dataclasses
import difflib
import json
import pathlib
import string
import subprocess
import time
from typing import Any
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from yt.studio import config
from yt.studio import models

_VIDEO_ID_LENGTH = 11
_VIDEO_ID_CHARS = frozenset(string.ascii_letters + string.digits + '-_')
_YOUTUBE_HOSTS = ('youtube.com', 'youtube-nocookie.com')
_SHORT_LINK_HOST = 'youtu.be'
_ID_PATH_PREFIXES = ('shorts', 'embed', 'live', 'v')
_ASR_SUFFIX = '-orig'
_SOUND_TAG_PAIRS = {'(': ')', '[': ']'}
# Caption fetches retried after these HTTP statuses (rate limit, server).
_TRANSIENT_HTTP_CODES = frozenset({429, 500, 502, 503, 504})


class IngestionError(Exception):
  """Raised when the Source Video or an uploaded file cannot be read."""


@dataclasses.dataclass(frozen=True)
class CaptionLine:
  """A caption line with its display window in seconds."""

  start: float
  end: float
  text: str


@dataclasses.dataclass(frozen=True)
class Transcript:
  """Transcript Words plus the indices where caption lines begin."""

  words: tuple[models.TranscriptWord, ...]
  line_starts: tuple[int, ...]
  caption_source: models.CaptionSource


@dataclasses.dataclass(frozen=True)
class _Onset:
  start: float
  text: str


@dataclasses.dataclass(frozen=True)
class _AsrLine:
  end: float
  words: tuple[_Onset, ...]


@dataclasses.dataclass(frozen=True)
class _TimedLine:
  end: float
  tokens: tuple[str, ...]
  starts: tuple[float, ...]


# --------------------------------------------------------------------------
# YouTube URL and metadata
# --------------------------------------------------------------------------


def _is_video_id(value: str) -> bool:
  return len(value) == _VIDEO_ID_LENGTH and set(value) <= _VIDEO_ID_CHARS


def _host_matches(host: str, domain: str) -> bool:
  return host == domain or host.endswith('.' + domain)


def parse_video_id(raw: str) -> str:
  """Extracts the 11-character video id from a YouTube URL or bare id.

  Args:
    raw: A watch/shorts/embed/live/youtu.be URL, or the id itself.

  Returns:
    The video id.

  Raises:
    IngestionError: If no valid id can be found.
  """
  value = raw.strip()
  if _is_video_id(value):
    return value
  if '://' not in value:
    value = 'https://' + value
  parts = urllib_parse.urlsplit(value)
  host = (parts.hostname or '').lower()
  segments = [segment for segment in parts.path.split('/') if segment]
  candidate = ''
  if _host_matches(host, _SHORT_LINK_HOST):
    candidate = segments[0] if segments else ''
  elif any(_host_matches(host, domain) for domain in _YOUTUBE_HOSTS):
    if segments[:1] == ['watch']:
      candidate = urllib_parse.parse_qs(parts.query).get('v', [''])[0]
    elif len(segments) >= 2 and segments[0] in _ID_PATH_PREFIXES:
      candidate = segments[1]
  if not _is_video_id(candidate):
    raise IngestionError(f'YouTube 영상 주소를 인식하지 못했습니다: {raw}')
  return candidate


def canonical_url(video_id: str) -> str:
  """Returns the canonical watch URL that Gemini receives."""
  return f'https://www.youtube.com/watch?v={video_id}'


def _run(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
  try:
    return subprocess.run(
        list(command),
        capture_output=True,
        text=True,
        timeout=config.get_settings().subprocess_timeout_sec,
        check=False,
        stdin=subprocess.DEVNULL,
    )
  except (OSError, subprocess.SubprocessError) as exc:
    raise IngestionError(f'{command[0]} 실행 실패: {exc}') from exc


def _last_line(text: str) -> str:
  lines = [line.strip() for line in text.splitlines() if line.strip()]
  return lines[-1] if lines else '(출력 없음)'


def _number(value: Any) -> float:
  """Returns value as float when it is a real number (or numeric string)."""
  if isinstance(value, bool) or value is None:
    return 0.0
  try:
    return float(value)
  except (TypeError, ValueError):
    return 0.0


def fetch_video_info(video_id: str) -> dict[str, Any]:
  """Reads the yt-dlp info dict (metadata only, no media download).

  Args:
    video_id: The YouTube video id.

  Returns:
    The yt-dlp info dict.

  Raises:
    IngestionError: If yt-dlp fails or prints something that is not JSON.
  """
  command = [
      *config.get_settings().ytdlp_command,
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '-J',
      canonical_url(video_id),
  ]
  proc = _run(command)
  if proc.returncode != 0:
    raise IngestionError(
        f'YouTube 메타데이터를 가져오지 못했습니다: {_last_line(proc.stderr)}'
    )
  try:
    info = json.loads(proc.stdout)
  except json.JSONDecodeError as exc:
    raise IngestionError('yt-dlp 출력이 JSON 형식이 아닙니다.') from exc
  if not isinstance(info, dict):
    raise IngestionError('yt-dlp 출력이 예상한 형식이 아닙니다.')
  return info


def build_source_video(
    info: dict[str, Any],
    video_id: str,
    caption_source: models.CaptionSource,
) -> models.SourceVideo:
  """Builds the Source Video model from a yt-dlp info dict."""
  formats = [fmt for fmt in info.get('formats') or [] if isinstance(fmt, dict)]

  def best(key: str) -> float:
    return _number(info.get(key)) or max(
        (_number(fmt.get(key)) for fmt in formats), default=0.0
    )

  return models.SourceVideo(
      video_id=video_id,
      url=canonical_url(video_id),
      title=str(info.get('title') or ''),
      channel=str(info.get('channel') or info.get('uploader') or ''),
      duration_sec=_number(info.get('duration')),
      language=str(info.get('language') or ''),
      fps=best('fps'),
      width=int(best('width')),
      height=int(best('height')),
      thumbnail_url=str(info.get('thumbnail') or ''),
      caption_source=caption_source,
  )


def chapters(info: dict[str, Any]) -> list[tuple[float, str]]:
  """Returns (start second, title) of the creator-defined chapters."""
  result = []
  for chapter in info.get('chapters') or []:
    if isinstance(chapter, dict) and chapter.get('title'):
      result.append(
          (_number(chapter.get('start_time')), str(chapter['title']))
      )
  return result


# --------------------------------------------------------------------------
# Captions -> Transcript Words
# --------------------------------------------------------------------------


def _base_language(code: str) -> str:
  return code.split('-')[0].casefold()


def _first_json3(tracks: dict[str, Any], keys: Sequence[str]) -> str:
  for key in keys:
    for fmt in tracks.get(key) or []:
      if isinstance(fmt, dict) and fmt.get('ext') == 'json3' and fmt.get('url'):
        return str(fmt['url'])
  return ''


def _select_caption_urls(info: dict[str, Any]) -> tuple[str, str]:
  """Returns (manual json3 URL, ASR json3 URL) in the spoken language."""
  manual = info.get('subtitles') or {}
  automatic = info.get('automatic_captions') or {}
  asr_keys = [key for key in automatic if key.endswith(_ASR_SUFFIX)]
  language = _base_language(str(info.get('language') or ''))
  if not language and asr_keys:
    language = _base_language(asr_keys[0].removesuffix(_ASR_SUFFIX))
  same_language_asr = [
      key
      for key in asr_keys
      if _base_language(key.removesuffix(_ASR_SUFFIX)) == language
  ]
  asr_url = (
      _first_json3(automatic, same_language_asr)
      or _first_json3(automatic, asr_keys)
      or _first_json3(automatic, [language])
  )
  manual_keys = [key for key in manual if key != 'live_chat']
  if language:
    # A manual track in another language is a translation, not a transcript.
    manual_keys = [
        key for key in manual_keys if _base_language(key) == language
    ]
  return _first_json3(manual, manual_keys), asr_url


def has_caption_tracks(info: dict[str, Any]) -> bool:
  """Returns whether YouTube lists a usable caption track for the video."""
  manual_url, asr_url = _select_caption_urls(info)
  return bool(manual_url or asr_url)


def _fetch_events(url: str) -> list[dict[str, Any]]:
  """Downloads json3 caption events, retrying rate limits and 5xx errors."""
  settings = config.get_settings()
  attempt = 1
  while True:
    try:
      with urllib_request.urlopen(
          url, timeout=settings.http_timeout_sec
      ) as response:
        payload = json.loads(response.read().decode('utf-8'))
      break
    except urllib_error.HTTPError as exc:
      transient = exc.code in _TRANSIENT_HTTP_CODES
      if not transient or attempt >= settings.caption_fetch_attempts:
        raise
      time.sleep(settings.caption_retry_delay_sec * attempt)
      attempt += 1
  events = payload.get('events') if isinstance(payload, dict) else None
  return [event for event in events or [] if isinstance(event, dict)]


def _manual_lines(events: list[dict[str, Any]]) -> list[CaptionLine]:
  lines = []
  for event in events:
    segments = event.get('segs') or []
    text = ''.join(str(seg.get('utf8') or '') for seg in segments)
    if not text.split():
      continue
    start = _number(event.get('tStartMs')) / 1000
    end = start + _number(event.get('dDurationMs')) / 1000
    lines.append(CaptionLine(start=start, end=end, text=text))
  return lines


def _asr_lines(events: list[dict[str, Any]]) -> list[_AsrLine]:
  lines = []
  for event in events:
    base_ms = _number(event.get('tStartMs'))
    words = []
    for seg in event.get('segs') or []:
      onset = (base_ms + _number(seg.get('tOffsetMs'))) / 1000
      words.extend(
          _Onset(start=onset, text=token)
          for token in str(seg.get('utf8') or '').split()
      )
    if words:
      end = (base_ms + _number(event.get('dDurationMs'))) / 1000
      lines.append(_AsrLine(end=end, words=tuple(words)))
  return lines


def _normalize(token: str) -> str:
  return ''.join(char for char in token.casefold() if char.isalnum())


def _interpolate(
    tokens: Sequence[str],
    anchors: dict[int, float],
    start: float,
    end: float,
) -> list[float]:
  """Assigns start times to tokens, interpolating by character position."""
  positions = []
  cursor = 0
  for token in tokens:
    positions.append(cursor)
    cursor += max(1, len(token))
  known = [(0.0, start)]
  known += [(float(positions[i]), anchors[i]) for i in sorted(anchors)]
  known.append((float(cursor), end))
  result = []
  k = 0
  for index, position in enumerate(positions):
    if index in anchors:
      result.append(anchors[index])
      continue
    while k + 1 < len(known) and known[k + 1][0] <= position:
      k += 1
    left_pos, left_time = known[k]
    right_pos, right_time = known[min(k + 1, len(known) - 1)]
    span = right_pos - left_pos
    ratio = (position - left_pos) / span if span > 0 else 0.0
    result.append(left_time + (right_time - left_time) * ratio)
  return result


def _monotonic(starts: Sequence[float], floor: float) -> list[float]:
  result = []
  for value in starts:
    floor = max(floor, value)
    result.append(floor)
  return result


def _spread_ties(starts: list[float], limit: float) -> list[float]:
  """Spreads runs of equal start times evenly up to the next distinct one."""
  result = list(starts)
  i = 0
  while i < len(result):
    j = i
    while j + 1 < len(result) and result[j + 1] <= result[i]:
      j += 1
    if j > i:
      upper = result[j + 1] if j + 1 < len(result) else max(limit, result[i])
      step = (upper - result[i]) / (j - i + 1)
      for k in range(i + 1, j + 1):
        result[k] = result[i] + step * (k - i)
    i = j + 1
  return result


def _align_line(
    line: CaptionLine,
    asr_words: Sequence[_Onset],
    asr_starts: Sequence[float],
    tolerance: float,
) -> _TimedLine:
  """Times a manual line with the ASR onsets found inside its window."""
  tokens = line.text.split()
  low = bisect.bisect_left(asr_starts, line.start - tolerance)
  high = bisect.bisect_right(asr_starts, line.end + tolerance)
  window = asr_words[low:high]
  matcher = difflib.SequenceMatcher(
      None,
      [_normalize(token) for token in tokens],
      [_normalize(word.text) for word in window],
      autojunk=False,
  )
  anchors = {}
  for block in matcher.get_matching_blocks():
    for offset in range(block.size):
      if _normalize(tokens[block.a + offset]):
        anchors[block.a + offset] = window[block.b + offset].start
  starts = _interpolate(tokens, anchors, line.start, line.end)
  return _TimedLine(end=line.end, tokens=tuple(tokens), starts=tuple(starts))


def _interpolated_line(line: CaptionLine) -> _TimedLine:
  tokens = line.text.split()
  starts = _interpolate(tokens, {}, line.start, line.end)
  return _TimedLine(end=line.end, tokens=tuple(tokens), starts=tuple(starts))


def _sound_tag_flags(tokens: Sequence[str]) -> list[bool]:
  """Marks bracketed caption markup such as "(Laughter)" or "[음악]"."""
  flags = []
  closer = ''
  for token in tokens:
    if not closer and token[:1] in _SOUND_TAG_PAIRS:
      closer = _SOUND_TAG_PAIRS[token[0]]
    flags.append(bool(closer))
    if closer and token.endswith(closer):
      closer = ''
  return flags


def _finish(
    lines: Sequence[_TimedLine], caption_source: models.CaptionSource
) -> Transcript:
  """Turns timed lines into Transcript Words with monotonic timing.

  A word ends where the next word starts. The last word of a line also stops
  at the line end when that end lies after its start, which exposes the
  pauses between caption lines.
  """
  texts: list[str] = []
  starts: list[float] = []
  limits: list[float] = []
  tags: list[bool] = []
  line_starts: list[int] = []
  floor = 0.0
  for line in lines:
    if not line.tokens:
      continue
    line_starts.append(len(texts))
    line_times = _monotonic(line.starts, floor)
    floor = line_times[-1]
    texts.extend(line.tokens)
    starts.extend(line_times)
    tags.extend(_sound_tag_flags(line.tokens))
    limits.extend([float('inf')] * (len(line.tokens) - 1) + [line.end])
  if not texts:
    return Transcript(words=(), line_starts=(), caption_source=caption_source)
  starts = _spread_ties(starts, max(limits[-1], starts[-1]))
  words = []
  for index, text in enumerate(texts):
    start = starts[index]
    next_start = starts[index + 1] if index + 1 < len(texts) else limits[index]
    limit = limits[index]
    end = min(next_start, limit) if limit > start else next_start
    end = max(start, end)
    words.append(
        models.TranscriptWord(
            index=index,
            text=text,
            start_sec=round(start, 3),
            end_sec=round(end, 3),
            is_sound_tag=tags[index],
        )
    )
  return Transcript(
      words=tuple(words),
      line_starts=tuple(line_starts),
      caption_source=caption_source,
  )


def transcript_from_lines(
    lines: Sequence[CaptionLine], caption_source: models.CaptionSource
) -> Transcript:
  """Builds Transcript Words from lines, interpolating word timing."""
  ordered = sorted(lines, key=lambda line: line.start)
  return _finish([_interpolated_line(line) for line in ordered], caption_source)


def load_transcript(
    info: dict[str, Any],
) -> tuple[Transcript | None, list[str]]:
  """Loads the best available Transcript Words for the Source Video.

  Args:
    info: The yt-dlp info dict.

  Returns:
    (transcript or None when the video has no usable captions, warnings).
  """
  manual_url, asr_url = _select_caption_urls(info)
  warnings = []
  manual: list[CaptionLine] = []
  asr: list[_AsrLine] = []
  fetch_errors = (
      urllib_error.URLError,
      TimeoutError,
      json.JSONDecodeError,
      UnicodeDecodeError,
  )
  if manual_url:
    try:
      manual = _manual_lines(_fetch_events(manual_url))
    except fetch_errors as exc:
      warnings.append(f'업로드 자막을 불러오지 못했습니다: {exc}')
  if asr_url:
    try:
      asr = _asr_lines(_fetch_events(asr_url))
    except fetch_errors as exc:
      warnings.append(f'자동 생성 자막을 불러오지 못했습니다: {exc}')

  if manual and asr:
    asr_words = [word for line in asr for word in line.words]
    asr_starts = [word.start for word in asr_words]
    tolerance = config.get_settings().alignment_tolerance_sec
    timed = [
        _align_line(line, asr_words, asr_starts, tolerance) for line in manual
    ]
    return _finish(timed, 'manual_aligned'), warnings
  if asr:
    timed = [
        _TimedLine(
            end=line.end,
            tokens=tuple(word.text for word in line.words),
            starts=tuple(word.start for word in line.words),
        )
        for line in asr
    ]
    return _finish(timed, 'asr'), warnings
  if manual:
    warnings.append(
        '단어 단위 타이밍이 없는 자막이라 줄 안에서 보간했습니다. '
        '무음 및 추임새 컷은 업로드한 원본의 실측 무음 기준으로 확인하세요.'
    )
    return transcript_from_lines(manual, 'manual'), warnings
  return None, warnings


# --------------------------------------------------------------------------
# Uploaded Source Video file
# --------------------------------------------------------------------------


def _parse_rate(value: Any) -> float:
  numerator, _, denominator = str(value or '').partition('/')
  top = _number(numerator)
  bottom = _number(denominator) if denominator else 1.0
  return top / bottom if bottom else 0.0


def _rotation(stream: dict[str, Any]) -> int:
  for side_data in stream.get('side_data_list') or []:
    if isinstance(side_data, dict) and 'rotation' in side_data:
      return int(_number(side_data['rotation']))
  return 0


def probe_media(path: str) -> tuple[models.MediaInfo, bool]:
  """Reads duration, frame rate and display size of a media file.

  Args:
    path: The media file path.

  Returns:
    (media info, whether the file has an audio stream).

  Raises:
    IngestionError: If the file is not a readable video.
  """
  settings = config.get_settings()
  proc = _run([
      settings.ffprobe_bin,
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      path,
  ])
  if proc.returncode != 0:
    raise IngestionError(f'영상 파일을 읽지 못했습니다: {_last_line(proc.stderr)}')
  try:
    data = json.loads(proc.stdout)
  except json.JSONDecodeError as exc:
    raise IngestionError('ffprobe 출력이 JSON 형식이 아닙니다.') from exc
  streams = [s for s in data.get('streams') or [] if isinstance(s, dict)]
  video = next(
      (
          stream
          for stream in streams
          if stream.get('codec_type') == 'video'
          and not (stream.get('disposition') or {}).get('attached_pic')
      ),
      None,
  )
  if video is None:
    raise IngestionError('영상 트랙이 없는 파일입니다.')
  fps = _parse_rate(video.get('avg_frame_rate')) or _parse_rate(
      video.get('r_frame_rate')
  )
  duration = _number((data.get('format') or {}).get('duration')) or _number(
      video.get('duration')
  )
  width = int(_number(video.get('width')))
  height = int(_number(video.get('height')))
  if abs(_rotation(video)) % 180 == 90:
    width, height = height, width
  if fps <= 0 or duration <= 0 or width <= 0 or height <= 0:
    raise IngestionError('영상 길이, 프레임레이트 또는 해상도를 확인할 수 없습니다.')
  has_audio = any(stream.get('codec_type') == 'audio' for stream in streams)
  media = models.MediaInfo(
      duration_sec=duration, fps=fps, width=width, height=height
  )
  return media, has_audio


def detect_silences(path: str, duration_sec: float) -> list[models.TimeRange]:
  """Measures silent ranges with ffmpeg silencedetect.

  Args:
    path: The media file path.
    duration_sec: The media duration, closing a silence that runs to the end.

  Returns:
    Silent ranges in seconds.

  Raises:
    IngestionError: If ffmpeg fails.
  """
  settings = config.get_settings()
  detector = (
      f'silencedetect=noise={settings.silence_noise_db}dB'
      f':d={settings.silence_min_sec}'
  )
  proc = _run([
      settings.ffmpeg_bin,
      '-nostdin',
      '-hide_banner',
      '-i',
      path,
      '-vn',
      '-sn',
      '-dn',
      '-af',
      detector,
      '-f',
      'null',
      '-',
  ])
  if proc.returncode != 0:
    raise IngestionError(f'무음 구간 분석 실패: {_last_line(proc.stderr)}')
  silences = []
  pending: float | None = None
  for line in proc.stderr.splitlines():
    _, found, rest = line.partition('silence_start:')
    if found:
      fields = rest.split()
      pending = max(0.0, _number(fields[0])) if fields else None
      continue
    _, found, rest = line.partition('silence_end:')
    if found and pending is not None:
      end = _number(rest.split('|')[0])
      if end > pending:
        silences.append(models.TimeRange(start_sec=pending, end_sec=end))
      pending = None
  if pending is not None and duration_sec > pending:
    silences.append(models.TimeRange(start_sec=pending, end_sec=duration_sec))
  return silences


def make_analysis_proxy(path: str, output: pathlib.Path) -> int:
  """Writes a small MP4 of an uploaded Source Video for Gemini.

  Gemini receives uploaded videos inline, so the proxy keeps the timeline
  and the speech but lowers resolution, frame rate and bitrates to stay
  under the inline request limit. An existing proxy is reused.

  Args:
    path: The uploaded Source Video.
    output: Where to write (or find) the proxy.

  Returns:
    The proxy size in bytes.

  Raises:
    IngestionError: If ffmpeg fails.
  """
  if output.is_file() and output.stat().st_size > 0:
    return output.stat().st_size
  settings = config.get_settings()
  partial = output.with_name(f'partial-{output.name}')
  proc = _run([
      settings.ffmpeg_bin,
      '-nostdin',
      '-hide_banner',
      '-y',
      '-i',
      path,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      f'scale=-2:{settings.analysis_proxy_height},'
      f'fps={settings.analysis_proxy_fps}',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '32',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '1',
      '-b:a',
      '48k',
      '-movflags',
      '+faststart',
      str(partial),
  ])
  if proc.returncode != 0:
    partial.unlink(missing_ok=True)
    raise IngestionError(
        f'분석용 영상을 만들지 못했습니다: {_last_line(proc.stderr)}'
    )
  partial.replace(output)
  return output.stat().st_size


def source_video_from_upload(
    source: models.UploadedSource,
) -> models.SourceVideo:
  """Builds the Source Video model of a file the user uploaded.

  The upload id doubles as the video id, so the editor can match the
  upload to the analysis without a second upload.

  Args:
    source: The probed upload.

  Returns:
    The Source Video. Its transcript always comes from Gemini.
  """
  return models.SourceVideo(
      video_id=source.source_id,
      url='',
      title=pathlib.PurePath(source.filename).stem,
      channel='',
      duration_sec=source.media.duration_sec,
      language='',
      fps=source.media.fps,
      width=source.media.width,
      height=source.media.height,
      thumbnail_url='',
      caption_source='gemini',
  )


def probe_asset(
    path: str, kind: models.AssetKind
) -> tuple[int, int, float]:
  """Checks that an image or audio file is usable and measures it.

  Args:
    path: The uploaded file.
    kind: The expected file type.

  Returns:
    (width, height, duration seconds); unused values are 0.

  Raises:
    IngestionError: If ffprobe cannot read the expected stream.
  """
  settings = config.get_settings()
  proc = _run([
      settings.ffprobe_bin,
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      path,
  ])
  if proc.returncode != 0:
    raise IngestionError(f'파일을 읽지 못했습니다: {_last_line(proc.stderr)}')
  try:
    data = json.loads(proc.stdout)
  except json.JSONDecodeError as exc:
    raise IngestionError('ffprobe 출력이 JSON 형식이 아닙니다.') from exc
  streams = [s for s in data.get('streams') or [] if isinstance(s, dict)]
  wanted = 'video' if kind == 'image' else 'audio'
  stream = next(
      (item for item in streams if item.get('codec_type') == wanted), None
  )
  if stream is None:
    raise IngestionError(
        '이미지를 읽을 수 없습니다.'
        if kind == 'image'
        else '오디오 트랙이 없는 파일입니다.'
    )
  if kind == 'image':
    width = int(_number(stream.get('width')))
    height = int(_number(stream.get('height')))
    if width <= 0 or height <= 0:
      raise IngestionError('이미지 크기를 확인할 수 없습니다.')
    return width, height, 0.0
  duration = _number((data.get('format') or {}).get('duration')) or _number(
      stream.get('duration')
  )
  if duration <= 0:
    raise IngestionError('오디오 길이를 확인할 수 없습니다.')
  return 0, 0, duration
