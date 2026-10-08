"""Google Cloud Speech-to-Text V2 (Chirp 3) transcription for local videos.

When an uploaded Source Video has no official YouTube captions, this module
extracts 16 kHz mono FLAC chunks split at silence midpoints (so no spoken
word is cut across a boundary) and calls the Speech-to-Text V2 REST API
(`chirp_3` in the `us` multi-region by default) with word-level time offsets
enabled (`enableWordTimeOffsets: true`). Every returned word carries its own
measured `startOffset` and `endOffset`, avoiding cumulative LLM timestamp
drift and character-length interpolation.
"""

from __future__ import annotations

import base64
from collections.abc import Sequence
from concurrent import futures
import pathlib
import subprocess
import threading
from typing import Any

import google.auth
from google.auth import exceptions as google_auth_exceptions
from google.auth.transport import requests as google_auth_requests
import httpx

from yt.studio import config
from yt.studio import gcp
from yt.studio import ingestion
from yt.studio import models

_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
_MAX_CHUNK_SEC = 55.0
_MIN_CHUNK_RATIO = 0.4
_MAX_WORKERS = 4
_SENTENCE_ENDINGS = ('.', '?', '!', '。', '？', '！')


class SpeechError(RuntimeError):
  """Raised when Cloud Speech-to-Text V2 cannot transcribe the audio."""


def _endpoint_host(location: str) -> str:
  loc = location.lower()
  if loc == 'global':
    return 'https://speech.googleapis.com'
  return f'https://{loc}-speech.googleapis.com'


def _parse_offset_sec(raw: Any) -> float | None:
  """Parses a Speech V2 Duration string (e.g. '1.240s') into seconds."""
  if raw is None or isinstance(raw, bool):
    return None
  if isinstance(raw, (int, float)):
    return max(0.0, float(raw))
  if isinstance(raw, str):
    token = raw.strip()
    if token.endswith(('s', 'S')):
      token = token[:-1].strip()
    try:
      return max(0.0, float(token))
    except ValueError:
      return None
  return None


def plan_audio_chunks(
    duration_sec: float,
    silences: Sequence[models.TimeRange],
) -> list[models.TimeRange]:
  """Splits [0, duration_sec] into chunks at silence midpoints.

  Each chunk lasts at most _MAX_CHUNK_SEC, the limit of synchronous
  recognize.

  Args:
    duration_sec: Total media duration in seconds.
    silences: Silent intervals measured by ffmpeg silencedetect.

  Returns:
    Ordered, contiguous TimeRange chunks covering [0, duration_sec].
  """
  if duration_sec <= 0:
    return []
  limit = _MAX_CHUNK_SEC
  ordered_silences = sorted(silences, key=lambda item: item.start_sec)
  chunks: list[models.TimeRange] = []
  cursor = 0.0
  while duration_sec - cursor > limit:
    window_low = cursor + limit * _MIN_CHUNK_RATIO
    window_high = cursor + limit
    candidates: list[float] = []
    for silence in ordered_silences:
      mid = (silence.start_sec + silence.end_sec) / 2.0
      if window_low <= mid <= window_high:
        candidates.append(mid)
      elif silence.start_sec <= window_high <= silence.end_sec:
        candidates.append(window_high)
    cut = max(candidates) if candidates else window_high
    cut = round(min(max(cut, cursor + 1.0), duration_sec), 3)
    chunks.append(models.TimeRange(start_sec=round(cursor, 3), end_sec=cut))
    cursor = cut
  # Bounds are rounded to milliseconds; a shorter tail would be empty.
  end = round(duration_sec, 3)
  if end > cursor:
    chunks.append(models.TimeRange(start_sec=cursor, end_sec=end))
  return chunks


def _extract_chunk_flac(
    media_path: pathlib.Path, chunk: models.TimeRange
) -> bytes:
  """Extracts one audio chunk as 16 kHz mono FLAC bytes via ffmpeg pipe."""
  settings = config.get_settings()
  span_sec = max(0.1, chunk.end_sec - chunk.start_sec)
  cmd = [
      settings.ffmpeg_bin,
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      f'{chunk.start_sec:.3f}',
      '-t',
      f'{span_sec:.3f}',
      '-i',
      str(media_path),
      '-vn',
      '-sn',
      '-dn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'flac',
      'pipe:1',
  ]
  try:
    proc = subprocess.run(
        cmd,
        capture_output=True,
        timeout=settings.subprocess_timeout_sec,
        check=False,
        stdin=subprocess.DEVNULL,
    )
  except (OSError, subprocess.SubprocessError) as exc:
    raise SpeechError(f'오디오 추출 실행 실패: {exc}') from exc
  if proc.returncode != 0 or not proc.stdout:
    err = proc.stderr.decode('utf-8', errors='replace').strip()
    tail = err.splitlines()[-1] if err else '출력 없음'
    raise SpeechError(f'오디오 구간 추출 실패 ({chunk.start_sec:.1f}s): {tail}')
  return proc.stdout


def _max_word_duration_sec(text: str) -> float:
  """Returns a generous upper bound for a single spoken word's duration.

  Chirp 3 natively predicts word `endOffset` tokens and often sets the first
  word after a pause (or at chunk start `0s`) to begin at `prev_end`,
  stretching a single word across several seconds of preceding silence or BGM.
  Clamping `start_sec >= end_sec - _max_word_duration_sec(text)` prevents
  subtitles from appearing seconds before the speaker actually speaks.

  Args:
    text: The surface word token.

  Returns:
    Maximum plausible spoken duration in seconds for `text`.
  """
  clean = len(text.strip('.,?!:;"\'()[]…-—'))
  return min(1.2, max(0.35, max(1, clean) * 0.16 + 0.15))


def parse_recognize_results(
    results: Sequence[Any], chunk_start_sec: float = 0.0
) -> tuple[list[tuple[str, float, float]], list[int]]:
  """Extracts (word, start_sec, end_sec) tuples and line starts from STT JSON.

  Args:
    results: The `results` list from a Speech-to-Text V2 RecognizeResponse.
    chunk_start_sec: Start offset of this audio chunk on the video timeline.

  Returns:
    A tuple of (word spans, relative line-start word indices).
  """
  word_spans: list[tuple[str, float, float]] = []
  line_starts: list[int] = []
  prev_end = chunk_start_sec

  for raw_result in results:
    if not isinstance(raw_result, dict):
      continue
    alternatives = raw_result.get('alternatives')
    if not isinstance(alternatives, list) or not alternatives:
      continue
    top = alternatives[0] if isinstance(alternatives[0], dict) else {}
    raw_words = top.get('words')
    if isinstance(raw_words, list) and raw_words:
      first_in_result = True
      for item in raw_words:
        if not isinstance(item, dict):
          continue
        text = str(item.get('word') or '').strip()
        if not text:
          continue
        rel_start = _parse_offset_sec(item.get('startOffset'))
        rel_end = _parse_offset_sec(item.get('endOffset'))
        start = (
            chunk_start_sec + rel_start if rel_start is not None else prev_end
        )
        end = (
            chunk_start_sec + rel_end if rel_end is not None else start + 0.15
        )
        if end < start:
          start, end = end, start
        if end == start:
          end = start + 0.08
        max_dur = _max_word_duration_sec(text)
        if end - start > max_dur:
          start = max(prev_end, end - max_dur)
        if first_in_result or (start - prev_end >= 0.6):
          line_starts.append(len(word_spans))
          first_in_result = False
        word_spans.append((text, start, end))
        prev_end = end
        if text.endswith(_SENTENCE_ENDINGS):
          first_in_result = True
      continue

    transcript_text = str(top.get('transcript') or '').strip()
    tokens = transcript_text.split()
    if not tokens:
      continue
    res_end_rel = _parse_offset_sec(raw_result.get('resultEndOffset'))
    if res_end_rel is None:
      res_end_rel = _parse_offset_sec(raw_result.get('resultEndTime'))
    seg_start = prev_end
    seg_end = (
        chunk_start_sec + res_end_rel
        if res_end_rel is not None and chunk_start_sec + res_end_rel > seg_start
        else seg_start + max(0.5, len(tokens) * 0.25)
    )
    max_seg = max(1.2, sum(_max_word_duration_sec(tok) for tok in tokens))
    if seg_end - seg_start > max_seg:
      seg_start = max(prev_end, seg_end - max_seg)
    line_starts.append(len(word_spans))
    step = (seg_end - seg_start) / len(tokens)
    for idx, token in enumerate(tokens):
      w_start = seg_start + idx * step
      w_end = seg_start + (idx + 1) * step
      word_spans.append((token, w_start, w_end))
    prev_end = seg_end

  return word_spans, line_starts


def build_transcript_from_word_spans(
    word_spans: Sequence[tuple[str, float, float]],
    line_starts: Sequence[int],
    duration_sec: float = 0.0,
) -> ingestion.Transcript:
  """Converts raw (text, start_sec, end_sec) spans into a monotonic Transcript.

  Args:
    word_spans: Sequence of (word text, start_sec, end_sec).
    line_starts: Word indices where new caption phrases begin.
    duration_sec: Optional total video duration to clamp word ends.

  Returns:
    An ingestion.Transcript with word-level timestamps and line_starts.
  """
  if not word_spans:
    return ingestion.Transcript(words=(), line_starts=())
  texts = [item[0] for item in word_spans]
  tags = ingestion.sound_tag_flags(texts)
  words: list[models.TranscriptWord] = []
  auto_starts: set[int] = {0}
  floor = 0.0
  prev_end = 0.0
  total = len(word_spans)
  for index, (text, raw_start, raw_end) in enumerate(word_spans):
    start = max(floor, raw_start)
    if duration_sec > 0:
      start = min(start, duration_sec)
    end = max(start, raw_end)
    if index + 1 < total:
      next_start = max(start, word_spans[index + 1][1])
      end = min(end, next_start) if next_start > start else end
    if duration_sec > 0:
      end = min(end, duration_sec)
    end = max(start, end)
    max_dur = _max_word_duration_sec(text)
    if end - start > max_dur:
      start = max(prev_end, floor, end - max_dur)
    if index > 0 and (
        start - prev_end >= 0.6 or words[-1].text.endswith(_SENTENCE_ENDINGS)
    ):
      auto_starts.add(index)
    floor = start
    prev_end = end
    words.append(
        models.TranscriptWord(
            index=index,
            text=text,
            start_sec=round(start, 3),
            end_sec=round(end, 3),
            is_sound_tag=tags[index],
        )
    )
  valid_starts = sorted(
      {idx for idx in line_starts if 0 <= idx < len(words)} | auto_starts
  )
  return ingestion.Transcript(
      words=tuple(words), line_starts=tuple(valid_starts)
  )


def normalize_stored_transcript(
    stored: models.StoredTranscript, duration_sec: float = 0.0
) -> models.StoredTranscript:
  """Normalizes word spans and line starts on an already-stored transcript.

  Args:
    stored: The StoredTranscript loaded from the workspace.
    duration_sec: Total video duration in seconds.

  Returns:
    A normalized StoredTranscript with stretched post-pause words clamped.
  """
  if not stored.words:
    return stored
  spans = [(w.text, w.start_sec, w.end_sec) for w in stored.words]
  normalized = build_transcript_from_word_spans(
      spans, stored.line_start_indices, duration_sec=duration_sec
  )
  return models.StoredTranscript(
      words=list(normalized.words),
      line_start_indices=list(normalized.line_starts),
      model=stored.model,
  )


class _SpeechSession:
  """Thread-safe Cloud Speech-to-Text V2 REST caller."""

  def __init__(
      self,
      project: str,
      location: str,
      model: str,
      languages: Sequence[str],
  ) -> None:
    try:
      credentials, _ = google.auth.default(scopes=[_CLOUD_SCOPE])
    except google_auth_exceptions.GoogleAuthError as exc:
      raise SpeechError(
          f'Google Cloud Speech-to-Text 인증 정보를 찾지 못했습니다: {exc}'
      ) from exc
    # config.Settings values: stripped, defaulted, and a project that
    # transcribe_video already checked with gcp.ensure_service_enabled.
    self._project = project
    self._location = location
    self._model = model
    self._languages = list(languages)
    self._credentials = credentials
    self._lock = threading.Lock()
    self._http = httpx.Client(timeout=httpx.Timeout(180.0, connect=20.0))

  def close(self) -> None:
    self._http.close()

  def _headers(self) -> dict[str, str]:
    with self._lock:
      if not self._credentials.valid:
        try:
          self._credentials.refresh(google_auth_requests.Request())
        except google_auth_exceptions.GoogleAuthError as exc:
          raise SpeechError(
              f'Google Cloud 인증 토큰 갱신에 실패했습니다: {exc}'
          ) from exc
      return {'Authorization': f'Bearer {self._credentials.token}'}

  def _url(self) -> str:
    host = _endpoint_host(self._location)
    return (
        f'{host}/v2/projects/{self._project}/locations/{self._location}'
        '/recognizers/_:recognize'
    )

  def recognize_chunk(
      self, media_path: pathlib.Path, chunk: models.TimeRange
  ) -> tuple[list[tuple[str, float, float]], list[int]]:
    """Extracts and transcribes a single audio chunk with Chirp 3."""
    audio_bytes = _extract_chunk_flac(media_path, chunk)
    payload = {
        'config': {
            'autoDecodingConfig': {},
            'languageCodes': self._languages,
            'model': self._model,
            'features': {
                'enableWordTimeOffsets': True,
                'enableAutomaticPunctuation': True,
            },
        },
        'content': base64.b64encode(audio_bytes).decode('ascii'),
    }
    try:
      response = self._http.post(
          self._url(), headers=self._headers(), json=payload
      )
    except httpx.HTTPError as exc:
      raise SpeechError(f'Speech-to-Text API 요청 실패: {exc}') from exc
    if response.status_code != 200:
      detail = response.text[:240]
      try:
        err = (response.json() or {}).get('error')
        if isinstance(err, dict) and isinstance(err.get('message'), str):
          detail = err['message']
      except ValueError:
        pass
      raise SpeechError(
          f'Speech-to-Text ({self._model}, {self._location}) 호출 오류 '
          f'(HTTP {response.status_code}): {detail}'
      )
    try:
      data = response.json()
    except ValueError as exc:
      raise SpeechError('Speech-to-Text 응답이 JSON 형식이 아닙니다.') from exc
    results = data.get('results') if isinstance(data, dict) else None
    if not isinstance(results, list):
      return [], []
    return parse_recognize_results(results, chunk.start_sec)


def transcribe_video(
    media_path: pathlib.Path,
    duration_sec: float,
    silences: Sequence[models.TimeRange],
) -> ingestion.Transcript:
  """Transcribes a local video file with Cloud Speech-to-Text V2 (Chirp 3).

  Args:
    media_path: Path to the uploaded Source Video file.
    duration_sec: Duration of the video in seconds.
    silences: Measured silent ranges used to pick clean chunk boundaries.

  Returns:
    Word-level ingestion.Transcript aligned to the video's audio clock.

  Raises:
    SpeechError: If audio extraction or the Speech-to-Text V2 call fails.
  """
  settings = config.get_settings()
  ok, err = gcp.ensure_service_enabled(
      settings.speech_project,
      gcp.SPEECH_API_SERVICE,
      display_name='Cloud Speech-to-Text',
  )
  if not ok:
    raise SpeechError(err)
  chunks = plan_audio_chunks(duration_sec, silences)
  if not chunks:
    return ingestion.Transcript(words=(), line_starts=())
  session = _SpeechSession(
      project=settings.speech_project,
      location=settings.speech_location,
      model=settings.speech_model,
      languages=settings.speech_languages,
  )
  try:
    workers = min(_MAX_WORKERS, len(chunks))
    with futures.ThreadPoolExecutor(max_workers=workers) as pool:
      chunk_outputs = list(
          pool.map(
              lambda chunk: session.recognize_chunk(media_path, chunk), chunks
          )
      )
  finally:
    session.close()

  all_words: list[tuple[str, float, float]] = []
  all_line_starts: list[int] = []
  for chunk_words, chunk_starts in chunk_outputs:
    offset = len(all_words)
    for start_idx in chunk_starts:
      all_line_starts.append(offset + start_idx)
    all_words.extend(chunk_words)
  return build_transcript_from_word_spans(
      all_words, all_line_starts, duration_sec=duration_sec
  )
