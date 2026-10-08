"""Gemini director: agentic video understanding that proposes Scenarios.

The first analysis of a Source Video sends its small proxy inline with
MediaProcessing.AGENTIC plus the user's Editorial Prompt. Gemini decides
every Clip boundary itself and transcribes the whole speech; that transcript
is kept in the Workspace, and the proxy is also put in a Gemini Context
Cache (STUDIO_CONTEXT_CACHE_TTL_SEC) so the video need not be sent again
while the cache lives. A later re-analysis then runs either fast, from the
transcript text alone, or deep, with the cached video and the transcript.
This module validates the answers and adds up the list price of the calls.
Nothing is invented when a call fails: the error is reported to the UI
instead.
"""

from __future__ import annotations

import asyncio
import collections
from collections.abc import Awaitable, Callable
import dataclasses
import datetime
import json
import pathlib
import time
from typing import Any, Literal

from google import genai
from google.auth import exceptions as google_auth_exceptions
from google.genai import errors as genai_errors
from google.genai import types
import httpx

from yt.studio import config
from yt.studio import gcp
from yt.studio import gemini
from yt.studio import ingestion
from yt.studio import layout
from yt.studio import models
from yt.studio import pricing
from yt.studio import prompts
from yt.studio import speech
from yt.studio import storage
from yt.studio import youtube

Emit = Callable[[dict[str, Any]], Awaitable[None]]
# How one analysis asks Gemini (see prompts.py): the first analysis of a
# Source Video is always 'initial'; later ones follow AnalyzeRequest.mode.
_Kind = Literal['initial', 'fast', 'deep']

_PREVIEW_CHARS = 240
_AUTH_ERROR_CODES = (401, 403)
_SCHEMA_REJECTED_CODE = 400
# The Vertex AI location priced like the Gemini API (no regional markup).
_GLOBAL_LOCATION = 'global'


class DirectorError(Exception):
  """Raised when the analysis cannot produce Scenarios."""


class _RetryableAnswerError(Exception):
  """The model answered, but the answer is empty or not valid JSON."""


@dataclasses.dataclass(frozen=True)
class UploadedVideo:
  """A Source Video file the user uploaded."""

  source: models.UploadedSource
  media_path: pathlib.Path


@dataclasses.dataclass(frozen=True)
class _Job:
  """What one analysis asks Gemini for."""

  kind: _Kind
  source: models.SourceVideo
  editorial_prompt: str
  # The inline analysis proxy; None for a fast re-analysis.
  video: types.Part | None
  # The transcript stored by the first analysis; None during that one.
  transcript: models.StoredTranscript | None
  # Optional YouTube Audience Retention and caption context.
  youtube_context: models.YouTubeVideoContext | None = None

  def schema(self) -> dict[str, Any]:
    return prompts.response_schema(
        include_transcript=self.kind == 'initial',
        include_framing=self.kind != 'fast',
    )

  def request_text(self, inline_schema: dict[str, Any] | None) -> str:
    return prompts.build_request_text(
        self.kind,
        self.source,
        self.editorial_prompt,
        self.transcript,
        inline_schema,
        self.youtube_context,
    )


@dataclasses.dataclass(frozen=True)
class _GeminiRun:
  data: dict[str, Any]
  # The model that gave the answer.
  model: str
  # List price of every call that returned a response; None if unknown.
  cost_usd: float | None


def progress(stage: str, message: str = '') -> dict[str, Any]:
  """Builds a progress event for the analyze stream.

  The UI shows a fixed status line per stage; only 'thought' events carry
  text (the model's latest thought summary).
  """
  return {'type': 'progress', 'stage': stage, 'message': message}


# --------------------------------------------------------------------------
# Loose JSON readers (the answer is untrusted input)
# --------------------------------------------------------------------------


def _as_dict(value: Any) -> dict[str, Any]:
  return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
  return value if isinstance(value, list) else []


def _text(value: Any) -> str:
  return value.strip() if isinstance(value, str) else ''


def _float(value: Any) -> float | None:
  if value is None or isinstance(value, bool):
    return None
  if isinstance(value, (int, float)):
    return float(value)
  if isinstance(value, str):
    try:
      return float(value.strip())
    except ValueError:
      return None
  return None


def _parse_seconds(value: Any, duration_sec: float = 0.0) -> float | None:
  """Parses a timestamp into seconds on the video timeline.

  Accepts floats/ints, numeric strings ("75.5"), clock strings ("01:15.5",
  "1:15"), bracketed/unit strings ("75s", "[01:15]"), as well as MMSS
  representation (e.g. 610 for 6:10 when duration_sec < 610) and milliseconds.
  """
  if value is None or isinstance(value, bool):
    return None
  if isinstance(value, (int, float)):
    num = float(value)
  elif isinstance(value, str):
    cleaned = value.strip().strip('[]() ')
    if cleaned.endswith(('s', 'S')):
      cleaned = cleaned[:-1].strip()
    if ':' in cleaned:
      try:
        parts = [float(p) for p in cleaned.split(':')]
      except ValueError:
        return None
      if len(parts) == 2:
        num = parts[0] * 60.0 + parts[1]
      elif len(parts) == 3:
        num = parts[0] * 3600.0 + parts[1] * 60.0 + parts[2]
      else:
        return None
    else:
      try:
        num = float(cleaned)
      except ValueError:
        return None
  else:
    return None

  if duration_sec > 0 and num > duration_sec:
    # Check MMSS representation (e.g. 610 for 06:10 -> 370s, 830 -> 510s).
    if num >= 100:
      mins = int(num) // 100
      secs = num - (mins * 100)
      if secs < 60:
        candidate = mins * 60.0 + secs
        if candidate <= duration_sec:
          return candidate
    # Check milliseconds representation (e.g. 75000ms -> 75s).
    if num >= 1000 and (num / 1000.0) <= duration_sec:
      return num / 1000.0
  return num


def _clamp(value: float, low: float, high: float) -> float:
  return min(max(value, low), high)


def _parse_json(text: str) -> dict[str, Any]:
  """Reads the first JSON object in text (tolerates code fences)."""
  start = text.find('{')
  if start < 0:
    raise _RetryableAnswerError('응답에 JSON 객체가 없습니다.')
  try:
    data, _ = json.JSONDecoder().raw_decode(text[start:])
  except json.JSONDecodeError as exc:
    raise _RetryableAnswerError(f'응답 JSON을 해석하지 못했습니다: {exc}') from exc
  if not isinstance(data, dict):
    raise _RetryableAnswerError('응답 JSON이 객체가 아닙니다.')
  return data


# --------------------------------------------------------------------------
# Gemini call
# --------------------------------------------------------------------------


def _describe_error(exc: Exception) -> str:
  """Returns a one-line reason without the raw response dump."""
  if isinstance(exc, genai_errors.APIError):
    return f'{exc.code} {exc.status or ""}: {exc.message or ""}'.strip(' :')
  return str(exc)[:_PREVIEW_CHARS]


async def _stream_once(
    client: genai.Client,
    model: str,
    contents: list[Any],
    generation_config: types.GenerateContentConfig,
    emit: Emit,
) -> tuple[str, types.GenerateContentResponseUsageMetadata | None]:
  """Streams one generation and reports its thoughts.

  Returns:
    The answer text and the call's usage. Usage is not split across chunks:
    the last chunk that carries it holds the totals of the call.
  """
  texts: list[str] = []
  usage = None
  stream = await client.aio.models.generate_content_stream(
      model=model, contents=contents, config=generation_config
  )
  async for chunk in stream:
    for candidate in chunk.candidates or []:
      parts = candidate.content.parts if candidate.content else None
      for part in parts or []:
        # Agentic tool steps (the frames and audio Gemini fetches) are not
        # part of the answer.
        if part.tool_call is not None or part.tool_response is not None:
          continue
        if part.thought:
          if part.text:
            await emit(progress('thought', part.text[:_PREVIEW_CHARS]))
        elif part.text:
          texts.append(part.text)
    if chunk.usage_metadata is not None:
      usage = chunk.usage_metadata
  return ''.join(texts), usage


class _VideoCache:
  """The Gemini Context Cache that holds a Source Video's analysis proxy.

  A cache belongs to one model on one backend, so the record kept in the
  Workspace is reused only for that model and replaced otherwise. When the
  API refuses to create or use a cache (for example because the agentic
  video part counts fewer than the minimum cacheable tokens), the analysis
  goes on with the video sent inline, and no further cache is tried.
  """

  def __init__(
      self,
      client: genai.Client,
      workspace: storage.Workspace,
      source_id: str,
      video: types.Part,
      record: models.CachedVideoMeta | None,
      emit: Emit,
  ) -> None:
    self._client = client
    self._workspace = workspace
    self._source_id = source_id
    self._video = video
    self._record = record
    self._emit = emit
    settings = config.get_settings()
    self._backend = settings.gemini_backend
    self._ttl_sec = settings.context_cache_ttl_sec
    self._enabled = self._ttl_sec > 0
    # (model, token count) of every cache created during this analysis;
    # _run_gemini prices them with its calls.
    self.writes: list[tuple[str, int]] = []

  async def for_model(self, model: str) -> models.CachedVideoMeta | None:
    """Returns a live cache for model, creating one if needed, or None."""
    record = self._record
    now = time.time()
    if (
        record is not None
        and record.model == model
        and record.backend == self._backend
        and record.is_alive(now)
    ):
      return record
    if record is not None:
      await self._delete(record)
    if not self._enabled:
      return None
    await self._emit(progress('cache'))
    try:
      created = await self._client.aio.caches.create(
          model=model,
          config=types.CreateCachedContentConfig(
              contents=[types.Content(role='user', parts=[self._video])],
              system_instruction=prompts.SYSTEM_INSTRUCTION,
              ttl=f'{self._ttl_sec}s',
              display_name=f'ytcreator-{self._source_id}',
          ),
      )
    except (genai_errors.APIError, httpx.HTTPError, TimeoutError):
      self._enabled = False
      await self._emit(progress('cache'))
      return None
    expires = (
        created.expire_time.timestamp()
        if created.expire_time is not None
        else now + self._ttl_sec
    )
    usage = created.usage_metadata
    tokens = (usage.total_token_count or 0) if usage is not None else 0
    record = models.CachedVideoMeta(
        name=created.name or '',
        model=model,
        backend=self._backend,
        expire_time_epoch=expires,
        token_count=tokens,
    )
    if not record.name:
      return None
    self._record = record
    self.writes.append((model, tokens))
    await asyncio.to_thread(
        self._workspace.save_video_cache, self._source_id, record
    )
    await self._emit(progress('cache'))
    return record

  async def forget(self, record: models.CachedVideoMeta) -> None:
    """Drops a cache the API would not use; the video goes inline instead."""
    self._enabled = False
    await self._emit(progress('cache'))
    await self._delete(record)

  async def _delete(self, record: models.CachedVideoMeta) -> None:
    """Forgets a record and deletes its cache (best effort)."""
    if self._record is record:
      self._record = None
    await asyncio.to_thread(
        self._workspace.discard_video_cache, self._source_id
    )
    if record.backend != self._backend or not record.is_alive(time.time()):
      return
    try:
      await self._client.aio.caches.delete(name=record.name)
    except (genai_errors.APIError, httpx.HTTPError, TimeoutError):
      pass


async def _run_gemini(
    client: genai.Client,
    job: _Job,
    cache: _VideoCache | None,
    emit: Emit,
) -> _GeminiRun:
  """Calls Gemini with retries and model fallback.

  Structured output (response_json_schema) is requested first. If the API
  rejects it for this media mode, the same schema is spelled out in the
  prompt and the JSON is parsed from the text answer. A rejected Context
  Cache is dropped the same way, and the video goes inline. Every call that
  returns a response is priced, including answers retried for being
  unusable; calls that end in an error are not billed.
  """
  settings = config.get_settings()
  backend = gemini.label(settings)
  schema = job.schema()
  regional = (
      settings.gemini_backend == 'vertex'
      and settings.vertex_location != _GLOBAL_LOCATION
  )
  today = datetime.datetime.now(datetime.UTC).date()
  costs: list[float | None] = []
  structured = True
  failures: collections.Counter[str] = collections.Counter()
  for model in settings.model_chain:
    cached = await cache.for_model(model) if cache is not None else None
    attempt = 0
    while attempt < settings.gemini_attempts_per_model:
      attempt += 1
      request_text = job.request_text(None if structured else schema)
      # A cache carries its own system instruction; the API rejects both.
      generation_config = types.GenerateContentConfig(
          system_instruction=(
              None if cached is not None else prompts.SYSTEM_INSTRUCTION
          ),
          cached_content=cached.name if cached is not None else None,
          response_mime_type='application/json' if structured else None,
          response_json_schema=schema if structured else None,
          # No client-side tools; agentic steps run on the server.
          automatic_function_calling=types.AutomaticFunctionCallingConfig(
              disable=True
          ),
      )
      contents: list[Any] = [request_text]
      if job.video is not None and cached is None:
        contents.insert(0, job.video)
      await emit(progress('gemini'))
      try:
        text, usage = await _stream_once(
            client, model, contents, generation_config, emit
        )
        # Priced before parsing, since an unusable answer is billed too.
        costs.append(
            pricing.call_cost_usd(model, usage, regional=regional, day=today)
        )
        data = _parse_json(text)
      except google_auth_exceptions.GoogleAuthError as exc:
        # Credentials fail the same way for every model, so stop here.
        raise DirectorError(gemini.auth_failure_message(settings, exc)) from exc
      except genai_errors.ClientError as exc:
        if exc.code in _AUTH_ERROR_CODES:
          if (
              settings.gemini_backend == 'vertex'
              and exc.code == 403
              and (
                  'aiplatform.googleapis.com' in exc.message
                  or 'Agent Platform API' in exc.message
                  or 'is disabled' in exc.message
                  or 'has not been used' in exc.message
              )
          ):
            await emit(progress('gemini'))
            if gcp.enable_service(
                settings.vertex_project, gcp.VERTEX_API_SERVICE
            ):
              await asyncio.sleep(3.0)
              attempt -= 1
              continue
          raise DirectorError(
              f'{backend} 인증 오류({exc.code}): {exc.message}'
          ) from exc
        if cached is not None and cache is not None:
          await cache.forget(cached)
          cached = None
          attempt -= 1
          continue
        if exc.code == _SCHEMA_REJECTED_CODE and structured:
          structured = False
          attempt -= 1
          await emit(progress('retry'))
          continue
        failures[f'{model}: {_describe_error(exc)}'] += 1
        break
      except (
          genai_errors.APIError,
          httpx.HTTPError,
          TimeoutError,
          _RetryableAnswerError,
      ) as exc:
        failures[f'{model}: {_describe_error(exc)}'] += 1
        await emit(progress('retry'))
        await asyncio.sleep(settings.gemini_retry_delay_sec)
        continue
      if cache is not None:
        costs.extend(
            pricing.cache_write_cost_usd(
                write_model, tokens, regional=regional, day=today
            )
            for write_model, tokens in cache.writes
        )
      return _GeminiRun(
          data=data, model=model, cost_usd=pricing.total_usd(costs)
      )
  details = '\n'.join(
      f'- {reason} (x{count})' if count > 1 else f'- {reason}'
      for reason, count in failures.items()
  )
  raise DirectorError(
      f'모든 Gemini 모델 호출이 실패했습니다({backend}). 잠시 후 다시 '
      '시도하세요.\n' + details
  )


# --------------------------------------------------------------------------
# Answer -> Scenarios
# --------------------------------------------------------------------------


def _crop(raw: Any) -> models.CropRegion:
  data = _as_dict(raw)
  center_x = _float(data.get('centerX'))
  center_y = _float(data.get('centerY'))
  # Keep initial scenario zoom at 1.0 so the source frame is never degraded
  # by automatic digital zoom; center_x/center_y still guide aspect crops.
  return models.CropRegion(
      center_x=_clamp(0.5 if center_x is None else center_x, 0.0, 1.0),
      center_y=_clamp(0.5 if center_y is None else center_y, 0.0, 1.0),
      zoom=1.0,
  )


def _framing(raw: Any) -> models.FramingLayout:
  """Reads a framing; a missing one (fast re-analysis) shows the full frame."""
  return models.FramingLayout(crop=_crop(_as_dict(raw).get('crop')))


def _headline(raw: Any) -> models.Headline:
  data = _as_dict(raw)
  lines = [_text(line) for line in _as_list(data.get('lines'))]
  return models.Headline(lines=[line for line in lines if line])


def _clip_time(
    raw_clip: dict[str, Any], duration_sec: float, *keys: str
) -> float | None:
  for key in keys:
    if key in raw_clip and raw_clip[key] is not None:
      val = _parse_seconds(raw_clip[key], duration_sec)
      if val is not None:
        return val
  return None


def _seconds_range(
    raw_clip: dict[str, Any], duration_sec: float
) -> tuple[float, float] | None:
  start = _clip_time(
      raw_clip, duration_sec, 'startSec', 'start_sec', 'start', 'startTime'
  )
  end = _clip_time(
      raw_clip, duration_sec, 'endSec', 'end_sec', 'end', 'endTime'
  )
  if start is None or end is None:
    return None
  if start > end:
    start, end = end, start
  start = max(0.0, start)
  if duration_sec > 0:
    end = min(duration_sec, end)
  return (start, end) if end > start else None


def _transcript_from_answer(data: dict[str, Any]) -> ingestion.Transcript:
  """Builds Transcript Words from Gemini's transcription of the whole video."""
  lines = []
  raw_lines = (
      data.get('transcriptLines')
      or data.get('lines')
      or data.get('transcript')
  )
  for raw_line in _as_list(raw_lines):
    entry = _as_dict(raw_line)
    start = _clip_time(
        entry, 0.0, 'startSec', 'start_sec', 'start', 'startTime'
    )
    end = _clip_time(entry, 0.0, 'endSec', 'end_sec', 'end', 'endTime')
    text = _text(entry.get('text'))
    if start is not None and end is not None and text:
      if start > end:
        start, end = end, start
      if end > start:
        lines.append(ingestion.CaptionLine(start=start, end=end, text=text))
  lines.sort(key=lambda line: (line.start, line.end))
  kept: list[ingestion.CaptionLine] = []
  for line in lines:
    if kept:
      prev = kept[-1]
      if abs(line.start - prev.start) < 0.2 and line.text == prev.text:
        continue
      if line.start < prev.end:
        trimmed_end = max(prev.start + 0.05, line.start)
        if trimmed_end < prev.end:
          kept[-1] = ingestion.CaptionLine(
              start=prev.start, end=trimmed_end, text=prev.text
          )
        new_start = max(line.start, kept[-1].end)
        line = ingestion.CaptionLine(
            start=new_start,
            end=max(line.end, new_start + 0.05),
            text=line.text,
        )
    kept.append(line)
  return ingestion.transcript_from_lines(kept)


def _build_scenarios(
    data: dict[str, Any], duration_sec: float, warnings: list[str]
) -> list[models.Scenario]:
  """Validates the answer's Scenarios and their Clip ranges in seconds.

  Warnings name Scenarios and Clips the way the UI does ("Shorts", "클립").
  """
  scenarios = []
  for s_number, raw in enumerate(_as_list(data.get('scenarios')), start=1):
    scenario = _as_dict(raw)
    label = f'Shorts {s_number}'
    clips = []
    for c_number, raw_clip in enumerate(
        _as_list(scenario.get('clips')), start=1
    ):
      clip_data = _as_dict(raw_clip)
      seconds = _seconds_range(clip_data, duration_sec)
      if seconds is None:
        warnings.append(f'{label} 클립 {c_number}: 범위가 올바르지 않아 뺐습니다.')
        continue
      clips.append(
          models.Clip(
              clip_id=f's{s_number}-c{c_number}',
              start_sec=seconds[0],
              end_sec=seconds[1],
              speaker=_text(clip_data.get('speaker')),
              purpose=_text(clip_data.get('purpose')),
          )
      )
    if not clips:
      warnings.append(f'{label}: 쓸 수 있는 클립이 없어 뺐습니다.')
      continue
    scenarios.append(
        models.Scenario(
            scenario_id=f's{s_number}',
            title=_text(scenario.get('title')) or label,
            rationale=_text(scenario.get('rationale')),
            look=models.Look(
                headline=_headline(scenario.get('headline')),
                framing_layout=_framing(scenario.get('framingLayout')),
                text_layout=layout.default_text_layout(
                    config.get_settings().template_style
                ),
                style=config.default_look_style(),
            ),
            clips=clips,
        )
    )
  return scenarios


async def _prepare_video(
    upload: UploadedVideo, workspace: storage.Workspace, emit: Emit
) -> types.Part:
  """Builds the inline video part of an upload from its analysis proxy.

  The proxy is made once per upload and kept in the Workspace.
  """
  settings = config.get_settings()
  source_id = upload.source.source_id
  proxy = await asyncio.to_thread(workspace.load_analysis_proxy, source_id)
  if proxy is None:
    await emit(progress('proxy'))
    proxy = workspace.analysis_proxy(source_id)
    size = await asyncio.to_thread(
        ingestion.make_analysis_proxy, str(upload.media_path), proxy
    )
    await asyncio.to_thread(workspace.save_analysis_proxy, source_id)
  else:
    size = proxy.stat().st_size
  limit = settings.max_inline_video_bytes
  if size > limit:
    raise DirectorError(
        f'분석용 사본이 {size / 2**20:.0f}MB로 Gemini 인라인 한도 '
        f'{limit / 2**20:.0f}MB를 넘습니다. 더 짧은 영상을 올리거나 '
        'STUDIO_ANALYSIS_PROXY_HEIGHT / STUDIO_ANALYSIS_PROXY_FPS를 낮추세요.'
    )
  await emit(progress('proxy'))
  data = await asyncio.to_thread(proxy.read_bytes)
  return types.Part(
      inline_data=types.Blob(data=data, mime_type='video/mp4'),
      media_processing=types.MediaProcessing.AGENTIC,
  )


async def _resolve_youtube_context(
    request: models.AnalyzeRequest,
    source_id: str,
    duration_sec: float,
    access_token: str,
    workspace: storage.Workspace,
    warnings: list[str],
    emit: Emit,
) -> models.YouTubeVideoContext | None:
  """Loads or fetches the linked YouTube video context."""
  stored = await asyncio.to_thread(workspace.load_youtube_context, source_id)
  video_id = request.youtube_video_id.strip()
  if not video_id:
    return stored
  if stored is not None and stored.video_id == video_id:
    return stored
  if not access_token:
    warnings.append(
        'YouTube 로그인이 없어 선택한 채널 영상 데이터를 불러오지 못했습니다.'
    )
    return stored
  await emit(progress('youtube'))
  try:
    context = await asyncio.to_thread(
        youtube.fetch_video_context, access_token, video_id, duration_sec
    )
    await asyncio.to_thread(
        workspace.save_youtube_context, source_id, context
    )
    return context
  except youtube.YouTubeError as exc:
    warnings.append(f'YouTube 데이터를 불러오지 못해 영상만으로 진행합니다: {exc}')
    return stored


async def _transcribe_with_speech(
    upload: UploadedVideo,
    workspace: storage.Workspace,
    warnings: list[str],
    emit: Emit,
) -> models.StoredTranscript | None:
  """Transcribes local video audio with Cloud Speech-to-Text V2 (Chirp 3)."""
  settings = config.get_settings()
  await emit(progress('captions'))
  try:
    extracted = await asyncio.to_thread(
        speech.transcribe_video,
        upload.media_path,
        upload.source.media.duration_sec,
        upload.source.silences,
    )
  except speech.SpeechError as exc:
    warnings.append(
        f'Cloud Speech-to-Text 자막 추출을 건너뛰고 Gemini 전사로 진행합니다: {exc}'
    )
    return None
  if not extracted.words:
    warnings.append(
        'Cloud Speech-to-Text에서 음성이 감지되지 않아 Gemini 전사로 진행합니다.'
    )
    return None
  stored = models.StoredTranscript(
      words=list(extracted.words),
      line_start_indices=list(extracted.line_starts),
      model=f'speech:{settings.speech_model}:{settings.speech_location}',
  )
  await asyncio.to_thread(
      workspace.save_transcript, upload.source.source_id, stored
  )
  return stored


async def _ensure_source_silences(
    upload: UploadedVideo, workspace: storage.Workspace, emit: Emit
) -> UploadedVideo:
  """Probes stream metadata and detects audio silences lazily on demand."""
  if upload.source.silences:
    return upload
  media, has_audio = await asyncio.to_thread(
      ingestion.probe_media, str(upload.media_path)
  )
  silences: list[models.TimeRange] = []
  if has_audio:
    await emit(progress('silences'))
    silences = await asyncio.to_thread(
        ingestion.detect_silences, str(upload.media_path), media.duration_sec
    )
  updated = upload.source.model_copy(
      update={'media': media, 'has_audio': has_audio, 'silences': silences}
  )
  await asyncio.to_thread(workspace.save_source_meta, updated)
  return UploadedVideo(source=updated, media_path=upload.media_path)


async def _no_video() -> types.Part | None:
  return None


async def analyze(
    request: models.AnalyzeRequest,
    upload: UploadedVideo,
    workspace: storage.Workspace,
    emit: Emit,
    access_token: str = '',
) -> models.AnalysisResult:
  """Runs the analysis of an uploaded Source Video.

  The first analysis seeds `transcript.json` from official YouTube captions
  when linked, or from Cloud Speech-to-Text V2 (`chirp_3` in the `us`
  multi-region) on pure local videos, and stores a Context Cache of the
  proxy in the Workspace. Later analyses run as request.mode says: 'fast'
  from the transcript alone, 'deep' with the (cached) video and the
  transcript.

  Args:
    request: The upload id, the Editorial Prompt and the re-analysis mode.
    upload: The uploaded file named by request.source_id.
    workspace: Where the proxy, the transcript and the cache record live.
    emit: Receives progress events while the analysis runs.
    access_token: Optional OAuth access token of the signed-in creator.

  Returns:
    The Source Video, its transcript, its Scenarios, and what the analysis
    cost and how long it took.

  Raises:
    ingestion.IngestionError: If the analysis proxy cannot be made.
    storage.StorageError: If the Workspace bucket cannot be used.
    DirectorError: If Gemini fails or returns no usable Scenario.
  """
  started = time.monotonic()
  settings = config.get_settings()
  if settings.gemini_setup_error:
    raise DirectorError(settings.gemini_setup_error)
  source_id = upload.source.source_id
  warnings: list[str] = []
  transcript = await asyncio.to_thread(workspace.load_transcript, source_id)
  has_ever_analyzed = transcript is not None
  needs_video = not has_ever_analyzed or request.mode != 'fast'
  upload, yt_context, video = await asyncio.gather(
      _ensure_source_silences(upload, workspace, emit),
      _resolve_youtube_context(
          request,
          source_id,
          upload.source.media.duration_sec,
          access_token,
          workspace,
          warnings,
          emit,
      ),
      _prepare_video(upload, workspace, emit) if needs_video else _no_video(),
  )
  source = ingestion.source_video_from_upload(upload.source)
  if not upload.source.has_audio:
    warnings.append('업로드한 영상에 오디오 트랙이 없어 받아쓰기를 할 수 없습니다.')
  if (
      transcript is not None
      and transcript.model.startswith('youtube:')
      and upload.source.has_audio
  ):
    upgraded = await _transcribe_with_speech(
        upload, workspace, warnings, emit
    )
    if upgraded is not None:
      transcript = upgraded
  if transcript is None and upload.source.has_audio:
    transcript = await _transcribe_with_speech(
        upload, workspace, warnings, emit
    )
  if (
      transcript is None
      and yt_context is not None
      and yt_context.caption_words
  ):
    transcript = models.StoredTranscript(
        words=list(yt_context.caption_words),
        line_start_indices=list(yt_context.caption_line_starts),
        model=f'youtube:{yt_context.caption_language or "captions"}',
    )
    await asyncio.to_thread(workspace.save_transcript, source_id, transcript)
  if transcript is not None:
    normalized = speech.normalize_stored_transcript(
        transcript, source.duration_sec
    )
    if normalized != transcript:
      transcript = normalized
      await asyncio.to_thread(workspace.save_transcript, source_id, transcript)
  if transcript is None:
    kind: _Kind = 'initial'
  elif not has_ever_analyzed:
    # First run with YouTube captions or Cloud Speech-to-Text V2 (Chirp 3):
    # watch the video for framing and scenarios grounded on exact timestamps.
    kind = 'deep'
  else:
    kind = request.mode
  client = gemini.make_client(settings)
  cache = None
  if kind != 'fast':
    record = await asyncio.to_thread(workspace.load_video_cache, source_id)
    cache = _VideoCache(client, workspace, source_id, video, record, emit)
  job = _Job(
      kind=kind,
      source=source,
      editorial_prompt=request.editorial_prompt,
      video=video,
      transcript=transcript,
      youtube_context=yt_context,
  )
  run = await _run_gemini(client, job, cache, emit)
  await emit(progress('validate'))
  if kind == 'initial':
    extracted = _transcript_from_answer(run.data)
    if extracted.words:
      transcript = models.StoredTranscript(
          words=list(extracted.words),
          line_start_indices=list(extracted.line_starts),
          model=run.model,
      )
      await asyncio.to_thread(
          workspace.save_transcript, source_id, transcript
      )
    else:
      warnings.append(
          'Gemini가 전체 자막을 받아쓰지 못해 자막 없이 진행합니다. 다시 '
          '분석하면 받아쓰기를 다시 시도합니다.'
      )
  scenarios = _build_scenarios(run.data, source.duration_sec, warnings)
  if not scenarios:
    raise DirectorError(
        'Gemini 응답에 쓸 수 있는 Shorts가 없습니다. ' + ' / '.join(warnings)
    )
  return models.AnalysisResult(
      source_video=source,
      transcript_words=list(transcript.words) if transcript else [],
      line_start_indices=(
          list(transcript.line_start_indices) if transcript else []
      ),
      scenarios=scenarios,
      analysis=models.AnalysisReport(
          cost_usd=None if run.cost_usd is None else round(run.cost_usd, 4),
          elapsed_sec=round(time.monotonic() - started, 1),
          warnings=warnings,
      ),
      silences=list(upload.source.silences),
      youtube_video_id=yt_context.video_id if yt_context else '',
      retention_points=(
          list(yt_context.retention_points) if yt_context else []
      ),
      retention_peaks=list(yt_context.retention_peaks) if yt_context else [],
      retention_lows=list(yt_context.retention_lows) if yt_context else [],
      youtube_comments=list(yt_context.comments) if yt_context else [],
  )
