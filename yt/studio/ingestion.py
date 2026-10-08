"""Source Video ingestion: uploaded media probes and Transcript Words.

Parsing relies on json and plain string methods. Caption text is never
interpreted semantically here; that is Gemini's job. Gemini transcribes the
Clips it chooses as timed lines, and words inside a line get start times
spread by character length.
"""

from __future__ import annotations

from collections.abc import Sequence
import dataclasses
import itertools
import json
import pathlib
import subprocess
from typing import Any

from yt.studio import config
from yt.studio import models

_SOUND_TAG_PAIRS = {'(': ')', '[': ']'}


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


# --------------------------------------------------------------------------
# Caption lines -> Transcript Words
# --------------------------------------------------------------------------


def _interpolate(
    tokens: Sequence[str], start: float, end: float
) -> list[float]:
  """Spreads token start times over [start, end] by character position."""
  *positions, total = itertools.accumulate(
      (max(1, len(token)) for token in tokens), initial=0
  )
  return [start + (end - start) * position / total for position in positions]


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


def sound_tag_flags(tokens: Sequence[str]) -> list[bool]:
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


def _finish(lines: Sequence[CaptionLine]) -> Transcript:
  """Turns caption lines into Transcript Words with monotonic timing.

  Words inside a line get start times spread by character position, and no
  word starts before the one preceding it. A word ends where the next word
  starts. The last word of a line also stops at the line end when that end
  lies after its start, which exposes the pauses between caption lines.
  """
  texts: list[str] = []
  starts: list[float] = []
  limits: list[float] = []
  tags: list[bool] = []
  line_starts: list[int] = []
  for line in lines:
    tokens = line.text.split()
    line_starts.append(len(texts))
    texts.extend(tokens)
    starts.extend(_interpolate(tokens, line.start, line.end))
    tags.extend(sound_tag_flags(tokens))
    limits.extend([float('inf')] * (len(tokens) - 1) + [line.end])
  if not texts:
    return Transcript(words=(), line_starts=())
  starts = list(itertools.accumulate(starts, max, initial=0.0))[1:]
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
  return Transcript(words=tuple(words), line_starts=tuple(line_starts))


def _normalize_caption_lines(
    lines: Sequence[CaptionLine],
) -> list[CaptionLine]:
  """Sorts lines, trims overlaps with the next line, and caps long holds."""
  ordered = sorted(lines, key=lambda line: (line.start, line.end))
  normalized: list[CaptionLine] = []
  total = len(ordered)
  for idx, line in enumerate(ordered):
    tokens = line.text.split()
    if not tokens or line.end <= line.start:
      continue
    start = line.start
    end = line.end
    if idx + 1 < total:
      next_start = ordered[idx + 1].start
      if next_start > start and end > next_start:
        end = next_start
    char_count = sum(len(token) for token in tokens)
    max_span = max(1.2, char_count * 0.16 + len(tokens) * 0.35)
    if end - start > max_span:
      end = start + max_span
    if end > start:
      normalized.append(CaptionLine(start=start, end=end, text=line.text))
  return normalized


def transcript_from_lines(lines: Sequence[CaptionLine]) -> Transcript:
  """Builds Transcript Words from lines, interpolating word timing."""
  return _finish(_normalize_caption_lines(lines))



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


def _ffprobe(
    path: str, failure: str
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
  """Reads the format and streams of a media file with ffprobe.

  Args:
    path: The media file path.
    failure: What the error says before ffprobe's last stderr line when
      ffprobe cannot read the file.

  Returns:
    (the parsed ffprobe output, its stream entries that are objects).

  Raises:
    IngestionError: If ffprobe fails or does not print JSON.
  """
  proc = _run([
      config.get_settings().ffprobe_bin,
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      path,
  ])
  if proc.returncode != 0:
    raise IngestionError(f'{failure}: {_last_line(proc.stderr)}')
  try:
    data = json.loads(proc.stdout)
  except json.JSONDecodeError as exc:
    raise IngestionError('ffprobe 출력이 JSON 형식이 아닙니다.') from exc
  streams = [s for s in data.get('streams') or [] if isinstance(s, dict)]
  return data, streams


def probe_media(path: str) -> tuple[models.MediaInfo, bool]:
  """Reads duration, frame rate and display size of a media file.

  Args:
    path: The media file path.

  Returns:
    (media info, whether the file has an audio stream).

  Raises:
    IngestionError: If the file is not a readable video.
  """
  data, streams = _ffprobe(path, '영상 파일을 읽지 못했습니다')
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

  Args:
    source: The probed upload.

  Returns:
    The Source Video, titled with the file name without its extension.
  """
  return models.SourceVideo(
      title=pathlib.PurePath(source.filename).stem,
      duration_sec=source.media.duration_sec,
      fps=source.media.fps,
  )


def probe_asset(
    path: str, kind: models.AssetKind
) -> tuple[int, int, float, bool]:
  """Checks that an image, audio or video file is usable and measures it.

  Args:
    path: The uploaded file.
    kind: The expected file type.

  Returns:
    (width, height, duration seconds, has_audio); unused values are 0/False.

  Raises:
    IngestionError: If ffprobe cannot read the expected stream.
  """
  if kind == 'video':
    media, has_audio = probe_media(path)
    return media.width, media.height, media.duration_sec, has_audio
  data, streams = _ffprobe(path, '파일을 읽지 못했습니다')
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
    return width, height, 0.0, False
  duration = _number((data.get('format') or {}).get('duration')) or _number(
      stream.get('duration')
  )
  if duration <= 0:
    raise IngestionError('오디오 길이를 확인할 수 없습니다.')
  return 0, 0, duration, True
