"""Prompts and the structured response schema of the Gemini director.

The Editorial Prompt is user-editable and holds every editorial rule (what to
select, how many Scenarios, how long, which language). The system instruction
only states the output contract that the code relies on.
"""

from __future__ import annotations

from collections.abc import Sequence
import json
from typing import Any

from yt.studio import ingestion
from yt.studio import models

DEFAULT_EDITORIAL_PROMPT = """\
당신은 정보성 롱폼 영상(강의, 강연, 인터뷰)을 9:16 세로 숏폼으로 재구성하는 편집 \
감독입니다. 원본 화자의 목소리만 사용하며 내레이션은 추가하지 않습니다.

[구간 선별]
- 영상을 직접 보고 들으며, 앞뒤 맥락 없이도 이해되는 핵심 주장, 통찰, 구체적인 \
사례, 기억에 남는 한 문장을 찾으세요.
- 각 Clip은 생각이 시작되는 지점에서 시작하고 문장이 끝나는 지점에서 끝나야 \
합니다. 앞 내용을 가리키는 말로 시작해 뜻이 통하지 않는 구간은 피하세요.
- 인사, 자기소개, 광고, 진행 멘트, 청중 반응만 있는 구간은 쓰지 마세요.

[시나리오 구성]
- 서로 다른 주제나 관점을 다루는 Scenario 3개를 만드세요.
- Scenario 하나는 30~60초 분량으로, Clip 2~5개를 이어 붙여 하나의 논리가 \
흐르게 하세요. Clip 순서는 원본 순서와 달라도 됩니다.
- 첫 Clip은 시청자를 붙잡는 가장 강한 문장으로 시작하세요.

[화면 구성]
- 숏폼은 하나의 템플릿을 씁니다. 검은 배경 가운데에 원본 영상 박스가 있고, \
박스 위에 두 줄 헤드라인이, 박스 안 아래쪽에 자막이 들어갑니다.
- 영상 박스는 기본적으로 원본 화면 전체를 보여줍니다. 넓은 샷이라 화자가 \
작게 보일 때만 확대해서 화자를 가운데 두고, 슬라이드나 자료 화면이 중요하면 \
확대하지 마세요.
- 말의 호흡에 맞춰 Audio Transition을 하나 고르세요.

[헤드라인]
- Scenario마다 영상 내내 고정되는 헤드라인 두 줄을 쓰세요. 첫 줄(강조색)은 \
주제나 대상을, 둘째 줄은 시청자가 끝까지 보게 만드는 궁금증이나 핵심 주장을 \
담습니다.
- 각 줄은 한눈에 읽히도록 짧게 쓰고, 영상에 없는 사실은 쓰지 마세요.

[텍스트]
- 헤드라인은 영상에서 쓰는 언어로 쓰세요.
- Scenario 제목, 선정 이유, Clip 목적은 한국어로 쓰세요.
- 화자 이름은 영상에서 확인되는 이름을 쓰고, 알 수 없으면 역할(예: 강연자)로 \
쓰세요.
"""

SYSTEM_INSTRUCTION = """\
You are the editing director of a short-form jump-cut studio. You watch the \
source video yourself through agentic video processing, read its transcript, \
and turn it into vertical 9:16 shorts that reuse only the original speakers' \
voices.

Follow the user's Editorial Prompt for every editorial choice: what to \
select, how many scenarios, how long they are and which language to write in.

Output contract:
- Each clip is one contiguous range of transcript words. startWordIndex and \
endWordIndex are inclusive indices taken from the transcript rows.
- Check every boundary against the video so no clip starts or ends in the \
middle of a word or a thought.
- headline is the scenario's two-line title, shown above the video for the \
whole short: accent is the first line (drawn in a highlight color) and main \
the second line.
- framingLayout.crop picks the part of the source frame shown in the video \
box for the whole scenario. centerX and centerY are normalized coordinates \
(0..1 from the top-left of the source frame) of what the box must keep. \
zoom 1 shows the whole frame; larger values zoom in around the center.
- audioTransition applies to every clip boundary of the scenario. durationSec \
is how long the next clip's audio leads (j_cut) or the previous clip's audio \
trails (l_cut); use 0 for hard_cut.
- fillerWordIndices lists words inside the chosen clips that are pure \
fillers, stutters or false starts and can be removed without changing the \
meaning.
- Use only facts present in the video.
"""

NO_TRANSCRIPT_INSTRUCTION = """\
This video has no captions. For every clip give startSec and endSec on the \
video timeline, and transcribe the clip's speech verbatim in its spoken \
language as lines (startSec, endSec, text), one line per short phrase. Clips \
must still start and end at complete thoughts.
"""


def clock(seconds: float) -> str:
  """Formats seconds as mm:ss.s for prompts and labels."""
  minutes, secs = divmod(max(0.0, seconds), 60)
  return f'{int(minutes):02d}:{secs:04.1f}'


def transcript_rows(transcript: ingestion.Transcript) -> list[str]:
  """Renders one "[start] index:word ..." row per caption line."""
  bounds = [*transcript.line_starts, len(transcript.words)]
  rows = []
  for start, end in zip(bounds, bounds[1:]):
    words = transcript.words[start:end]
    if words:
      body = ' '.join(f'{word.index}:{word.text}' for word in words)
      rows.append(f'[{clock(words[0].start_sec)}] {body}')
  return rows


def build_request_text(
    source: models.SourceVideo,
    chapter_list: Sequence[tuple[float, str]],
    transcript: ingestion.Transcript | None,
    editorial_prompt: str,
    inline_schema: dict[str, Any] | None,
) -> str:
  """Builds the user turn that accompanies the video part.

  Args:
    source: The Source Video metadata.
    chapter_list: (start second, title) chapters from the creator.
    transcript: Transcript Words, or None when the video has no captions.
    editorial_prompt: The user's Editorial Prompt.
    inline_schema: The response schema to spell out in text when the API
      call cannot enforce it as structured output, else None.

  Returns:
    The prompt text.
  """
  lines = [
      '# Editorial Prompt',
      editorial_prompt.strip(),
      '',
      '# Source Video',
      f'title: {source.title}',
      f'channel: {source.channel}',
      f'duration: {clock(source.duration_sec)} ({source.duration_sec:.1f}s)',
      f'spoken language: {source.language or "unknown"}',
  ]
  if chapter_list:
    lines.append('chapters:')
    lines.extend(f'- [{clock(start)}] {title}' for start, title in chapter_list)
  lines += ['', '# Transcript']
  if transcript is None:
    lines.append(NO_TRANSCRIPT_INSTRUCTION)
  else:
    lines.append('One row per caption line: [line start] index:word ...')
    lines.extend(transcript_rows(transcript))
  if inline_schema is not None:
    lines += [
        '',
        '# Output',
        'Reply with only one JSON object that follows this JSON Schema:',
        json.dumps(inline_schema, ensure_ascii=False),
    ]
  return '\n'.join(lines)


def _string(description: str = '') -> dict[str, Any]:
  schema: dict[str, Any] = {'type': 'string'}
  if description:
    schema['description'] = description
  return schema


def _number(minimum: float, maximum: float) -> dict[str, Any]:
  return {'type': 'number', 'minimum': minimum, 'maximum': maximum}


def _object(
    properties: dict[str, Any], required: Sequence[str]
) -> dict[str, Any]:
  return {
      'type': 'object',
      'properties': properties,
      'required': list(required),
  }


def _crop() -> dict[str, Any]:
  return _object(
      {
          'centerX': _number(0.0, 1.0),
          'centerY': _number(0.0, 1.0),
          'zoom': _number(1.0, models.MAX_CROP_ZOOM),
      },
      ['centerX', 'centerY', 'zoom'],
  )


def response_schema(has_transcript: bool) -> dict[str, Any]:
  """Returns the JSON Schema of the director's answer.

  Args:
    has_transcript: Whether clips are expressed as transcript word indices
      (True) or as seconds with Gemini's own transcription (False).

  Returns:
    A JSON Schema dict.
  """
  if has_transcript:
    clip_properties: dict[str, Any] = {
        'startWordIndex': {
            'type': 'integer',
            'description': 'Index of the first transcript word of the clip.',
        },
        'endWordIndex': {
            'type': 'integer',
            'description': 'Index of the last transcript word (inclusive).',
        },
    }
  else:
    line = _object(
        {
            'startSec': {'type': 'number'},
            'endSec': {'type': 'number'},
            'text': _string(),
        },
        ['startSec', 'endSec', 'text'],
    )
    clip_properties = {
        'startSec': {'type': 'number'},
        'endSec': {'type': 'number'},
        'lines': {'type': 'array', 'items': line},
    }
  clip_properties |= {
      'speaker': _string(),
      'purpose': _string('Why this clip is in the scenario.'),
  }
  scenario = _object(
      {
          'title': _string(),
          'rationale': _string(),
          'headline': _object(
              {
                  'accent': _string('First headline line (highlighted).'),
                  'main': _string('Second headline line.'),
              },
              ['accent', 'main'],
          ),
          'framingLayout': _object({'crop': _crop()}, ['crop']),
          'audioTransition': _object(
              {
                  'kind': {
                      'type': 'string',
                      'enum': models.catalog_kinds(models.AUDIO_TRANSITIONS),
                  },
                  'durationSec': _number(0.0, models.MAX_TRANSITION_SEC),
              },
              ['kind', 'durationSec'],
          ),
          'clips': {
              'type': 'array',
              'items': _object(clip_properties, list(clip_properties)),
          },
      },
      [
          'title',
          'rationale',
          'headline',
          'framingLayout',
          'audioTransition',
          'clips',
      ],
  )
  properties: dict[str, Any] = {
      'videoSummary': _string(),
      'speakers': {'type': 'array', 'items': _string()},
      'scenarios': {'type': 'array', 'items': scenario},
  }
  if has_transcript:
    properties['fillerWordIndices'] = {
        'type': 'array',
        'items': {'type': 'integer'},
    }
  return _object(properties, list(properties))
