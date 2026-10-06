"""Gemini director: agentic video understanding that proposes Scenarios.

One call per analysis sends the Source Video as a MediaProcessing.AGENTIC
part (a YouTube URL, or an uploaded file sent inline as a small proxy), the
timestamped transcript and the user's Editorial Prompt. Gemini
decides every Clip boundary itself; this module validates the answer and
converts transcript word indices into seconds. Nothing is invented when the
call fails: the error is reported to the UI instead.
"""

from __future__ import annotations

import asyncio
import collections
from collections.abc import Awaitable, Callable, Sequence
import dataclasses
import json
import pathlib
import time
from typing import Any

from google import genai
from google.auth import exceptions as google_auth_exceptions
from google.genai import errors as genai_errors
from google.genai import types
import httpx

from yt.studio import config
from yt.studio import gemini
from yt.studio import ingestion
from yt.studio import layout
from yt.studio import models
from yt.studio import prompts

Emit = Callable[[dict[str, Any]], Awaitable[None]]

_PREVIEW_CHARS = 240
_AUTH_ERROR_CODES = (401, 403)
_SCHEMA_REJECTED_CODE = 400


class DirectorError(Exception):
  """Raised when the analysis cannot produce Scenarios."""


class _RetryableAnswerError(Exception):
  """The model answered, but the answer is empty or not valid JSON."""


@dataclasses.dataclass(frozen=True)
class UploadedVideo:
  """A Source Video file the user uploaded instead of a YouTube URL."""

  source: models.UploadedSource
  media_path: pathlib.Path
  # Where the inline analysis proxy is written and reused.
  proxy_path: pathlib.Path


@dataclasses.dataclass(frozen=True)
class _GeminiRun:
  model: str
  data: dict[str, Any]
  structured: bool
  agentic_steps: int
  tool_use_tokens: int
  thoughts_tokens: int
  elapsed_sec: float


def progress(stage: str, message: str, **extra: Any) -> dict[str, Any]:
  """Builds a progress event for the analyze stream."""
  return {'type': 'progress', 'stage': stage, 'message': message, **extra}


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
  if isinstance(value, bool) or not isinstance(value, (int, float)):
    return None
  return float(value)


def _int(value: Any) -> int | None:
  number = _float(value)
  if number is None or not number.is_integer():
    return None
  return int(number)


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


def _describe_tool_part(part: types.Part) -> str:
  """Summarizes an agentic tool step (its arguments are usually opaque)."""
  call = part.tool_call
  if call is not None:
    kind = call.tool_type.value if call.tool_type else 'TOOL'
    if not call.args:
      return f'{kind} 호출'
    args = json.dumps(call.args, ensure_ascii=False)
    return f'{kind} 호출 {args}'[:_PREVIEW_CHARS]
  response = part.tool_response
  kind = response.tool_type.value if response and response.tool_type else 'TOOL'
  return f'{kind} 결과 수신'


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
) -> tuple[str, int, types.GenerateContentResponseUsageMetadata | None]:
  """Streams one generation and reports agentic tool steps as they happen."""
  steps = 0
  texts: list[str] = []
  usage = None
  stream = await client.aio.models.generate_content_stream(
      model=model, contents=contents, config=generation_config
  )
  async for chunk in stream:
    for candidate in chunk.candidates or []:
      parts = candidate.content.parts if candidate.content else None
      for part in parts or []:
        if part.tool_call is not None or part.tool_response is not None:
          steps += 1
          await emit(
              progress(
                  'agentic',
                  _describe_tool_part(part),
                  model=model,
                  agenticSteps=steps,
              )
          )
        elif part.thought:
          if part.text:
            await emit(
                progress('thought', part.text[:_PREVIEW_CHARS], model=model)
            )
        elif part.text:
          texts.append(part.text)
    if chunk.usage_metadata is not None:
      usage = chunk.usage_metadata
  return ''.join(texts), steps, usage


async def _run_agentic(
    source: models.SourceVideo,
    video: types.Part,
    chapter_list: Sequence[tuple[float, str]],
    transcript: ingestion.Transcript | None,
    editorial_prompt: str,
    emit: Emit,
) -> _GeminiRun:
  """Calls Gemini with retries and model fallback.

  Structured output (response_json_schema) is requested first. If the API
  rejects it for this media mode, the same schema is spelled out in the
  prompt and the JSON is parsed from the text answer.
  """
  settings = config.get_settings()
  backend = gemini.label(settings)
  client = gemini.make_client(settings)
  schema = prompts.response_schema(has_transcript=transcript is not None)
  structured = True
  failures: collections.Counter[str] = collections.Counter()
  for model in settings.model_chain:
    attempt = 0
    while attempt < settings.gemini_attempts_per_model:
      attempt += 1
      request_text = prompts.build_request_text(
          source,
          chapter_list,
          transcript,
          editorial_prompt,
          inline_schema=None if structured else schema,
      )
      generation_config = types.GenerateContentConfig(
          system_instruction=prompts.SYSTEM_INSTRUCTION,
          response_mime_type='application/json' if structured else None,
          response_json_schema=schema if structured else None,
          # No client-side tools; agentic steps run on the server.
          automatic_function_calling=types.AutomaticFunctionCallingConfig(
              disable=True
          ),
      )
      await emit(
          progress(
              'gemini',
              f'{model}({backend})가 영상을 직접 탐색하며 Scenario를 구성하고 '
              '있습니다.',
              model=model,
              attempt=attempt,
          )
      )
      started = time.monotonic()
      try:
        text, steps, usage = await _stream_once(
            client, model, [video, request_text], generation_config, emit
        )
        data = _parse_json(text)
      except google_auth_exceptions.GoogleAuthError as exc:
        # Credentials fail the same way for every model, so stop here.
        raise DirectorError(gemini.auth_failure_message(settings, exc)) from exc
      except genai_errors.ClientError as exc:
        if exc.code == _SCHEMA_REJECTED_CODE and structured:
          structured = False
          attempt -= 1
          await emit(
              progress(
                  'retry',
                  '구조화 출력 설정이 거부되어 JSON 지시 방식으로 다시 요청합니다: '
                  f'{exc.message}',
                  model=model,
              )
          )
          continue
        if exc.code in _AUTH_ERROR_CODES:
          raise DirectorError(
              f'{backend} 인증 오류({exc.code}): {exc.message}'
          ) from exc
        failures[f'{model}: {_describe_error(exc)}'] += 1
        break
      except (
          genai_errors.APIError,
          httpx.HTTPError,
          TimeoutError,
          _RetryableAnswerError,
      ) as exc:
        reason = _describe_error(exc)
        failures[f'{model}: {reason}'] += 1
        await emit(
            progress(
                'retry',
                f'{model} 호출 실패 ({attempt}/'
                f'{settings.gemini_attempts_per_model}): {reason}',
                model=model,
            )
        )
        await asyncio.sleep(settings.gemini_retry_delay_sec)
        continue
      return _GeminiRun(
          model=model,
          data=data,
          structured=structured,
          agentic_steps=steps,
          tool_use_tokens=(usage.tool_use_prompt_token_count or 0)
          if usage
          else 0,
          thoughts_tokens=(usage.thoughts_token_count or 0) if usage else 0,
          elapsed_sec=round(time.monotonic() - started, 1),
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
  zoom = _float(data.get('zoom'))
  return models.CropRegion(
      center_x=_clamp(0.5 if center_x is None else center_x, 0.0, 1.0),
      center_y=_clamp(0.5 if center_y is None else center_y, 0.0, 1.0),
      zoom=_clamp(1.0 if zoom is None else zoom, 1.0, models.MAX_CROP_ZOOM),
  )


def _catalog_kind(
    raw: Any,
    catalog: tuple[models.CatalogEntry, ...],
    label: str,
    warnings: list[str],
) -> str:
  kind = _text(raw)
  kinds = models.catalog_kinds(catalog)
  if kind in kinds:
    return kind
  warnings.append(f'{label}: 알 수 없는 값 "{kind}" 대신 "{kinds[0]}"을 씁니다.')
  return kinds[0]


def _framing(raw: Any) -> models.FramingLayout:
  return models.FramingLayout(crop=_crop(_as_dict(raw).get('crop')))


def _headline(raw: Any) -> models.Headline:
  data = _as_dict(raw)
  return models.Headline(
      accent=_text(data.get('accent')), main=_text(data.get('main'))
  )


def _transition(
    raw: Any, label: str, warnings: list[str]
) -> models.AudioTransition:
  data = _as_dict(raw)
  duration = _float(data.get('durationSec'))
  return models.AudioTransition(
      kind=_catalog_kind(
          data.get('kind'), models.AUDIO_TRANSITIONS, label, warnings
      ),
      duration_sec=_clamp(duration or 0.0, 0.0, models.MAX_TRANSITION_SEC),
  )


def _index_range(
    raw_clip: dict[str, Any], words: Sequence[models.TranscriptWord]
) -> tuple[int, int] | None:
  first = _int(raw_clip.get('startWordIndex'))
  last = _int(raw_clip.get('endWordIndex'))
  if first is None or last is None:
    return None
  first, last = min(first, last), max(first, last)
  if first < 0 or last >= len(words):
    return None
  return first, last


def _seconds_range(
    raw_clip: dict[str, Any], duration_sec: float
) -> tuple[float, float] | None:
  start = _float(raw_clip.get('startSec'))
  end = _float(raw_clip.get('endSec'))
  if start is None or end is None:
    return None
  start = max(0.0, start)
  if duration_sec > 0:
    end = min(duration_sec, end)
  return (start, end) if end > start else None


def _transcript_from_answer(data: dict[str, Any]) -> ingestion.Transcript:
  """Builds Transcript Words from Gemini's own transcription of the Clips."""
  lines = []
  for scenario in _as_list(data.get('scenarios')):
    for clip in _as_list(_as_dict(scenario).get('clips')):
      for raw_line in _as_list(_as_dict(clip).get('lines')):
        entry = _as_dict(raw_line)
        start = _float(entry.get('startSec'))
        end = _float(entry.get('endSec'))
        text = _text(entry.get('text'))
        if start is not None and end is not None and text and end > start:
          lines.append(ingestion.CaptionLine(start=start, end=end, text=text))
  lines.sort(key=lambda line: line.start)
  kept: list[ingestion.CaptionLine] = []
  for line in lines:
    # Overlapping Clips repeat the same speech; keep the first transcription.
    if not kept or line.start >= kept[-1].end:
      kept.append(line)
  return ingestion.transcript_from_lines(kept, 'gemini')


def _build_scenarios(
    data: dict[str, Any],
    transcript: ingestion.Transcript,
    duration_sec: float,
    uses_word_indices: bool,
    warnings: list[str],
) -> tuple[list[models.Scenario], list[tuple[int, int]]]:
  """Validates the answer and converts Clip ranges into seconds."""
  words = transcript.words
  scenarios = []
  index_ranges: list[tuple[int, int]] = []
  for s_number, raw in enumerate(_as_list(data.get('scenarios')), start=1):
    scenario = _as_dict(raw)
    label = f'Scenario {s_number}'
    clips = []
    for c_number, raw_clip in enumerate(
        _as_list(scenario.get('clips')), start=1
    ):
      clip_data = _as_dict(raw_clip)
      if uses_word_indices:
        index_range = _index_range(clip_data, words)
        seconds = (
            (words[index_range[0]].start_sec, words[index_range[1]].end_sec)
            if index_range
            else None
        )
        if index_range:
          index_ranges.append(index_range)
      else:
        seconds = _seconds_range(clip_data, duration_sec)
      if seconds is None:
        warnings.append(f'{label} Clip {c_number}: 범위가 올바르지 않아 제외했습니다.')
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
      warnings.append(f'{label}: 유효한 Clip이 없어 제외했습니다.')
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
            audio_transition=_transition(
                scenario.get('audioTransition'), label, warnings
            ),
            clips=clips,
        )
    )
  return scenarios, index_ranges


def _filler_indices(
    data: dict[str, Any], index_ranges: Sequence[tuple[int, int]]
) -> list[int]:
  result = set()
  for value in _as_list(data.get('fillerWordIndices')):
    index = _int(value)
    if index is not None and any(a <= index <= b for a, b in index_ranges):
      result.add(index)
  return sorted(result)


async def _prepare_youtube(
    youtube_url: str, emit: Emit
) -> tuple[
    models.SourceVideo,
    types.Part,
    list[tuple[float, str]],
    ingestion.Transcript | None,
    list[str],
]:
  """Reads YouTube metadata and captions and builds the URL video part."""
  video_id = ingestion.parse_video_id(youtube_url)
  await emit(progress('metadata', 'YouTube 메타데이터를 불러오고 있습니다.'))
  info = await asyncio.to_thread(ingestion.fetch_video_info, video_id)
  await emit(progress('captions', '자막에서 단어별 타이밍을 추출하고 있습니다.'))
  transcript, warnings = await asyncio.to_thread(
      ingestion.load_transcript, info
  )
  source = ingestion.build_source_video(
      info, video_id, transcript.caption_source if transcript else 'gemini'
  )
  if transcript is None and ingestion.has_caption_tracks(info):
    await emit(
        progress(
            'captions',
            '자막을 불러오지 못해 Gemini에게 받아쓰기를 함께 요청합니다: '
            + ' / '.join(warnings),
        )
    )
  elif transcript is None:
    await emit(progress('captions', '자막이 없어 Gemini에게 받아쓰기를 함께 요청합니다.'))
  else:
    await emit(
        progress(
            'captions',
            f'단어 {len(transcript.words)}개, 자막 줄 '
            f'{len(transcript.line_starts)}개를 준비했습니다.',
        )
    )
  video = types.Part(
      file_data=types.FileData(file_uri=source.url, mime_type='video/mp4'),
      media_processing=types.MediaProcessing.AGENTIC,
  )
  return source, video, ingestion.chapters(info), transcript, warnings


async def _prepare_upload(
    upload: UploadedVideo, emit: Emit
) -> tuple[models.SourceVideo, types.Part, list[str]]:
  """Builds the inline video part of an uploaded file.

  Uploaded files have no captions, so Gemini also transcribes the Clips it
  chooses.
  """
  settings = config.get_settings()
  warnings = []
  if not upload.source.has_audio:
    warnings.append('업로드한 영상에 오디오 트랙이 없어 받아쓰기를 할 수 없습니다.')
  await emit(
      progress(
          'proxy',
          f'업로드한 영상을 Gemini에 보낼 {settings.analysis_proxy_height}p '
          '분석용 사본으로 줄이고 있습니다.',
      )
  )
  size = await asyncio.to_thread(
      ingestion.make_analysis_proxy,
      str(upload.media_path),
      upload.proxy_path,
  )
  limit = settings.max_inline_video_bytes
  if size > limit:
    raise DirectorError(
        f'분석용 사본이 {size / 2**20:.0f}MB로 Gemini 인라인 한도 '
        f'{limit / 2**20:.0f}MB를 넘습니다. 더 짧은 영상을 올리거나 '
        'STUDIO_ANALYSIS_PROXY_HEIGHT / STUDIO_ANALYSIS_PROXY_FPS를 낮추세요.'
    )
  await emit(
      progress(
          'captions',
          f'분석용 사본 {size / 2**20:.1f}MB를 준비했습니다. 자막이 없어 Gemini에게 '
          '받아쓰기를 함께 요청합니다.',
      )
  )
  data = await asyncio.to_thread(upload.proxy_path.read_bytes)
  video = types.Part(
      inline_data=types.Blob(data=data, mime_type='video/mp4'),
      media_processing=types.MediaProcessing.AGENTIC,
  )
  return ingestion.source_video_from_upload(upload.source), video, warnings


async def analyze(
    request: models.AnalyzeRequest,
    emit: Emit,
    upload: UploadedVideo | None = None,
) -> models.AnalysisResult:
  """Runs the full analysis for one Source Video.

  Args:
    request: The YouTube URL or upload id, and the Editorial Prompt.
    emit: Receives progress events while the analysis runs.
    upload: The uploaded file named by request.source_id, if any.

  Returns:
    The Source Video, Transcript Words and Gemini's Scenarios.

  Raises:
    ingestion.IngestionError: If the video metadata cannot be read.
    DirectorError: If Gemini fails or returns no usable Scenario.
  """
  settings = config.get_settings()
  if settings.gemini_setup_error:
    raise DirectorError(settings.gemini_setup_error)
  if upload is not None:
    source, video, warnings = await _prepare_upload(upload, emit)
    chapter_list: list[tuple[float, str]] = []
    transcript = None
  else:
    source, video, chapter_list, transcript, warnings = (
        await _prepare_youtube(request.youtube_url, emit)
    )

  run = await _run_agentic(
      source,
      video,
      chapter_list,
      transcript,
      request.editorial_prompt,
      emit,
  )
  await emit(progress('validate', 'Gemini 응답을 검증하고 있습니다.'))
  uses_word_indices = transcript is not None
  if transcript is None:
    transcript = _transcript_from_answer(run.data)
  scenarios, index_ranges = _build_scenarios(
      run.data, transcript, source.duration_sec, uses_word_indices, warnings
  )
  if not scenarios:
    raise DirectorError(
        'Gemini 응답에 사용할 수 있는 Scenario가 없습니다. ' + ' / '.join(warnings)
    )
  speakers = [
      name
      for name in dict.fromkeys(
          _text(item) for item in _as_list(run.data.get('speakers'))
      )
      if name
  ]
  return models.AnalysisResult(
      source_video=source,
      transcript_words=list(transcript.words),
      line_start_indices=list(transcript.line_starts),
      video_summary=_text(run.data.get('videoSummary')),
      speakers=speakers,
      scenarios=scenarios,
      cut_word_indices=_filler_indices(run.data, index_ranges),
      analysis=models.AnalysisReport(
          gemini_backend=settings.gemini_backend,
          gemini_model=run.model,
          media_processing=types.MediaProcessing.AGENTIC.value,
          structured_output=run.structured,
          agentic_steps=run.agentic_steps,
          tool_use_tokens=run.tool_use_tokens,
          thoughts_tokens=run.thoughts_tokens,
          elapsed_sec=run.elapsed_sec,
          warnings=warnings,
      ),
  )
