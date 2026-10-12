"""Prompts and the structured response schema of the Gemini director.

The Editorial Prompt is user-editable and holds every editorial rule (what to
select, how many Scenarios, how long, which language). The system instruction
only states the output contract that the code relies on.

The director (director.py) asks Gemini in three ways, each with its own
request text and schema variant:
  initial: the first analysis of a Source Video watches it and transcribes
    the whole speech besides choosing the Scenarios.
  fast: a re-analysis from the stored transcript text alone; no video.
  deep: a re-analysis that watches the video again (through its Context
    Cache when one is alive) with the transcript attached, for choices that
    need the picture.
"""

from __future__ import annotations

import json
from typing import Any

from src.core import models

DEFAULT_EDITORIAL_PROMPT = """\
당신은 정보성 롱폼 영상(강의, 강연, 인터뷰)을 9:16 세로 Shorts로 재구성하는 편집 \
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
- Clip 사이는 모두 하드컷으로 이어집니다. 문장이 끝나는 지점에서 Clip을 \
끊어야 이음새가 자연스럽습니다.

[화면 구성]
- Shorts는 하나의 템플릿을 씁니다. 검은 배경 가운데에 원본 영상 박스가 있고, \
박스 위에 헤드라인이, 박스 아래에 자막이 들어갑니다.
- 영상 박스는 원본 화질을 선명하게 유지하도록 기본적으로 화면 전체를 \
보여주고, centerX와 centerY에는 주요 화자나 피사체의 중심 위치를 넣으세요.

[헤드라인]
- Scenario마다 영상 상단에 내내 고정되는 2~3줄짜리 실전 Shorts 스타일 \
헤드라인을 쓰세요. 모바일에서 한눈에 들어오도록 각 줄은 10~15자 안팎으로 짧고 \
강렬하게 끊어 쓰세요.
- 첫 줄(강조색)은 시선을 단숨에 끄는 핵심 키워드, 의외의 상황, 또는 화자의 \
직관적인 한마디로 시작하세요.
- 둘째 줄(필요하면 셋째 줄)은 시청자가 끝까지 보지 않고는 못 배기게 만드는 \
반전, 호기심 유발 질문, 통념을 깨는 결론, 또는 결정적 대사를 구어체로 담으세요.
- 교과서나 보고서 같은 딱딱한 명사형 요약(~의 중요성, ~ 분석)이나 마침표로 \
끝나는 긴 설명문은 피하세요.
- 영상에 없는 사실은 쓰지 말고, 댓글·설명에 적힌 타임스탬프(예: 00:14)나 \
번호 표기는 구간을 찾는 참고로만 쓰고 헤드라인에는 절대 넣지 마세요.

[텍스트]
- 헤드라인은 영상에서 쓰는 언어로 쓰세요.
- Scenario 제목(title)은 실제 YouTube Shorts에 바로 올릴 수 있는 매력적인 \
클릭 유도형 제목(구어체 훅, 핵심 대사 인용, 강렬한 대비나 궁금증 유발)으로 \
한국어로 쓰세요. 단순 요약이나 타임스탬프는 넣지 마세요.
- 선정 이유와 Clip 목적은 한국어로 쓰세요.
- 화자 이름은 영상에서 확인되는 이름을 쓰고, 알 수 없으면 역할(예: 강연자)로 \
쓰세요.
"""

# Shared by every request, including the one stored in a Context Cache
# (cached content carries its own system instruction, so this text must
# not depend on how a particular request runs).
SYSTEM_INSTRUCTION = """\
You are the editing director of a short-form jump-cut studio. You turn a \
long-form source video into vertical 9:16 shorts that reuse only the \
original speakers' voices. Each request says what you are given: the video \
itself (watched through agentic video processing), its full transcript, or \
both.

Follow the user's Editorial Prompt for every editorial choice: what to \
select, how many scenarios, how long they are and which language to write in.

Output contract:
- Each clip is one contiguous range of the video timeline from startSec to \
endSec in seconds (e.g. 75.0 for 01:15, or clock strings like "01:15.0").
- Clips follow each other with hard cuts (picture and sound change at the \
same instant), so check every boundary: no clip may start or end in the \
middle of a word or a thought.
- title is a catchy, scroll-stopping YouTube Shorts upload title (hook, \
striking quote, or curiosity gap; never a dry topic label or timestamp).
- headline.lines is the on-screen banner shown above the video for the \
whole short (2-3 punchy lines, ~10-15 chars per line). The first line is \
drawn in a highlight color (hook keyword or context), the others in the \
main headline color (curiosity gap, twist, or punchline; no timestamps).
- framingLayout.crop, when the schema asks for it, picks the part of the \
source frame shown in the video box for the whole scenario. centerX and \
centerY are normalized coordinates (0..1 from the top-left of the source \
frame) of the main speaker or subject.
- thumbnailSec is the source video timestamp in seconds (inside one of the \
scenario's clips) that makes the strongest visual hook frame for the \
scenario's thumbnail.
- Use only facts present in the video or its transcript.
"""

# The first analysis: the video is attached and has no captions.
TRANSCRIBE_INSTRUCTION = """\
This video has no captions. Besides the scenarios, transcribe the ENTIRE \
video's speech verbatim in its spoken language as transcriptLines \
(startSec, endSec, text): one line per short phrase (every 2 to 6 seconds), \
in chronological order from 0.0s all the way to the very end of the video, \
leaving out NOTHING that is said — including all speech outside the clips \
you select. Never skip sections or stop transcribing early. Captions and the \
full-transcript editor are built from transcriptLines, so keep every \
timestamp tight to the speech in seconds (e.g. 75.0 for 01:15).
"""

# A fast re-analysis: text only.
FAST_INSTRUCTION = """\
The video is not attached. Work from its full transcript below, whose \
timestamps are the video timeline: take every clip's startSec and endSec \
directly from the transcript lines (numbers in seconds, e.g. 75.0). Screen \
framing is not part of this answer.
"""

# A deep re-analysis: the video (cached or inline) plus the transcript.
DEEP_INSTRUCTION = """\
The video is attached together with its full transcript, extracted earlier; \
do not transcribe it again. Use the transcript for what is said and when, \
and watch the video for what the words cannot tell: slides and whiteboards \
on screen, faces and gestures, and the framing crop.
"""

# The instruction that opens the Transcript section, per request kind (the
# director's _Kind).
_INSTRUCTIONS = {
    'initial': TRANSCRIBE_INSTRUCTION,
    'fast': FAST_INSTRUCTION,
    'deep': DEEP_INSTRUCTION,
}


def clock(seconds: float) -> str:
  """Formats seconds as mm:ss.s for prompts and labels."""
  minutes, secs = divmod(max(0.0, seconds), 60)
  return f'{int(minutes):02d}:{secs:04.1f}'


def format_transcript(transcript: models.StoredTranscript) -> str:
  """Formats a stored transcript as one `[start - end] text` line per line.

  Args:
    transcript: The transcript extracted by the first analysis.

  Returns:
    The transcript text, one caption line per text line, in order.
  """
  words = transcript.words
  starts = list(transcript.line_start_indices) or ([0] if words else [])
  lines = []
  for position, begin in enumerate(starts):
    end = starts[position + 1] if position + 1 < len(starts) else len(words)
    chunk = words[begin:end]
    if not chunk:
      continue
    text = ' '.join(word.text for word in chunk)
    time_label = (
        f'{chunk[0].start_sec:.1f}s - {chunk[-1].end_sec:.1f}s '
        f'({clock(chunk[0].start_sec)})'
    )
    lines.append(f'[{time_label}] {text}')
  return '\n'.join(lines)


TUNED_SECTION_HEADER = '[YouTube 데이터 기반 맞춤 지시]'


def format_retention(
    context: models.YouTubeVideoContext | None,
    editorial_prompt: str = '',
) -> list[str]:
  """Formats YouTube Analytics retention, chapters, and comments for prompt."""
  if context is None or (
      not context.retention_peaks
      and not context.comments
      and not context.chapters
      and not context.channel_shorts
  ):
    return []
  has_tuned_prompt = TUNED_SECTION_HEADER in editorial_prompt
  lines = []
  if not has_tuned_prompt:
    lines = [
        '',
        '# YouTube Audience Retention & Comments (시청자 유지율 및 댓글 데이터)',
    ]
    if context.chapters:
      lines.append(
          '[롱폼 설명란 챕터 목차] '
          '원본 영상 설명란에 적힌 챕터 구분입니다. 각 챕터의 주제 전환과 '
          '구간 경계를 시나리오 기획과 클립 선별에 참고하세요:'
      )
      for idx, chapter in enumerate(context.chapters[:25]):
        end_part = (
            f' ~ {clock(context.chapters[idx + 1].start_sec)}'
            if idx + 1 < len(context.chapters)
            else ''
        )
        lines.append(
            f'- [{chapter.start_sec:.1f}s ({clock(chapter.start_sec)}'
            f'{end_part})]: {chapter.title}'
        )
    if context.retention_peaks:
      lines.append(
          '[많이 본 구간 — 우선 선별] '
          '시청자가 이탈하지 않고 집중하거나 반복 시청한 아래 피크 구간을 '
          '우선적으로 Shorts의 핵심 Clip이나 첫 도입부(Hook)로 선별하고, 선정 '
          '이유(rationale)와 클립 목적(purpose)에 시청 유지율 근거를 함께 '
          '적으세요:'
      )
      for idx, span in enumerate(context.retention_peaks, start=1):
        lines.append(
            f'- 피크 {idx} [{span.start_sec:.1f}s - {span.end_sec:.1f}s '
            f'({clock(span.start_sec)} ~ {clock(span.end_sec)})]: '
            f'시청 유지율 {span.watch_ratio:.0%}, '
            f'상대적 유지 성과 {span.relative_performance:.0%} ({span.label})'
        )
    if context.comments:
      lines.append(
          '[실제 시청자 댓글 반응] '
          '시청자들이 공감하거나 타임스탬프로 언급한 포인트입니다. '
          '타임스탬프는 클립 구간 선별에만 참고하고, 실제 댓글의 생생한 반응과 '
          '어휘를 Shorts 제목(title)과 상단 헤드라인의 훅(Hook) 문구로 적극 '
          '활용하세요(단, 00:14 같은 타임스탬프는 제목·헤드라인에 넣지 마세요):'
      )
      for comment in context.comments[:8]:
        snippet = ' '.join(comment.text.splitlines())[:140]
        ts_tag = (
            f' [{clock(comment.timestamp_sec)} 언급]'
            if comment.timestamp_sec is not None
            else ''
        )
        lines.append(
            f'- ({comment.author}, 좋아요 {comment.like_count}){ts_tag}: '
            f'{snippet}'
        )
  if context.channel_shorts and '[채널 기존 Shorts 성과' not in editorial_prompt:
    if not lines:
      lines = ['', '# YouTube Channel Shorts Performance (채널 Shorts 성과)']
    lines.append(
        '[채널 기존 Shorts 성과 (피드백 루프)] '
        '이 채널에서 반응이 좋았던 기존 Shorts의 제목·길이·시청 지속률 '
        '패턴입니다. 성과가 검증된 훅 스타일, 제목 길이, 호흡을 시나리오 '
        '기획과 헤드라인 작성에 반영하세요:'
    )
    for idx, stat in enumerate(context.channel_shorts[:8], start=1):
      dur = f', 길이 {stat.duration_sec:.0f}초' if stat.duration_sec > 0 else ''
      avd = (
          f', 평균 시청 {stat.average_view_duration_sec:.1f}초'
          if stat.average_view_duration_sec > 0
          else ''
      )
      avp = (
          f' ({stat.average_view_percentage:.0f}%)'
          if stat.average_view_percentage > 0
          else ''
      )
      subs = (
          f', 구독 +{stat.subscribers_gained}'
          if stat.subscribers_gained > 0
          else ''
      )
      lines.append(
          f'- Shorts {idx} "{stat.title}" (조회수 {stat.views:,}회{dur}'
          f'{avd}{avp}, 좋아요 {stat.likes:,}{subs})'
      )
  return lines


def build_request_text(
    kind: str,
    source: models.SourceVideo,
    editorial_prompt: str,
    transcript: models.StoredTranscript | None,
    inline_schema: dict[str, Any] | None,
    youtube_context: models.YouTubeVideoContext | None = None,
) -> str:
  """Builds the user turn of one director request.

  Args:
    kind: The director's request kind, 'initial', 'fast' or 'deep' (see the
      module docstring). Every kind but 'initial' attaches the transcript.
    source: The Source Video metadata.
    editorial_prompt: The user's Editorial Prompt.
    transcript: The full transcript stored by the first analysis; None
      during that one.
    inline_schema: The response schema to spell out in text when the API
      call cannot enforce it as structured output, else None.
    youtube_context: Optional YouTube retention and caption data.

  Returns:
    The prompt text.
  """
  lines = [
      '# Editorial Prompt',
      editorial_prompt.strip(),
      '',
      '# Source Video',
      f'title: {source.title}',
      f'duration: {clock(source.duration_sec)} ({source.duration_sec:.1f}s)',
      *format_retention(youtube_context, editorial_prompt),
      '',
      '# Transcript',
      _INSTRUCTIONS[kind],
  ]
  if kind != 'initial':
    lines.append(format_transcript(transcript))
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


def _object(properties: dict[str, Any]) -> dict[str, Any]:
  """Returns an object schema whose properties are all required."""
  return {
      'type': 'object',
      'properties': properties,
      'required': list(properties),
  }


def response_schema(
    include_transcript: bool = True, include_framing: bool = True
) -> dict[str, Any]:
  """Returns the JSON Schema of the director's answer.

  Clips are ranges in seconds. The first analysis also returns the timed
  transcription of the whole video; a fast re-analysis, which never sees
  the picture, returns no framing.

  Args:
    include_transcript: Whether the answer carries transcriptLines.
    include_framing: Whether each scenario carries a framingLayout crop.

  Returns:
    The JSON Schema.
  """
  clip_properties: dict[str, Any] = {
      'startSec': {'type': 'number'},
      'endSec': {'type': 'number'},
      'speaker': _string(),
      'purpose': _string('Why this clip is in the scenario.'),
  }
  scenario_properties: dict[str, Any] = {
      'title': _string(
          'Catchy YouTube Shorts title ready for upload (no timestamps).'
      ),
      'rationale': _string(),
      'thumbnailSec': {
          'type': 'number',
          'description': (
              'Source video timestamp in seconds (inside one of the scenario '
              'clips) for the recommended thumbnail frame.'
          ),
      },
      'headline': _object(
          {
              'lines': {
                  'type': 'array',
                  'items': _string(
                      'One short, punchy on-screen headline line (first line '
                      'is highlighted; never include timestamps).'
                  ),
              },
          }
      ),
  }
  if include_framing:
    centers = {
        key: {'type': 'number', 'minimum': 0.0, 'maximum': 1.0}
        for key in ('centerX', 'centerY')
    }
    scenario_properties['framingLayout'] = _object({'crop': _object(centers)})
  scenario_properties['clips'] = {
      'type': 'array',
      'items': _object(clip_properties),
  }
  scenario = _object(scenario_properties)
  # The UI does not show videoSummary or speakers; they stay so the answer
  # keeps the shape of the earlier verified runs.
  properties: dict[str, Any] = {
      'videoSummary': _string(),
      'speakers': {'type': 'array', 'items': _string()},
  }
  if include_transcript:
    properties['transcriptLines'] = {
        'type': 'array',
        'description': (
            'Complete verbatim transcription of the entire video from 0.0s '
            'to the end, including all speech outside the selected clips.'
        ),
        'items': _object(
            {
                'startSec': {'type': 'number'},
                'endSec': {'type': 'number'},
                'text': _string(),
            }
        ),
    }
  properties['scenarios'] = {'type': 'array', 'items': scenario}
  return _object(properties)
