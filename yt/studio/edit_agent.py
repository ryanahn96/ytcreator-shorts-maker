"""말로 편집 (Edit Agent): turns one Edit Request into edit operations.

One Edit Request is one Gemini call with structured output and LOW
thinking (ADR 0011). The browser sends the Shorts on screen, the selected
Clip, the playhead and the conversation of this editor session; the server
adds the stored full transcript with word numbers, the audience data, the
uploaded files and the bundled fonts. Gemini answers with a list of edit
operations and a one-line reply. check_answer validates every operation
against the state that was sent and the limits of the render models:
out-of-range values move to the nearest allowed value, operations it does
not know are dropped, and what it changed or skipped is reported as Korean
notes. The browser then applies the operations as one undo step
(frontend/src/lib/editAgent.ts).

Clips are named by their Clip Number on screen when the request was sent;
the browser maps those numbers back to Clip ids, so this module never needs
ids and keeps no editor state.
"""

from __future__ import annotations

import bisect
from collections.abc import Callable, Iterable
import dataclasses
import json
import math
import string
from typing import Any, ClassVar, NamedTuple

from google.genai import types
import pydantic

from yt.studio import config
from yt.studio import director
from yt.studio import fonts
from yt.studio import gemini
from yt.studio import layout
from yt.studio import models

# Answers longer than this are cut; one request rarely needs more.
_MAX_OPERATIONS = 60
_MAX_REPLY_CHARS = 300
# The conversation sent back to the model: the latest turns, each with its
# operations as JSON cut to this many characters.
_HISTORY_TURNS = 10
_HISTORY_OPS_CHARS = 1500
# Words one operation may name, and Headline lines one patch may hold.
_MAX_WORDS = 2000
_MAX_HEADLINE_LINES = 10
_MAX_TEXT_CHARS = 500
_COMMENTS = 8
# Limits of the hand controls the operations stand in for.
_IMAGE_CLIP_SEC = (0.5, 60.0)
_DEFAULT_IMAGE_CLIP_SEC = 3.0
_DEFAULT_VIDEO_CLIP_SEC = 10.0
_UNKNOWN_VIDEO_CLIP_SEC = 5.0
_MIN_IMAGE_WIDTH = 24.0
_MAX_IMAGE_WIDTH_RATIO = 1.5
# The shortest video box side a drag allows (MIN_VIDEO_BOX in
# frontend/src/lib/framing.ts); stricter than models.VideoBoxSpec.
_MIN_VIDEO_BOX = 120.0
_CAPTION_MAX_CHARS = (4, 40)
_PLACES = ('first', 'last', 'before', 'after')
_EDGES = ('start', 'end')
_TARGETS = ('shared', 'clip')
# Operations on Transcript Words; they apply to the current Shorts only.
_WORD_OPS = frozenset(
    {'setWordText', 'setLineText', 'resetWordText', 'cutWords', 'restoreWords'}
)
_KIND_LABELS = {'image': '이미지', 'audio': '음악', 'video': '영상'}
# On 25 test requests (2026-10-09) LOW thinking gave the same verdicts as
# the model default at a median 3.3 s instead of 7.6 s per answer.
_THINKING = types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW)

SYSTEM_INSTRUCTION = """\
당신은 세로 Shorts 편집기의 '말로 편집' 도우미입니다. 사용자가 말이나 글로 \
건넨 편집 요청 하나를 알아듣고, 지금 보고 있는 Shorts 하나의 편집 값을 \
바꾸는 편집 동작 목록(operations)과 한 줄 답장(reply)을 돌려줍니다. \
브라우저는 받은 동작을 바로 한 단계로 적용하고, 사용자는 되돌리기로 언제든 \
취소할 수 있습니다.

[할 수 있는 일]
- 사람이 편집 화면에서 손으로 바꿀 수 있는 값은 모두 바꿉니다: 클립 구간, \
순서, 나누기, 지우기, 추가, 삽입 클립 길이와 음소거, 스타일 전체(헤드라인 \
줄, 영상 배치, 색, 글꼴, 글 위치), 이미지, 배경음악과 볼륨, 자막 글자, 단어 \
지우기와 살리기, 자막 줄 글자 수, 처음 제안으로 되돌리기.
- 대본과 시청자 반응을 보고 구간을 고르는 요청도 받습니다.
- 이미 올린 파일은 '올린 파일'의 파일 이름으로 씁니다.

[하지 않는 일]
아래 요청에는 operations를 비우고 할 수 없는 이유를 reply에 적습니다.
- 다시 분석, MP4 만들기, YouTube 업로드, 새 파일 올리기. 새 파일은 사용자가 \
직접 올립니다.
- 영상 그림을 봐야 하는 편집. 예: 얼굴에 맞춰 자르기, 슬라이드가 나오는 \
장면 찾기. 당신은 영상을 보지 못하고 대본과 숫자만 압니다.
- 화면에 없는 값: Shorts 제목(탭과 파일 이름), 무음 기준, 템플릿, '글꼴'에 \
없는 글꼴. 다만 "제목 글씨"처럼 영상 위에 보이는 글을 말하는 게 분명하면 \
헤드라인을 바꿉니다.
- 마지막 남은 클립 지우기.
- 다른 Shorts나 모든 Shorts를 바꾸는 요청. 지금 보고 있는 Shorts만 고칠 수 \
있다고 답합니다.

[대상]
- 대상을 말하지 않은 스타일 요청은 공통 스타일(target "shared")을 \
바꿉니다. 자기 스타일이 있는 클립에도 같은 항목이 함께 바뀝니다.
- "이 클립"은 고른 클립이고, "여기", "여기서부터"는 재생 위치입니다.
- "2번 클립", "이 클립만"처럼 클립을 집어 스타일을 바꾸라고 하면 target \
"clip"과 clip 번호로 그 클립만 바꿉니다. 그 클립은 자기 스타일을 갖게 \
됩니다.
- 클립 번호는 '클립' 목록의 번호입니다. 한 요청 안의 번호는 모두 요청을 \
보낸 순간의 번호입니다. 앞 동작이 순서를 바꾸거나 클립을 지워도 번호를 \
고쳐 쓰지 않습니다. 이번 요청에서 새로 넣는 클립은 번호로 가리킬 수 \
없습니다.
- "그 클립", "아까 그거"는 '대화'에서 찾습니다.

[해석]
- 숫자를 말하면 그대로 씁니다. 내용으로 가리키면(예: "'Celia' 나오는 \
문장부터 시작") 대본의 단어 번호로 단어나 줄 경계에 맞춥니다.
- 초 단위 시간을 단어 번호로 쓰지 않습니다. 어떤 초에 맞는 단어 번호는 \
'시청자 반응'에 함께 적힌 단어 번호나 대본 줄 앞의 시작 초로 찾습니다.
- 조금, 보통, 많이의 기본값은 크기 10, 20, 40%, 위치 40, 100, 200 캔버스 \
단위, 시간 0.5, 1, 2초입니다. 정도를 말하지 않으면 보통입니다. "조금 더"는 \
직전 변화량을 한 번 더 줍니다.
- 크기를 비율로 바꿀 때는 지금 값에 곱해 반올림합니다. 예: 84를 20% \
키우면 101.
- "N초 늦게 시작", "앞을 N초 잘라"는 시작만 옮깁니다(moveClipEdge, edge \
"start"). "N초 줄여", "N초 늘려"는 끝만 옮깁니다(moveClipEdge, edge "end", \
deltaSec -N 또는 +N). "N초 뒤로 옮겨"는 길이를 지킨 채 통째로 \
옮깁니다(shiftClip). setClipDuration은 "5초로"처럼 길이를 정해 줄 때만 \
씁니다.
- "많이 본 구간"은 '시청자 반응'의 많이 본 구간에서 고릅니다. 새 클립으로 \
넣을 때는 지금 클립과 겹치지 않는 구간 중 상대적 유지 성과가 가장 높은 \
구간을 고르고, 그 안에서 지금 클립들과 비슷한 길이로 문장 경계에 맞춰 \
startWord와 endWord를 고릅니다. 댓글은 사용자가 댓글을 말할 때 근거로 \
씁니다.
- "맨 앞으로", "3번 뒤로"는 끼워 넣기 이동(moveClip)입니다. "바꿔"라고 할 \
때만 맞바꿉니다(swapClips).
- 헤드라인 색을 줄을 정하지 않고 바꾸라고 하면 accentColor와 color를 함께 \
바꿉니다. 첫 줄은 accentColor, 나머지 줄은 color로 그립니다.
- 캔버스 좌표는 왼쪽 위가 (0, 0)이고 오른쪽과 아래로 커집니다. "위로"는 \
y를 줄이고 "오른쪽으로"는 x를 늘립니다.
- 대상을 찾지 못하거나 할 수 없는 요청일 때만 되묻고 operations를 \
비웁니다. 나머지는 가장 그럴듯하게 적용하고 어떻게 해석했는지 reply에 \
적습니다.

[값]
- 시간은 원본 영상의 초(예: 75.2)입니다. 삽입 영상 클립의 구간은 그 영상 \
파일 안의 초입니다.
- 색은 #RRGGBB, 글꼴은 '글꼴'의 fontId입니다.
- 범위: 글자 크기 16~200, 외곽선 0~12, 테두리 두께 0~40, 글 배경 불투명도 \
0~1, 영상 확대 1~4, 초점 0~1, 영상 박스 너비와 높이 120 이상(박스 전체가 \
캔버스 안), 이미지 너비 24~1620, 회전 -180~180, 음악 볼륨 0~1(0.5가 50%), \
자막 줄 글자 수 4~40, 이미지 클립 0.5~60초. 범위를 넘으면 가장 가까운 \
값으로 맞춰집니다.
- look에는 바꿀 항목만 '공통 스타일'과 같은 키 순서로 넣습니다. 나머지 \
값은 그대로 남습니다.
- 자막 글자와 단어 동작은 지금 Shorts 클립 안의 단어에만 씁니다. 같은 \
단어가 들어간 다른 Shorts에도 똑같이 보입니다.

[답장]
- reply는 한국어 한 줄로 80자 안팎입니다. 바꾼 값을 "84→101"처럼 적고, \
해석이 필요했으면 어떻게 해석했는지 적습니다.
- reply는 "바꿨어요", "없어요"처럼 해요체로 끝냅니다. "~습니다", \
"~입니다"로 끝내지 않습니다.
- 시청자 데이터를 근거로 들 때는 적힌 초와 수치를 그대로 옮깁니다. 적혀 \
있지 않은 시각이나 댓글은 지어내지 않습니다.
- 질문은 되물을 때만 합니다.
- '대화'에서 (되돌림)이 붙은 요청은 사용자가 되돌린 편집이라 지금 상태에 \
없습니다.

[동작]
각 동작에는 op와 그 동작에 필요한 필드만 아래에 적은 순서대로 씁니다.
- setClipRange{clip, startSec, endSec}: 클립 구간을 정합니다.
- setClipEdge{clip, edge, word 또는 atSec}: 클립이 그 단어에서 \
시작하거나(edge "start") 끝나게(edge "end") 합니다. 반대쪽 끝을 넘어가면 \
길이를 지킨 채 옮겨집니다.
- moveClipEdge{clip, edge, deltaSec}: 한쪽 끝만 옮깁니다. +는 뒤, -는 \
앞입니다.
- shiftClip{clip, deltaSec}: 길이를 지킨 채 통째로 옮깁니다.
- setClipDuration{clip, durationSec}: 시작은 두고 길이를 정합니다. 이미지 \
클립은 보여 주는 시간입니다.
- splitClip{clip, word 또는 atSec}: 원본 클립을 그 단어 앞에서 둘로 \
나눕니다.
- deleteClip{clip}
- moveClip{clip, place, otherClip}: place는 first, last, before, after이고 \
before와 after에는 otherClip이 필요합니다.
- swapClips{clip, otherClip}
- addSourceClip{startWord와 endWord 또는 startSec와 endSec, place, \
otherClip}: 원본 구간을 새 클립으로 넣습니다. place가 없으면 고른 클립 \
뒤에 들어갑니다.
- addMediaClip{file, durationSec, startSec, endSec, place, otherClip}: 올린 \
이미지나 영상을 삽입 클립으로 넣습니다. 영상의 일부만 쓰려면 startSec와 \
endSec를 씁니다.
- setClipMute{clip, mute}: 삽입 영상 클립의 소리를 끄거나 켭니다.
- patchLook{target, clip, look}: 스타일 일부를 바꿉니다. 영상 박스를 \
템플릿 기본으로 되돌리려면 look.framingLayout.defaultBox를 true로 씁니다.
- setOwnLook{clip, own}: own이 true면 그 클립이 공통 스타일을 복사한 자기 \
스타일을 갖고, false면 공통 스타일로 돌아갑니다.
- addImage{file, target, clip, x, y, width, rotationDeg}: 올린 이미지를 \
화면에 얹습니다. x, y는 이미지 가운데이고 높이는 비율대로 정해집니다.
- updateImage{imageId, target, clip, x, y, width, rotationDeg}
- removeImage{imageId, target, clip}
- setWordText{word, text}: 단어 하나의 자막 글자를 바꿉니다. 빈 글자는 그 \
단어 자막을 숨깁니다.
- setLineText{startWord, endWord, text}: 단어 구간의 자막을 새 글로 \
바꿉니다.
- resetWordText{words}: 고친 자막 글자를 원래대로 돌립니다.
- cutWords{words}: 단어를 지웁니다. 소리와 자막이 함께 빠집니다.
- restoreWords{words}: 지운 단어를 살립니다.
- setCaptionMaxChars{maxChars}: 자막 한 줄 글자 수를 정합니다.
- setMusic{file, volume}: 배경음악을 정합니다.
- setMusicVolume{volume}
- removeMusic{}
- resetShorts{}: 이 Shorts의 클립, 스타일, 음악을 Gemini가 처음 제안한 \
대로 되돌립니다. 자막 글자와 지운 단어는 그대로입니다.
words 대신 word 하나나 startWord와 endWord 구간을 써도 됩니다.
"""


class EditTurn(models.StudioModel):
  """An earlier Edit Request of this editor session."""

  request: str
  reply: str = ''
  operations: list[dict[str, Any]] = pydantic.Field(default_factory=list)
  # Whether the user undid the edits of this turn.
  undone: bool = False


class EditRequest(models.StudioModel):
  """Request body of the edit endpoint: one Edit Request and its context."""

  source_id: str = pydantic.Field(min_length=1)
  request: str = pydantic.Field(min_length=1, max_length=2000)
  # The Shorts on screen when the request was sent.
  scenario: models.Scenario
  shorts_number: int = pydantic.Field(ge=1)
  shorts_count: int = pydantic.Field(ge=1)
  # Clip Number (from 1) of the selected Clip; None when there is none.
  clip_number: int | None = None
  # Source Video second under the playhead; None over an inserted clip.
  playhead_sec: float | None = None
  source_duration_sec: float = pydantic.Field(default=0.0, ge=0.0)
  # Transcript-wide caption edits (word index -> caption text).
  cut_words: list[int] = pydantic.Field(default_factory=list)
  word_text: dict[int, str] = pydantic.Field(default_factory=dict)
  caption_max_chars: int = config.COMPOSITION.caption_max_chars
  assets: list[models.UploadedAsset] = pydantic.Field(default_factory=list)
  history: list[EditTurn] = pydantic.Field(default_factory=list)


class EditResponse(models.StudioModel):
  """The checked operations of one Edit Request and the reply to show."""

  reply: str
  operations: list[dict[str, Any]]
  # Values the server moved into range and operations it skipped.
  notes: list[str] = pydantic.Field(default_factory=list)


# --------------------------------------------------------------------------
# Loose readers (the answer is untrusted input)
# --------------------------------------------------------------------------


def _number(value: Any) -> float | None:
  """Reads a finite number, also from a numeric string."""
  if value is None or isinstance(value, bool):
    return None
  if isinstance(value, (int, float)):
    number = float(value)
  elif isinstance(value, str):
    try:
      number = float(value.strip().removesuffix('%'))
    except ValueError:
      return None
  else:
    return None
  return number if math.isfinite(number) else None


def _fraction(value: Any) -> float | None:
  """Reads a 0..1 ratio; '%'-suffixed strings or whole 2..100 count as %."""
  number = _number(value)
  if number is None:
    return None
  if isinstance(value, str) and value.strip().endswith('%'):
    return number / 100.0
  if 1.0 < number <= 100.0 and abs(number - round(number)) <= 1e-6:
    return number / 100.0
  return number


def _integer(value: Any) -> int | None:
  """Reads a whole number; 3.0 counts, 3.5 does not."""
  number = _number(value)
  if number is None or abs(number - round(number)) > 1e-6:
    return None
  return round(number)


def _seconds(value: Any) -> float | None:
  """Reads seconds: a number, "75.2s", "01:15.2" or "1:01:15"."""
  if isinstance(value, str) and ':' in value:
    sign = -1.0 if value.strip().startswith('-') else 1.0
    parts = value.strip().lstrip('+-').removesuffix('s').split(':')
    numbers = [_number(part) for part in parts]
    if len(numbers) not in (2, 3) or any(part is None for part in numbers):
      return None
    total = 0.0
    for part in numbers:
      total = total * 60.0 + (part or 0.0)
    return sign * total
  if isinstance(value, str):
    value = value.strip().removesuffix('s').removesuffix('초')
  return _number(value)


def _clamp(value: float, low: float, high: float) -> float:
  return min(max(value, low), high)


def _ms(seconds: float) -> float:
  return round(seconds, 3)


def _half_up(value: float) -> int:
  """Rounds .5 away from zero, as people do (Python's round() does not)."""
  return math.floor(abs(value) + 0.5) * (1 if value >= 0 else -1)


def _sec_text(seconds: float) -> str:
  """Seconds to the millisecond without trailing zeros, e.g. '36.04'.

  The prompt states times this exactly: one decimal made a 5.44 s Clip
  read as 5.4 s, so "1초 줄여" cut 1.04 s.
  """
  return f'{seconds:.3f}'.rstrip('0').rstrip('.')


def _hex_color(value: Any) -> str | None:
  """Returns '#RRGGBB' for '#RRGGBB', '#RGB' or the digits alone."""
  if not isinstance(value, str):
    return None
  digits = value.strip().removeprefix('#')
  if len(digits) == 3:
    digits = ''.join(char * 2 for char in digits)
  if len(digits) != 6 or any(char not in string.hexdigits for char in digits):
    return None
  return '#' + digits.upper()


def _font_id(value: Any) -> str | None:
  """Maps a font id, label or family (or a unique part of one) to its id."""
  key = director.clean_text(value).casefold()
  if not key:
    return None
  for font in fonts.FONTS:
    names = (font.font_id, font.label, font.family)
    if key in (name.casefold() for name in names):
      return font.font_id
  matches = [
      font.font_id
      for font in fonts.FONTS
      if key in font.label.casefold() or key in font.family.casefold()
  ]
  return matches[0] if len(matches) == 1 else None


def _find_file(
    name: str, assets: Iterable[models.UploadedAsset]
) -> models.UploadedAsset | None:
  """Finds an uploaded file by name, then case, stem or a unique part."""
  candidates = list(assets)[::-1]  # The newest upload wins a tie.
  key = name.strip().casefold()

  def stem(filename: str) -> str:
    return filename.rsplit('.', 1)[0].casefold()

  for matches in (
      lambda asset: asset.filename == name.strip(),
      lambda asset: asset.filename.casefold() == key,
      lambda asset: stem(asset.filename) == stem(key),
  ):
    found = [asset for asset in candidates if matches(asset)]
    if found:
      return found[0]
  partial = [
      asset
      for asset in candidates
      if key in asset.filename.casefold() or stem(asset.filename) in key
  ]
  return partial[0] if len(partial) == 1 else None


# --------------------------------------------------------------------------
# Style patches
# --------------------------------------------------------------------------

_GROUP_LABELS = {
    'headline': '헤드라인',
    'caption': '자막',
    'box': '영상 박스',
    'crop': '영상',
}
_LEAF_LABELS = {
    'size': '글자 크기',
    'outlineWidth': '외곽선 두께',
    'backgroundOpacity': '글 배경 불투명도',
    'borderWidth': '테두리 두께',
    'zoom': '확대',
    'centerX': '가로 초점',
    'centerY': '세로 초점',
    'x': '가로 위치',
    'y': '세로 위치',
    'width': '너비',
    'height': '높이',
}
# The (low, high) range of each number a patch's crop, video box and text
# positions may hold: models.Look's limits, but a video box side may not go
# under the hand controls' minimum.
_CROP_RANGES = {
    'centerX': (0.0, 1.0),
    'centerY': (0.0, 1.0),
    'zoom': (1.0, models.MAX_CROP_ZOOM),
}
_BOX_RANGES = {
    'x': (0.0, math.inf),
    'y': (0.0, math.inf),
    'width': (_MIN_VIDEO_BOX, math.inf),
    'height': (_MIN_VIDEO_BOX, math.inf),
}
_PLACEMENT_RANGES = {'x': (-math.inf, math.inf), 'y': (-math.inf, math.inf)}


def _label(path: tuple[str, ...]) -> str:
  groups = [_GROUP_LABELS[part] for part in path[:-1] if part in _GROUP_LABELS]
  return ' '.join([*groups, _LEAF_LABELS.get(path[-1], path[-1])])


class _LookPatcher:
  """Cleans a partial Look from the answer and fits it to the Look limits.

  The patch keeps only the keys the answer gave, with the types the Look
  models use. A number past a limit of models.Look, the model the render
  plan uses, moves to that limit with a note, and a video box side under
  the hand controls' minimum grows to it. The minimum holds for every Look
  the patch reaches. Whether the box stays inside the canvas depends on
  the keys each Look completes it with, so the browser checks that per
  Look (clampVideoBox in frontend/src/lib/framing.ts) and notes it when it
  moves a value.
  """

  def __init__(self, note: Callable[[str], None]) -> None:
    self._note = note

  def clean(self, raw: Any) -> dict[str, Any]:
    """Returns the checked patch; empty when nothing usable is left."""
    return self._typed(director.as_dict(raw))

  def _numbers(
      self, raw: Any, group: str, ranges: dict[str, tuple[float, float]]
  ) -> dict[str, float]:
    """Reads the numbers `ranges` names, each moved into its range."""
    data = director.as_dict(raw)
    picked = {key: _number(data.get(key)) for key in ranges}
    return {
        key: self._bounded((group, key), value, *ranges[key])
        for key, value in picked.items()
        if value is not None
    }

  def _color(self, data: dict[str, Any], key: str, out: dict[str, Any]) -> None:
    if data.get(key) is None:
      return
    color = _hex_color(data[key])
    if color is None:
      self._note(f'색 값을 알아듣지 못해 그대로 뒀어요: {data[key]!r}')
    else:
      out[key] = color

  def _text_style(self, raw: Any, group: str) -> dict[str, Any]:
    """Reads a partial Text Style of `group`, 'headline' or 'caption'.

    Sizes and outline widths are rounded half up to whole numbers, and an
    opacity in 2..100 (or with '%') is read as a percentage; each then
    moves into its range. accentColor is read for the Headline only. A
    font or color it does not know is left out with a note.
    """
    data = director.as_dict(raw)
    out: dict[str, Any] = {}
    if data.get('fontId') is not None:
      font_id = _font_id(data['fontId'])
      if font_id is None:
        self._note(
            f'{data["fontId"]!r} 글꼴은 쓸 수 있는 글꼴이 아니라 그대로 뒀어요.'
        )
      else:
        out['fontId'] = font_id
    for key, low, high in (
        ('size', models.MIN_TEXT_SIZE, models.MAX_TEXT_SIZE),
        ('outlineWidth', 0, models.MAX_TEXT_OUTLINE),
    ):
      value = _number(data.get(key))
      if value is not None:
        out[key] = self._bounded((group, key), _half_up(value), low, high)
    opacity = _fraction(data.get('backgroundOpacity'))
    if opacity is not None:
      out['backgroundOpacity'] = self._bounded(
          (group, 'backgroundOpacity'), opacity, 0.0, 1.0
      )
    if isinstance(data.get('background'), bool):
      out['background'] = data['background']
    keys = ('color', 'outlineColor', 'backgroundColor')
    for key in (*keys, 'accentColor') if group == 'headline' else keys:
      self._color(data, key, out)
    return out

  def _bounded(
      self, path: tuple[str, ...], value: float, low: float, high: float
  ) -> float:
    """Returns `value` moved into low..high, noting it if it moved."""
    bounded = _clamp(value, low, high)
    if bounded != value:
      self._note(
          f'{_label(path)} 값은 허용 범위 밖이라 {bounded:g}에 맞췄어요.'
      )
    return bounded

  def _typed(self, data: dict[str, Any]) -> dict[str, Any]:
    """Keeps the Look keys of a raw patch, with the types the models use.

    Args:
      data: The look object of a patchLook operation.

    Returns:
      The typed patch in the key order of Look.to_json; empty when the
      answer gave nothing usable. defaultBox wins over a box given with it.
    """
    patch: dict[str, Any] = {}
    lines = director.as_dict(data.get('headline')).get('lines')
    if isinstance(lines, list):
      patch['headline'] = {
          'lines': [
              line.strip()[:_MAX_TEXT_CHARS]
              for line in lines
              if isinstance(line, str)
          ][:_MAX_HEADLINE_LINES]
      }
    framing = director.as_dict(data.get('framingLayout'))
    framing_patch: dict[str, Any] = {}
    if framing.get('fit') in ('box', 'full'):
      framing_patch['fit'] = framing['fit']
    crop = self._numbers(framing.get('crop'), 'crop', _CROP_RANGES)
    if crop:
      framing_patch['crop'] = crop
    if framing.get('defaultBox') is True:
      framing_patch['defaultBox'] = True
    else:
      box = self._numbers(framing.get('box'), 'box', _BOX_RANGES)
      if box:
        framing_patch['box'] = box
    if framing_patch:
      patch['framingLayout'] = framing_patch
    text_layout = director.as_dict(data.get('textLayout'))
    layout_patch = {
        key: self._numbers(text_layout.get(key), key, _PLACEMENT_RANGES)
        for key in ('headline', 'caption')
    }
    layout_patch = {key: value for key, value in layout_patch.items() if value}
    if layout_patch:
      patch['textLayout'] = layout_patch
    style = director.as_dict(data.get('style'))
    style_patch: dict[str, Any] = {}
    for key in ('backgroundColor', 'borderColor'):
      self._color(style, key, style_patch)
    if isinstance(style.get('border'), bool):
      style_patch['border'] = style['border']
    border_width = _number(style.get('borderWidth'))
    if border_width is not None:
      style_patch['borderWidth'] = self._bounded(
          ('borderWidth',), _half_up(border_width), 0, models.MAX_BORDER_WIDTH
      )
    for key in ('headline', 'caption'):
      text_style = self._text_style(style.get(key), key)
      if text_style:
        style_patch[key] = text_style
    if style_patch:
      patch['style'] = style_patch
    return patch


# --------------------------------------------------------------------------
# Operations
# --------------------------------------------------------------------------


class _OpSpec(NamedTuple):
  """An operation's Korean label and its _Checker handler."""

  label: str
  check: Callable[[Any, dict[str, Any]], dict[str, Any] | None]


class _Checker:
  """Checks the operations of one answer against the state that was sent.

  Clip numbers stay the ones on screen when the request was sent, so every
  check looks at the sent Scenario. Only the number of Clips is tracked
  through the answer, to keep the last Clip from being deleted.

  Each operation handler takes the raw operation and returns it in the
  browser's shape (frontend/src/lib/editAgent.ts) with values moved into
  range, or None after noting why it skipped the operation.
  """

  def __init__(
      self,
      request: EditRequest,
      transcript: models.StoredTranscript | None,
  ) -> None:
    """Prepares the checks for one answer.

    Args:
      request: The Edit Request with the state it was sent from.
      transcript: The stored full transcript; None when there is none, in
        which case every operation that names a word is skipped.
    """
    settings = config.get_settings()
    self._request = request
    self._scenario = request.scenario
    self._clips = request.scenario.clips
    self._words = list(transcript.words) if transcript else []
    self._by_index = {word.index: word for word in self._words}
    self._canvas = settings.template_style
    self._min_sec = config.COMPOSITION.min_subcut_sec
    self._duration = request.source_duration_sec or max(
        (word.end_sec for word in self._words), default=math.inf
    )
    self._assets = {asset.asset_id: asset for asset in request.assets}
    self.notes: list[str] = []
    self._looks = _LookPatcher(self.note)
    self._count = len(self._clips)
    self._deleted: set[int] = set()
    self._has_music = request.scenario.music is not None
    # Source Video spans of this Shorts, for the word operations.
    self._spans = [
        (clip.start_sec, clip.end_sec)
        for clip in self._clips
        if clip.media_kind == 'source'
    ]

  def note(self, text: str) -> None:
    if text not in self.notes:
      self.notes.append(text)

  def check(self, raw_operations: list[Any]) -> list[dict[str, Any]]:
    """Returns the usable operations, in order, in the browser's shape."""
    checked: list[dict[str, Any]] = []
    unknown = 0
    for raw in raw_operations:
      data = director.as_dict(raw)
      name = data.get('op')
      if not isinstance(name, str) or name not in self.OPS:
        unknown += 1
        continue
      operation = self.OPS[name].check(self, data)
      if operation is not None:
        checked.append(operation)
    if unknown:
      self.note(f'알 수 없는 동작 {unknown}개는 버렸어요.')
    return self._inside_shorts(checked)

  # -- Shared readers -----------------------------------------------------

  def _skip(self, data: dict[str, Any], reason: str) -> None:
    self.note(f'{self.OPS[data["op"]].label}: {reason} 건너뛰었어요.')

  def _clip(
      self, data: dict[str, Any], key: str = 'clip'
  ) -> tuple[int, models.Clip] | None:
    """Reads a Clip Number of the sent Shorts; skips the operation if bad.

    Args:
      data: The raw operation.
      key: The field holding the number, 'clip' or 'otherClip'.

    Returns:
      The number and the Clip as sent, or None when the number is missing,
      out of range or names a Clip an earlier operation deleted.
    """
    number = _integer(data.get(key))
    if number is None:
      self._skip(data, '클립 번호가 없어서')
      return None
    if not 1 <= number <= len(self._clips):
      self._skip(data, f'{number}번 클립이 없어서')
      return None
    if number in self._deleted:
      self._skip(data, f'{number}번 클립은 앞에서 지워서')
      return None
    return number, self._clips[number - 1]

  def _word(
      self, data: dict[str, Any], key: str
  ) -> models.TranscriptWord | None:
    index = _integer(data.get(key))
    word = self._by_index.get(index) if index is not None else None
    if word is None:
      self._skip(data, '대본에 그 단어 번호가 없어서')
    return word

  def _edge(self, data: dict[str, Any]) -> str | None:
    edge = data.get('edge')
    if edge not in _EDGES:
      self._skip(data, '시작과 끝 중 어느 쪽인지 없어서')
      return None
    return edge

  def _delta(self, data: dict[str, Any]) -> float | None:
    """Reads deltaSec; skips the operation when it is missing or about 0."""
    delta = _seconds(data.get('deltaSec'))
    if delta is None or abs(delta) < 1e-3:
      self._skip(data, '옮길 시간이 없어서')
      return None
    return delta

  def _limit(self, clip: models.Clip) -> float:
    """The end of the media a Clip plays: the Source Video or its file."""
    if clip.media_kind == 'source':
      return self._duration
    asset = self._assets.get(clip.asset_id or '')
    if asset is not None and asset.duration_sec > 0:
      return asset.duration_sec
    return math.inf

  def _fit_range(
      self, data: dict[str, Any], start: float, end: float, limit: float
  ) -> tuple[float, float] | None:
    """Orders a range and fits it into 0..limit, with a note if it moved.

    Args:
      data: The raw operation, for the note.
      start: The start the answer gave, in seconds.
      end: The end the answer gave, in seconds.
      limit: The length of the media the range plays.

    Returns:
      The fitted (start, end), or None (skipped) when fewer than the
      shortest Subcut's seconds are left.
    """
    if start > end:
      start, end = end, start
    fitted = (_clamp(start, 0.0, limit), _clamp(end, 0.0, limit))
    if fitted[1] - fitted[0] < self._min_sec:
      self._skip(data, '구간이 너무 짧아서')
      return None
    if fitted != (start, end):
      self.note(
          f'{self.OPS[data["op"]].label}: 구간을 영상 길이 안으로 맞췄어요.'
      )
    return fitted

  def _allow(self, start: float, end: float) -> None:
    """Lets word operations reach a span this answer brings into the Shorts."""
    self._spans.append((start, end))

  def _allow_edge(self, clip: models.Clip, edge: str, at: float) -> None:
    """Lets word operations reach where a clip edge at `at` puts the Clip.

    As clipEdgeRange in the browser does, a start at or past the Clip's end,
    or an end at or before its start, moves the whole Clip with its length
    kept, the other edge on the nearest word edge.

    Args:
      clip: The source Clip as it was sent.
      edge: 'start' or 'end'.
      at: Where the edge goes, in Source Video seconds.
    """
    length = clip.end_sec - clip.start_sec
    if edge == 'start' and at >= clip.end_sec:
      ends = [
          word.end_sec
          for word in self._words
          if word.end_sec >= at + self._min_sec
      ]
      far = min(ends, key=lambda end: abs(end - at - length), default=at)
      self._allow(at, max(far, at + length))
    elif edge == 'end' and at <= clip.start_sec:
      starts = [
          word.start_sec
          for word in self._words
          if word.start_sec <= at - self._min_sec
      ]
      far = min(starts, key=lambda start: abs(at - length - start), default=at)
      self._allow(min(far, at - length), at)
    else:
      self._allow(min(at, clip.start_sec), max(at, clip.end_sec))

  def _placement(
      self, data: dict[str, Any], required: bool
  ) -> dict[str, Any] | None:
    """Reads where a moved or added Clip goes.

    Args:
      data: The raw operation.
      required: Whether the operation needs a place (moveClip) or may go
        after the selected Clip without one (the add operations).

    Returns:
      The place fields for the browser, {} for no place, or None when the
      operation is skipped: a required place is missing, or before/after
      lacks a usable otherClip.
    """
    place = data.get('place')
    if place not in _PLACES:
      if required:
        self._skip(data, '옮길 자리가 없어서')
        return None
      return {}
    if place in ('first', 'last'):
      return {'place': place}
    found = self._clip(data, 'otherClip')
    if found is None:
      return None
    return {'place': place, 'otherClip': found[0]}

  def _asset(
      self, data: dict[str, Any], kinds: tuple[str, ...]
  ) -> models.UploadedAsset | None:
    """Finds the uploaded file an operation names, of one of `kinds`.

    Args:
      data: The raw operation; its file field holds the name.
      kinds: The asset kinds the operation takes.

    Returns:
      The file, or None (skipped with a note telling whether no file has
      that name or it is of another kind).
    """
    name = director.clean_text(data.get('file'))
    if not name:
      self._skip(data, '파일 이름이 없어서')
      return None
    found = _find_file(
        name, (asset for asset in self._request.assets if asset.kind in kinds)
    )
    if found is not None:
      return found
    other = _find_file(name, self._request.assets)
    if other is not None:
      wanted = ' 또는 '.join(_KIND_LABELS[kind] for kind in kinds)
      self._skip(data, f'{other.filename!r} 파일은 {wanted} 파일이 아니라서')
    else:
      self._skip(data, f'올린 파일 중에 {name!r} 파일이 없어서')
    return None

  def _image_length(self, seconds: float) -> float:
    """Fits how long an image Clip shows into the allowed range."""
    low, high = _IMAGE_CLIP_SEC
    length = _clamp(seconds, low, high)
    if abs(length - seconds) > 1e-6:
      self.note(f'이미지 클립은 {low:g}~{high:g}초라 {length:g}초로 맞췄어요.')
    return length

  def _image_duration(self, number: int, seconds: float) -> dict[str, Any]:
    """setClipDuration for an image Clip, whose range is only its length."""
    length = self._image_length(seconds)
    return {'op': 'setClipDuration', 'clip': number, 'durationSec': _ms(length)}

  # -- Clips --------------------------------------------------------------

  def _set_clip_range(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """setClipRange: the range is fitted into the media the Clip plays.

    An image Clip has no range, so the range's length becomes how long it
    shows (setClipDuration).
    """
    found = self._clip(data)
    if found is None:
      return None
    number, clip = found
    start = _seconds(data.get('startSec'))
    end = _seconds(data.get('endSec'))
    if start is None or end is None:
      self._skip(data, '시작과 끝 시간이 없어서')
      return None
    if clip.media_kind == 'image':
      return self._image_duration(number, abs(end - start))
    fitted = self._fit_range(data, start, end, self._limit(clip))
    if fitted is None:
      return None
    if clip.media_kind == 'source':
      self._allow(*fitted)
    return {
        'op': 'setClipRange',
        'clip': number,
        'startSec': _ms(fitted[0]),
        'endSec': _ms(fitted[1]),
    }

  def _set_clip_edge(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """setClipEdge: a word (source Clips) or a second becomes atSec.

    A word's start is used for edge 'start' and its end for edge 'end';
    the browser snaps and keeps the length when the edge passes the other
    one, as the hand controls do.
    """
    found = self._clip(data)
    edge = self._edge(data) if found else None
    if found is None or edge is None:
      return None
    number, clip = found
    if clip.media_kind == 'image':
      self._skip(data, '이미지 클립에는 구간이 없어서')
      return None
    if clip.media_kind == 'source' and data.get('word') is not None:
      word = self._word(data, 'word')
      if word is None:
        return None
      at = word.start_sec if edge == 'start' else word.end_sec
    else:
      at = _seconds(data.get('atSec'))
      if at is None:
        self._skip(data, '맞출 단어나 시간이 없어서')
        return None
    at = _clamp(at, 0.0, self._limit(clip))
    if clip.media_kind == 'source':
      self._allow_edge(clip, edge, at)
    return {'op': 'setClipEdge', 'clip': number, 'edge': edge, 'atSec': _ms(at)}

  def _move_clip_edge(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """moveClipEdge: one edge moves by deltaSec.

    An image Clip only has a length: its end becomes setClipDuration and
    its start cannot move.
    """
    found = self._clip(data)
    edge = self._edge(data) if found else None
    delta = self._delta(data) if edge else None
    if found is None or edge is None or delta is None:
      return None
    number, clip = found
    if clip.media_kind == 'image':
      if edge == 'start':
        self._skip(data, '이미지 클립은 시작을 옮길 수 없어서')
        return None
      length = clip.end_sec - clip.start_sec + delta
      return self._image_duration(number, length)
    if clip.media_kind == 'source':
      at = (clip.start_sec if edge == 'start' else clip.end_sec) + delta
      self._allow_edge(clip, edge, _clamp(at, 0.0, self._limit(clip)))
    return {
        'op': 'moveClipEdge',
        'clip': number,
        'edge': edge,
        'deltaSec': _ms(delta),
    }

  def _shift_clip(self, data: dict[str, Any]) -> dict[str, Any] | None:
    found = self._clip(data)
    delta = self._delta(data) if found else None
    if found is None or delta is None:
      return None
    number, clip = found
    if clip.media_kind == 'image':
      self._skip(data, '이미지 클립에는 옮길 구간이 없어서')
      return None
    if clip.media_kind == 'source':
      length = clip.end_sec - clip.start_sec
      limit = self._limit(clip)
      start = _clamp(clip.start_sec + delta, 0.0, max(0.0, limit - length))
      self._allow(start, min(limit, start + length))
    return {'op': 'shiftClip', 'clip': number, 'deltaSec': _ms(delta)}

  def _set_clip_duration(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """setClipDuration: the start stays and the length is set.

    Image Clips take 0.5~60 s; other Clips need at least the shortest
    Subcut, and the browser fits the end into the media.
    """
    found = self._clip(data)
    if found is None:
      return None
    number, clip = found
    seconds = _seconds(data.get('durationSec'))
    if seconds is None or seconds <= 0:
      self._skip(data, '길이가 없어서')
      return None
    if clip.media_kind == 'image':
      return self._image_duration(number, seconds)
    if seconds < self._min_sec:
      self._skip(data, '길이가 너무 짧아서')
      return None
    if clip.media_kind == 'source':
      self._allow(clip.start_sec, clip.start_sec + seconds)
    return {
        'op': 'setClipDuration',
        'clip': number,
        'durationSec': _ms(seconds),
    }

  def _split_clip(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """splitClip: a source Clip splits at a word's start or at atSec.

    Both parts must keep at least the shortest Subcut.
    """
    found = self._clip(data)
    if found is None:
      return None
    number, clip = found
    if clip.media_kind != 'source':
      self._skip(data, '원본 클립만 나눌 수 있어서')
      return None
    if data.get('word') is not None:
      word = self._word(data, 'word')
      if word is None:
        return None
      at: float | None = word.start_sec
    else:
      at = _seconds(data.get('atSec'))
    if (
        at is None
        or at - clip.start_sec < self._min_sec
        or clip.end_sec - at < self._min_sec
    ):
      self._skip(data, '나눌 지점이 클립 안에 없어서')
      return None
    return {'op': 'splitClip', 'clip': number, 'atSec': _ms(at)}

  def _delete_clip(self, data: dict[str, Any]) -> dict[str, Any] | None:
    found = self._clip(data)
    if found is None:
      return None
    if self._count <= 1:
      self._skip(data, '마지막 남은 클립이라')
      return None
    self._count -= 1
    self._deleted.add(found[0])
    return {'op': 'deleteClip', 'clip': found[0]}

  def _move_clip(self, data: dict[str, Any]) -> dict[str, Any] | None:
    found = self._clip(data)
    placement = self._placement(data, required=True) if found else None
    if found is None or placement is None:
      return None
    if placement.get('otherClip') == found[0]:
      self._skip(data, '같은 클립을 기준으로 옮길 수 없어서')
      return None
    return {'op': 'moveClip', 'clip': found[0], **placement}

  def _swap_clips(self, data: dict[str, Any]) -> dict[str, Any] | None:
    first = self._clip(data)
    second = self._clip(data, 'otherClip') if first else None
    if first is None or second is None:
      return None
    if first[0] == second[0]:
      self._skip(data, '같은 클립끼리는 맞바꿀 수 없어서')
      return None
    return {'op': 'swapClips', 'clip': first[0], 'otherClip': second[0]}

  def _add_source_clip(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """addSourceClip: a Source Video range becomes a new Clip.

    The range runs from startWord's start to endWord's end (one alone
    stands for both, reversed numbers are swapped) or startSec~endSec,
    fitted into the Source Video.
    """
    start_word, end_word = data.get('startWord'), data.get('endWord')
    if start_word is not None or end_word is not None:
      first_key = 'startWord' if start_word is not None else 'endWord'
      last_key = 'endWord' if end_word is not None else 'startWord'
      first = self._word(data, first_key)
      last = self._word(data, last_key) if first else None
      if first is None or last is None:
        return None
      if last.index < first.index:
        first, last = last, first
      start, end = first.start_sec, last.end_sec
    else:
      start_sec = _seconds(data.get('startSec'))
      end_sec = _seconds(data.get('endSec'))
      if start_sec is None or end_sec is None:
        self._skip(data, '넣을 구간이 없어서')
        return None
      start, end = start_sec, end_sec
    fitted = self._fit_range(data, start, end, self._duration)
    placement = self._placement(data, required=False) if fitted else None
    if fitted is None or placement is None:
      return None
    self._count += 1
    self._allow(*fitted)
    return {
        'op': 'addSourceClip',
        'startSec': _ms(fitted[0]),
        'endSec': _ms(fitted[1]),
        **placement,
    }

  def _add_media_clip(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """addMediaClip: an uploaded image or video file becomes a new Clip.

    An image Clip shows for durationSec (or endSec - startSec) fitted into
    the image Clip range, or a default length. A video Clip plays
    startSec~endSec of the file (from 0, and for durationSec or a default
    length when endSec is missing), fitted into the file when its length
    is known.
    """
    asset = self._asset(data, ('image', 'video'))
    if asset is None:
      return None
    start = _seconds(data.get('startSec'))
    end = _seconds(data.get('endSec'))
    duration = _seconds(data.get('durationSec'))
    if asset.kind == 'image':
      if duration is None and start is not None and end is not None:
        duration = abs(end - start)
      length = (
          self._image_length(duration)
          if duration is not None and duration > 0
          else _DEFAULT_IMAGE_CLIP_SEC
      )
      fitted: tuple[float, float] | None = (0.0, length)
    else:
      limit = asset.duration_sec if asset.duration_sec > 0 else math.inf
      start = 0.0 if start is None else start
      if end is None:
        if duration is not None and duration > 0:
          length = duration
        elif asset.duration_sec > 0:
          length = min(asset.duration_sec, _DEFAULT_VIDEO_CLIP_SEC)
        else:
          length = _UNKNOWN_VIDEO_CLIP_SEC
        end = start + length
      fitted = self._fit_range(data, start, end, limit)
    placement = self._placement(data, required=False) if fitted else None
    if fitted is None or placement is None:
      return None
    self._count += 1
    return {
        'op': 'addMediaClip',
        'assetId': asset.asset_id,
        'mediaKind': asset.kind,
        'file': asset.filename,
        'startSec': _ms(fitted[0]),
        'endSec': _ms(fitted[1]),
        **placement,
    }

  def _set_clip_mute(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """setClipMute: an inserted video Clip's sound goes off or on.

    mute defaults to True when it is not a boolean.
    """
    found = self._clip(data)
    if found is None:
      return None
    if found[1].media_kind != 'video':
      self._skip(data, '소리 끄기는 삽입 영상 클립에만 있어서')
      return None
    mute = data.get('mute')
    return {
        'op': 'setClipMute',
        'clip': found[0],
        'mute': mute if isinstance(mute, bool) else True,
    }

  # -- Looks --------------------------------------------------------------

  def _target(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """{'target': 'clip', 'clip': n} for one Clip's own Look, else shared."""
    target = data.get('target')
    if target == 'clip' or (
        target not in _TARGETS and data.get('clip') is not None
    ):
      found = self._clip(data)
      return None if found is None else {'target': 'clip', 'clip': found[0]}
    return {'target': 'shared'}

  def _look_of(self, target: dict[str, Any]) -> models.Look:
    number = target.get('clip')
    clip = self._clips[number - 1] if number is not None else None
    return clip.look if clip is not None and clip.look else self._scenario.look

  def _patch_look(self, data: dict[str, Any]) -> dict[str, Any] | None:
    target = self._target(data)
    if target is None:
      return None
    look = self._looks.clean(data.get('look'))
    if not look:
      self._skip(data, '바꿀 스타일 값이 없어서')
      return None
    return {'op': 'patchLook', **target, 'look': look}

  def _set_own_look(self, data: dict[str, Any]) -> dict[str, Any] | None:
    found = self._clip(data)
    if found is None:
      return None
    own = data.get('own')
    if not isinstance(own, bool):
      self._skip(data, '자기 스타일을 만들지 없앨지가 없어서')
      return None
    return {'op': 'setOwnLook', 'clip': found[0], 'own': own}

  def _image_width(self, value: float) -> float:
    """Fits an image width into the allowed range, with a note if it moved."""
    high = self._canvas.canvas_width * _MAX_IMAGE_WIDTH_RATIO
    width = _clamp(value, _MIN_IMAGE_WIDTH, high)
    if abs(width - value) > 1e-6:
      self.note(
          f'이미지 너비는 {_MIN_IMAGE_WIDTH:g}~{high:g}라 {width:g}에 맞췄어요.'
      )
    return round(width, 1)

  def _add_image(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """addImage: an uploaded image goes on the targeted Look.

    A missing width defaults to the configured share of the canvas and is
    fitted into the allowed range; height follows the file's aspect ratio
    (square when unknown); a missing x or y centers it; rotation is
    folded into -180~180.
    """
    asset = self._asset(data, ('image',))
    target = self._target(data) if asset else None
    if asset is None or target is None:
      return None
    canvas = self._canvas
    raw_width = _number(data.get('width'))
    if raw_width is None:
      ratio = config.COMPOSITION.default_image_width_ratio
      raw_width = round(canvas.canvas_width * ratio)
    width = self._image_width(raw_width)
    has_size = asset.width > 0 and asset.height > 0
    aspect = asset.height / asset.width if has_size else 1.0
    x = _number(data.get('x'))
    y = _number(data.get('y'))
    rotation = _number(data.get('rotationDeg'))
    return {
        'op': 'addImage',
        **target,
        'assetId': asset.asset_id,
        'file': asset.filename,
        'x': round(canvas.canvas_width / 2 if x is None else x, 1),
        'y': round(canvas.canvas_height / 2 if y is None else y, 1),
        'width': width,
        'height': max(1, _half_up(width * aspect)),
        'rotationDeg': round(math.remainder(rotation or 0.0, 360.0), 1),
    }

  def _image_ref(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """Finds the image an updateImage or removeImage names.

    Args:
      data: The raw operation; imageId names the image.

    Returns:
      The imageId and target fields, or None when skipped: no imageId, an
      unknown Clip, or no such image in the targeted Clip's Look (for the
      shared target, in the shared Look or any Clip's own Look).
    """
    image_id = director.clean_text(data.get('imageId'))
    target = self._target(data) if image_id else None
    if not image_id:
      self._skip(data, '이미지 번호(imageId)가 없어서')
    if target is None:
      return None
    if 'clip' in target:
      looks = [self._look_of(target)]
    else:
      looks = [self._scenario.look, *(c.look for c in self._clips if c.look)]
    if not any(
        image.overlay_id == image_id for look in looks for image in look.images
    ):
      self._skip(data, f'{image_id!r} 이미지가 없어서')
      return None
    return {'imageId': image_id, **target}

  def _update_image(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """updateImage: only the given position, width or rotation changes.

    Width is fitted as addImage fits it and rotation folded into -180~180.
    """
    found = self._image_ref(data)
    if found is None:
      return None
    changes: dict[str, Any] = {}
    for key in ('x', 'y'):
      value = _number(data.get(key))
      if value is not None:
        changes[key] = round(value, 1)
    width = _number(data.get('width'))
    if width is not None:
      changes['width'] = self._image_width(width)
    rotation = _number(data.get('rotationDeg'))
    if rotation is not None:
      changes['rotationDeg'] = round(math.remainder(rotation, 360.0), 1)
    if not changes:
      self._skip(data, '바꿀 값이 없어서')
      return None
    return {'op': 'updateImage', **found, **changes}

  def _remove_image(self, data: dict[str, Any]) -> dict[str, Any] | None:
    found = self._image_ref(data)
    return None if found is None else {'op': 'removeImage', **found}

  # -- Captions -----------------------------------------------------------

  def _word_indices(self, data: dict[str, Any]) -> list[int] | None:
    """Word numbers from words, startWord..endWord or word, all known."""
    if isinstance(data.get('words'), list):
      indices = [_integer(value) for value in data['words']]
    elif data.get('startWord') is not None or data.get('endWord') is not None:
      start_word, end_word = data.get('startWord'), data.get('endWord')
      first = _integer(start_word if start_word is not None else end_word)
      last = _integer(end_word if end_word is not None else start_word)
      if first is None or last is None:
        self._skip(data, '단어 번호가 없어서')
        return None
      first, last = min(first, last), max(first, last)
      if last - first >= _MAX_WORDS:
        self._skip(data, '단어가 너무 많아서')
        return None
      indices = list(range(first, last + 1))
    else:
      indices = [_integer(data.get('word'))]
    named = {index for index in indices if index is not None}
    known = sorted(index for index in named if index in self._by_index)
    if len(known) < len(named):
      self.note(
          f'{self.OPS[data["op"]].label}: 대본에 없는 단어 번호 '
          f'{len(named) - len(known)}개는 건너뛰었어요.'
      )
    if not known:
      self._skip(data, '쓸 수 있는 단어 번호가 없어서')
      return None
    return known[:_MAX_WORDS]

  def _set_word_text(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """setWordText: one known word gets new text, trimmed and capped."""
    word = self._word(data, 'word')
    if word is None:
      return None
    text = data.get('text')
    if not isinstance(text, str):
      self._skip(data, '바꿀 글자가 없어서')
      return None
    return {
        'op': 'setWordText',
        'word': word.index,
        'text': text.strip()[:_MAX_TEXT_CHARS],
    }

  def _set_line_text(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """setLineText: known words get one text, trimmed and capped.

    The browser gives each word one token of it in order, the last word
    the rest, and un-cuts the words, as the transcript line edit does.
    """
    words = self._word_indices(data)
    if words is None:
      return None
    text = data.get('text')
    if not isinstance(text, str):
      self._skip(data, '바꿀 글이 없어서')
      return None
    return {
        'op': 'setLineText',
        'words': words,
        'text': text.strip()[:_MAX_TEXT_CHARS],
    }

  def _word_list_op(self, data: dict[str, Any]) -> dict[str, Any] | None:
    words = self._word_indices(data)
    return None if words is None else {'op': data['op'], 'words': words}

  def _set_caption_max_chars(
      self, data: dict[str, Any]
  ) -> dict[str, Any] | None:
    """setCaptionMaxChars: a whole count inside the allowed range.

    maxChars is read, or value when the model used the generic name.
    """
    raw = data.get('maxChars')
    value = _number(raw if raw is not None else data.get('value'))
    if value is None:
      self._skip(data, '글자 수가 없어서')
      return None
    low, high = _CAPTION_MAX_CHARS
    count = int(_clamp(_half_up(value), low, high))
    if count != _half_up(value):
      self.note(f'자막 줄 글자 수는 {low}~{high}자라 {count}자로 맞췄어요.')
    return {'op': 'setCaptionMaxChars', 'maxChars': count}

  def _inside_shorts(
      self, operations: list[dict[str, Any]]
  ) -> list[dict[str, Any]]:
    """Keeps word operations to words this Shorts plays.

    Word edits are transcript-wide, so a word outside this Shorts would
    change other Shorts only. Spans include the ones this answer adds.
    """
    spans = sorted(self._spans)

    def inside(index: int) -> bool:
      start = self._by_index[index].start_sec
      return any(low <= start < high for low, high in spans)

    kept = []
    for operation in operations:
      if operation['op'] not in _WORD_OPS:
        kept.append(operation)
        continue
      label = self.OPS[operation['op']].label
      if operation['op'] == 'setWordText':
        if inside(operation['word']):
          kept.append(operation)
        else:
          self.note(f'{label}: 지금 Shorts 클립 밖의 단어라 건너뛰었어요.')
        continue
      words = [index for index in operation['words'] if inside(index)]
      if len(words) < len(operation['words']):
        outside = len(operation['words']) - len(words)
        self.note(
            f'{label}: 지금 Shorts 클립 밖의 단어 {outside}개는 건너뛰었어요.'
        )
      if words:
        kept.append({**operation, 'words': words})
    return kept

  # -- Music and reset ----------------------------------------------------

  def _volume(self, data: dict[str, Any]) -> float | None:
    """Reads a music volume as a fraction; whole 2..100 or '%' is percent."""
    value = _fraction(data.get('volume'))
    if value is None:
      self._skip(data, '볼륨 값이 없어서')
      return None
    volume = _clamp(value, 0.0, models.MAX_MUSIC_VOLUME)
    if abs(volume - value) > 1e-6:
      self.note(f'음악 볼륨은 0~100%라 {_half_up(volume * 100)}%로 맞췄어요.')
    return round(volume, 3)

  def _set_music(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """setMusic: an uploaded audio file becomes the background music.

    A volume given with it is checked as setMusicVolume checks it, and
    later setMusicVolume operations in this answer count the music as set.
    """
    asset = self._asset(data, ('audio',))
    if asset is None:
      return None
    operation: dict[str, Any] = {
        'op': 'setMusic',
        'assetId': asset.asset_id,
        'file': asset.filename,
    }
    if data.get('volume') is not None:
      volume = self._volume(data)
      if volume is None:
        return None
      operation['volume'] = volume
    self._has_music = True
    return operation

  def _set_music_volume(self, data: dict[str, Any]) -> dict[str, Any] | None:
    if not self._has_music:
      self._skip(data, '배경음악이 없어서')
      return None
    volume = self._volume(data)
    if volume is None:
      return None
    return {'op': 'setMusicVolume', 'volume': volume}

  def _remove_music(self, data: dict[str, Any]) -> dict[str, Any] | None:
    if not self._has_music:
      self._skip(data, '배경음악이 없어서')
      return None
    self._has_music = False
    return {'op': data['op']}

  def _reset_shorts(self, data: dict[str, Any]) -> dict[str, Any] | None:
    self._has_music = False
    return {'op': data['op']}

  # Operation names, with the Korean label used in notes about them and the
  # handler that checks them.
  OPS: ClassVar[dict[str, _OpSpec]] = {
      'setClipRange': _OpSpec('클립 구간 정하기', _set_clip_range),
      'setClipEdge': _OpSpec('클립 끝 맞추기', _set_clip_edge),
      'moveClipEdge': _OpSpec('클립 끝 옮기기', _move_clip_edge),
      'shiftClip': _OpSpec('클립 옮기기', _shift_clip),
      'setClipDuration': _OpSpec('클립 길이 정하기', _set_clip_duration),
      'splitClip': _OpSpec('클립 나누기', _split_clip),
      'deleteClip': _OpSpec('클립 지우기', _delete_clip),
      'moveClip': _OpSpec('클립 순서 바꾸기', _move_clip),
      'swapClips': _OpSpec('클립 맞바꾸기', _swap_clips),
      'addSourceClip': _OpSpec('원본 클립 넣기', _add_source_clip),
      'addMediaClip': _OpSpec('삽입 클립 넣기', _add_media_clip),
      'setClipMute': _OpSpec('삽입 영상 소리', _set_clip_mute),
      'patchLook': _OpSpec('스타일 바꾸기', _patch_look),
      'setOwnLook': _OpSpec('클립 스타일 정하기', _set_own_look),
      'addImage': _OpSpec('이미지 넣기', _add_image),
      'updateImage': _OpSpec('이미지 바꾸기', _update_image),
      'removeImage': _OpSpec('이미지 빼기', _remove_image),
      'setWordText': _OpSpec('자막 글자 고치기', _set_word_text),
      'setLineText': _OpSpec('자막 줄 고치기', _set_line_text),
      'resetWordText': _OpSpec('자막 글자 되돌리기', _word_list_op),
      'cutWords': _OpSpec('단어 지우기', _word_list_op),
      'restoreWords': _OpSpec('단어 살리기', _word_list_op),
      'setCaptionMaxChars': _OpSpec('자막 줄 글자 수', _set_caption_max_chars),
      'setMusic': _OpSpec('배경음악 넣기', _set_music),
      'setMusicVolume': _OpSpec('음악 볼륨', _set_music_volume),
      'removeMusic': _OpSpec('배경음악 빼기', _remove_music),
      'resetShorts': _OpSpec('처음 제안으로 되돌리기', _reset_shorts),
  }


def check_answer(
    data: dict[str, Any],
    request: EditRequest,
    transcript: models.StoredTranscript | None,
) -> EditResponse:
  """Validates Gemini's answer to an Edit Request.

  Args:
    data: The answer JSON: operations and reply.
    request: The Edit Request with the state it was sent from.
    transcript: The stored full transcript; None when there is none.

  Returns:
    The operations the browser can apply as they are, the one-line reply
    and notes on what was adjusted or skipped.
  """
  checker = _Checker(request, transcript)
  raw = director.as_list(data.get('operations'))
  if len(raw) > _MAX_OPERATIONS:
    checker.note(
        f'동작이 너무 많아 앞의 {_MAX_OPERATIONS}개만 적용했어요.'
    )
  operations = checker.check(raw[:_MAX_OPERATIONS])
  reply = ' '.join(director.clean_text(data.get('reply')).split())[
      :_MAX_REPLY_CHARS
  ]
  if raw and not operations:
    # The reply describes edits that were all dropped; it would mislead.
    reply = '요청한 편집을 적용하지 못했어요.'
    if checker.notes:
      reply += f' {checker.notes[0]}'
  elif not reply:
    reply = (
        '요청한 편집을 적용했어요.'
        if operations
        else '바꿀 수 있는 편집을 찾지 못했어요.'
    )
  return EditResponse(reply=reply, operations=operations, notes=checker.notes)


# --------------------------------------------------------------------------
# Prompt
# --------------------------------------------------------------------------


def _json(value: Any) -> str:
  rounded = json.loads(
      json.dumps(value), parse_float=lambda text: round(float(text), 3)
  )
  return json.dumps(rounded, ensure_ascii=False, separators=(',', ':'))


def _look_text(
    look: models.Look, assets: dict[str, models.UploadedAsset]
) -> str:
  """A Look as compact JSON for the prompt.

  Images are listed by the ids and fields the image operations take, with
  the uploaded file's name in place of its asset id when known.

  Args:
    look: The Look to show.
    assets: Uploaded files by asset id.

  Returns:
    One line of JSON, floats rounded to 3 places.
  """
  data = look.to_json()
  data['images'] = [
      {
          'imageId': image.overlay_id,
          'file': (
              assets[image.asset_id].filename
              if image.asset_id in assets
              else image.asset_id
          ),
          'x': image.x,
          'y': image.y,
          'width': image.width,
          'height': image.height,
          'rotationDeg': image.rotation_deg,
      }
      for image in look.images
  ]
  return _json(data)


class _Words:
  """The transcript words in time order, with lookups by time."""

  def __init__(self, transcript: models.StoredTranscript | None) -> None:
    self.words = list(transcript.words) if transcript else []
    self._starts = [word.start_sec for word in self.words]

  def starting_in(
      self, start: float, end: float
  ) -> list[models.TranscriptWord]:
    low = bisect.bisect_left(self._starts, start)
    return self.words[low : bisect.bisect_left(self._starts, end)]

  def at(self, seconds: float) -> models.TranscriptWord | None:
    """The word playing at `seconds`, else the next one to start."""
    position = bisect.bisect_right(self._starts, seconds) - 1
    if position >= 0 and self.words[position].end_sec > seconds:
      return self.words[position]
    following = position + 1
    return self.words[following] if following < len(self.words) else None


def _preview(words: list[models.TranscriptWord]) -> str:
  texts = [word.text for word in words]
  if len(texts) > 24:
    texts = [*texts[:14], '…', *texts[-8:]]
  return ' '.join(texts)


def _clip_lines(
    request: EditRequest, words: _Words, assets: dict[str, models.UploadedAsset]
) -> list[str]:
  """Lists the Clips of the Shorts by Clip Number, with their own Looks.

  Times are to the millisecond, as operations use them; a source Clip also
  shows the word numbers it plays and a preview of their text.
  """
  lines = []
  for number, clip in enumerate(request.scenario.clips, start=1):
    start, end = _sec_text(clip.start_sec), _sec_text(clip.end_sec)
    length = _sec_text(clip.end_sec - clip.start_sec)
    file = assets[clip.asset_id].filename if clip.asset_id in assets else ''
    if clip.media_kind == 'image':
      line = f'{number}번 이미지 클립: {file or clip.purpose}, {length}초'
    elif clip.media_kind == 'video':
      line = (
          f'{number}번 영상 클립: {file or clip.purpose}, 영상 안 '
          f'{start}~{end}초 ({length}초)'
          + (', 무음' if clip.mute_audio else '')
      )
    else:
      inside = words.starting_in(clip.start_sec, clip.end_sec)
      span = (
          f', 단어 [{inside[0].index}]~[{inside[-1].index}]: '
          f'"{_preview(inside)}"'
          if inside
          else ', 단어 없음'
      )
      who = f', 화자 {clip.speaker}' if clip.speaker else ''
      why = f', 목적 {clip.purpose}' if clip.purpose else ''
      line = (
          f'{number}번 원본 클립: {start}~{end}초 ({length}초)'
          f'{span}{who}{why}'
      )
    lines.append(line)
    if clip.look is not None:
      lines.append(f'  {number}번 자기 스타일: {_look_text(clip.look, assets)}')
  return lines or ['(클립 없음)']


def _state_lines(
    request: EditRequest, words: _Words, assets: dict[str, models.UploadedAsset]
) -> list[str]:
  """Describes the Shorts on screen: selection, playhead, music, Look.

  The playhead names the Clip it is in, the selected Clip first when
  Clips overlap in the Source Video, and the nearest word.
  """
  scenario = request.scenario
  clips = scenario.clips
  number = request.clip_number
  selected = '없음'
  if number is not None and 1 <= number <= len(clips):
    selected = f'{number}번'
  playhead = request.playhead_sec
  if playhead is None:
    where = '재생 위치: 삽입 클립 위라 원본 시간이 없음'
  else:
    holders = [
        position
        for position, clip in enumerate(clips, start=1)
        if clip.media_kind == 'source'
        and clip.start_sec <= playhead < clip.end_sec
    ]
    holder = number if number in holders else (holders[0] if holders else None)
    word = words.at(playhead)
    where = (
        f'재생 위치: {_sec_text(playhead)}초'
        + (f', {holder}번 클립 안' if holder else ', 클립 밖')
        + (f', 가까운 단어 [{word.index}]{word.text}' if word else '')
    )
  music = '배경음악: 없음'
  if scenario.music is not None:
    asset = assets.get(scenario.music.asset_id)
    volume = scenario.music.volume
    music = (
        f'배경음악: {asset.filename if asset else scenario.music.asset_id}, '
        f'볼륨 {volume:g} ({_half_up(volume * 100)}%)'
    )
  duration = request.source_duration_sec
  length = f'{_sec_text(duration)}초' if duration > 0 else '모름'
  return [
      (
          f'Shorts {request.shorts_number}/{request.shorts_count}, '
          f'Shorts 제목(탭 이름, 바꿀 수 없음): {scenario.title}'
      ),
      f'고른 클립: {selected}',
      where,
      f'원본 영상 길이: {length}',
      f'자막 한 줄 글자 수: {request.caption_max_chars}',
      music,
      f'공통 스타일: {_look_text(scenario.look, assets)}',
  ]


def _asset_lines(request: EditRequest) -> list[str]:
  lines = []
  for asset in request.assets:
    size = f'{asset.width}×{asset.height}'
    length = f'{asset.duration_sec:.1f}초'
    detail = {
        'image': size,
        'audio': length,
        'video': f'{size}, {length}',
    }[asset.kind]
    lines.append(f'- {asset.filename} ({_KIND_LABELS[asset.kind]}, {detail})')
  return lines or ['(없음)']


def _canvas_lines() -> list[str]:
  """The canvas facts the Look values are measured against.

  Returns:
    Lines with the canvas size, the default video box, where text
    positions point, the default text positions per fit mode, the default
    image width and the default Look style.
  """
  style = config.get_settings().template_style
  box = layout.video_box(style, style.canvas_width)
  lines = [
      f'캔버스 {style.canvas_width}×{style.canvas_height}, 왼쪽 위가 (0, 0).',
      (
          f'기본 영상 박스(box 모드에서 box가 null일 때): x {box.x:g}, '
          f'y {box.y:g}, 너비 {box.width:g}, 높이 {box.height:g}.'
      ),
      '글 위치 x, y는 그 글 마지막 줄의 아래 가운데입니다.',
  ]
  for fit, text_layout in layout.default_text_layouts(style).items():
    headline, caption = text_layout.headline, text_layout.caption
    lines.append(
        f'{fit} 모드 기본 글 위치: 헤드라인 ({headline.x:g}, {headline.y:g}), '
        f'자막 ({caption.x:g}, {caption.y:g}).'
    )
  ratio = config.COMPOSITION.default_image_width_ratio
  width = round(style.canvas_width * ratio)
  lines += [
      f'새 이미지 기본 너비 {width}, 기본 위치는 캔버스 가운데.',
      f'기본 스타일: {_json(config.default_look_style().to_json())}',
  ]
  return lines


def _retention_line(
    span: models.YouTubeRetentionPeak,
    words: _Words,
    clips: list[tuple[int, models.Clip]],
) -> str:
  """One retention span with the words it covers and the Clips it overlaps.

  Args:
    span: A peak or low of the retention curve.
    words: The transcript words.
    clips: The source Clips of the Shorts with their Clip Numbers.

  Returns:
    The line for the audience section.
  """
  inside = words.starting_in(span.start_sec, span.end_sec)
  covered = (
      f'단어 [{inside[0].index}]~[{inside[-1].index}]'
      if inside
      else '단어 없음'
  )
  overlap = [
      str(number)
      for number, clip in clips
      if clip.start_sec < span.end_sec and span.start_sec < clip.end_sec
  ]
  where = (
      f'지금 {", ".join(overlap)}번 클립과 겹침'
      if overlap
      else '지금 클립과 겹치지 않음'
  )
  label = f' ({span.label})' if span.label else ''
  return (
      f'- {span.start_sec:.1f}~{span.end_sec:.1f}초, {covered}: 시청 유지율 '
      f'{span.watch_ratio * 100:.0f}%, 상대적 유지 성과 '
      f'{span.relative_performance * 100:.0f}%{label}, {where}'
  )


def _audience_lines(
    context: models.YouTubeVideoContext | None,
    request: EditRequest,
    words: _Words,
) -> list[str]:
  """Writes the linked YouTube data in terms of this Shorts.

  Retention spans carry the word numbers they cover and the Clips they
  overlap, and timed comments the word they point at, so the model picks
  words by number: a comment written as "[197.0초 언급]" once came back as
  words [197]~[217].

  Args:
    context: The linked YouTube data; None when there is none.
    request: The Edit Request, for the Clips of the Shorts.
    words: The transcript words.

  Returns:
    The lines of the audience section.
  """
  if context is None or not (
      context.retention_peaks or context.retention_lows or context.comments
  ):
    return ['(연결된 YouTube 데이터 없음)']
  clips = [
      (number, clip)
      for number, clip in enumerate(request.scenario.clips, start=1)
      if clip.media_kind == 'source'
  ]
  lines = []
  if context.retention_peaks or context.retention_lows:
    lines.append(
        '상대적 유지 성과는 50%가 비슷한 길이 영상의 평균이고, 높을수록 '
        '좋습니다.'
    )
  for spans, title in (
      (context.retention_peaks, '많이 본 구간:'),
      (context.retention_lows, '적게 본 구간:'),
  ):
    if spans:
      lines.append(title)
    lines += [_retention_line(span, words, clips) for span in spans]
  comments = sorted(context.comments, key=lambda item: -item.like_count)
  if comments:
    lines.append('댓글:')
  for comment in comments[:_COMMENTS]:
    when = ''
    if comment.timestamp_sec is not None:
      word = words.at(comment.timestamp_sec)
      when = f', {comment.timestamp_sec:.1f}초 언급' + (
          f', 그 시점 단어 [{word.index}]' if word else ''
      )
    text = ' '.join(comment.text.split())[:140]
    lines.append(f'- 좋아요 {comment.like_count}{when}: {text}')
  return lines


def _word_token(
    word: models.TranscriptWord, cut: set[int], overrides: dict[int, str]
) -> str:
  """One word as "[index]text" with its sound-tag, cut and caption marks.

  Args:
    word: The transcript word.
    cut: The cut word numbers.
    overrides: Caption text by word number; '' hides the word's caption.

  Returns:
    The word's token for the transcript section.
  """
  token = f'[{word.index}]{word.text}'
  if word.is_sound_tag:
    token += '(소리)'
  if word.index in cut:
    token += '(삭제됨)'
  override = overrides.get(word.index)
  if override == '':
    token += '(자막 숨김)'
  elif override is not None and override != word.text:
    token += f'(자막:{json.dumps(override, ensure_ascii=False)})'
  return token


def _transcript_lines(
    request: EditRequest, transcript: models.StoredTranscript | None
) -> list[str]:
  """The full transcript, one stored line per prompt line.

  Args:
    request: The Edit Request, for the cut words and caption text edits.
    transcript: The stored full transcript; None when there is none.

  Returns:
    Lines of "[start s]" and the line's word tokens.
  """
  if transcript is None or not transcript.words:
    return ['(대본 없음)']
  words = transcript.words
  count = len(words)
  breaks = {i for i in transcript.line_start_indices if 0 < i < count}
  starts = sorted({0} | breaks)
  cut = set(request.cut_words)
  lines = []
  for begin, end in zip(starts, [*starts[1:], count]):
    chunk = words[begin:end]
    tokens = [_word_token(word, cut, request.word_text) for word in chunk]
    lines.append(f'[{chunk[0].start_sec:.1f}s] ' + ' '.join(tokens))
  return lines


def _history_lines(history: list[EditTurn]) -> list[str]:
  """The last Edit Turns: request, reply, operations and whether undone.

  Args:
    history: The editor session's earlier Edit Turns, oldest first.

  Returns:
    The lines of the history section; operations are cut at
    _HISTORY_OPS_CHARS characters.
  """
  lines = []
  for turn in history[-_HISTORY_TURNS:]:
    lines.append(f'- 요청: {json.dumps(turn.request, ensure_ascii=False)}')
    if turn.reply:
      lines.append(f'  답장: {turn.reply}')
    if turn.operations:
      text = _json(turn.operations)
      if len(text) > _HISTORY_OPS_CHARS:
        text = text[:_HISTORY_OPS_CHARS] + '…'
      lines.append(f'  동작: {text}')
    if turn.undone:
      lines.append('  (되돌림)')
  return lines or ['(없음)']


def build_request_text(
    request: EditRequest,
    transcript: models.StoredTranscript | None,
    context: models.YouTubeVideoContext | None,
    inline_schema: dict[str, Any] | None,
) -> str:
  """Builds the user turn of one Edit Request.

  Args:
    request: The Edit Request with the state it was sent from.
    transcript: The stored full transcript; None when there is none.
    context: The linked YouTube data; None when there is none.
    inline_schema: The response schema to spell out in text when the API
      call cannot enforce it as structured output, else None.

  Returns:
    The prompt text: the current Shorts, its Clips, the uploaded files, the
    fonts, the canvas, the audience data, the numbered transcript, the
    conversation and, last, the Edit Request.
  """
  assets = {asset.asset_id: asset for asset in request.assets}
  words = _Words(transcript)
  lines = [
      '# 지금 Shorts',
      *_state_lines(request, words, assets),
      '',
      '# 클립 (번호는 화면 순서)',
      *_clip_lines(request, words, assets),
      '',
      '# 올린 파일',
      *_asset_lines(request),
      '',
      '# 글꼴 (fontId: 이름)',
      *(f'- {font.font_id}: {font.label}' for font in fonts.FONTS),
      '',
      '# 화면 좌표',
      *_canvas_lines(),
      '',
      '# 시청자 반응 (YouTube)',
      *_audience_lines(context, request, words),
      '',
      '# 대본 (줄 앞은 시작 초, 단어 앞 [번호]는 단어 번호)',
      *_transcript_lines(request, transcript),
      '',
      '# 대화 (오래된 것부터)',
      *_history_lines(request.history),
      '',
      '# 편집 요청',
      request.request.strip(),
  ]
  if inline_schema is not None:
    lines += [
        '',
        '# 출력',
        '아래 JSON Schema를 따르는 JSON 객체 하나로만 답하세요:',
        json.dumps(inline_schema, ensure_ascii=False),
    ]
  return '\n'.join(lines)


# --------------------------------------------------------------------------
# Response schema
# --------------------------------------------------------------------------


def _properties(**properties: dict[str, Any]) -> dict[str, Any]:
  """An object schema whose properties are all optional, kept in order.

  Without propertyOrdering the API decodes the keys of an object in
  alphabetical order (required keys first). A model that writes the
  fields in the order it was told, e.g. patchLook's target and then look,
  could then not write look at all, since it sorts before target.

  Args:
    **properties: The property schemas, in the order to write them.

  Returns:
    The object schema.
  """
  return {
      'type': 'object',
      'properties': properties,
      'propertyOrdering': list(properties),
  }


def _look_patch_schema() -> dict[str, Any]:
  """The schema of patchLook's look, in the key order of Look.to_json.

  The prompt shows every Look as Look.to_json, so the model meets the keys
  in that order before it writes a patch.
  """
  number = {'type': 'number'}
  integer = {'type': 'integer'}
  color = {'type': 'string', 'description': '#RRGGBB'}
  text_style = {
      'fontId': {'type': 'string', 'enum': fonts.font_ids()},
      'size': integer,
      'color': color,
      'outlineColor': color,
      'outlineWidth': integer,
      'background': {'type': 'boolean'},
      'backgroundColor': color,
      'backgroundOpacity': number,
  }
  placement = _properties(x=number, y=number)
  return _properties(
      headline=_properties(
          lines={'type': 'array', 'items': {'type': 'string'}}
      ),
      framingLayout=_properties(
          crop=_properties(centerX=number, centerY=number, zoom=number),
          fit={'type': 'string', 'enum': ['box', 'full']},
          box=_properties(x=number, y=number, width=number, height=number),
          defaultBox={'type': 'boolean'},
      ),
      textLayout=_properties(headline=placement, caption=placement),
      style=_properties(
          backgroundColor=color,
          border={'type': 'boolean'},
          borderColor=color,
          borderWidth=integer,
          headline=_properties(**text_style, accentColor=color),
          caption=_properties(**text_style),
      ),
  )


def response_schema() -> dict[str, Any]:
  """Returns the JSON Schema of the answer to an Edit Request.

  Every operation is one flat object: op names it, and only the fields
  that operation uses are filled in (see SYSTEM_INSTRUCTION). The fields
  are declared in one order that agrees with every field list of the
  instruction, and the decoder keeps it (see _properties). operations
  comes before reply so the reply is written after the edits.
  """
  number = {'type': 'number'}
  integer = {'type': 'integer'}
  operation = _properties(
      op={'type': 'string', 'enum': list(_Checker.OPS)},
      file={'type': 'string'},
      imageId={'type': 'string'},
      target={'type': 'string', 'enum': list(_TARGETS)},
      clip={'type': 'integer', 'description': '요청을 보낸 순간의 클립 번호'},
      edge={'type': 'string', 'enum': list(_EDGES)},
      word=integer,
      startWord=integer,
      endWord=integer,
      text={'type': 'string'},
      words={'type': 'array', 'items': integer},
      atSec=number,
      deltaSec=number,
      durationSec=number,
      startSec=number,
      endSec=number,
      place={'type': 'string', 'enum': list(_PLACES)},
      otherClip=integer,
      mute={'type': 'boolean'},
      own={'type': 'boolean'},
      volume=number,
      maxChars=integer,
      x=number,
      y=number,
      width=number,
      rotationDeg=number,
      look=_look_patch_schema(),
  )
  operation['required'] = ['op']
  answer = _properties(
      operations={'type': 'array', 'items': operation},
      reply={'type': 'string'},
  )
  answer['required'] = ['operations', 'reply']
  return answer


# --------------------------------------------------------------------------
# Gemini call
# --------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class _EditJob:
  """What one Edit Request asks Gemini for (director.GeminiJob)."""

  request: EditRequest
  transcript: models.StoredTranscript | None
  context: models.YouTubeVideoContext | None
  # Text only: an Edit Request never sends the video.
  video: ClassVar[types.Part | None] = None
  system_instruction: ClassVar[str] = SYSTEM_INSTRUCTION

  def schema(self) -> dict[str, Any]:
    return response_schema()

  def request_text(self, inline_schema: dict[str, Any] | None) -> str:
    return build_request_text(
        self.request, self.transcript, self.context, inline_schema
    )


async def _ignore(unused_event: dict[str, Any]) -> None:
  """Drops progress events; an Edit Request has no progress stream."""


async def run(
    request: EditRequest,
    transcript: models.StoredTranscript | None,
    context: models.YouTubeVideoContext | None,
) -> EditResponse:
  """Answers one Edit Request with checked edit operations.

  The call uses the analysis model chain with its retries and fallbacks,
  text only, with LOW thinking.

  Args:
    request: The Edit Request with the state it was sent from.
    transcript: The stored full transcript of the Source Video, if any.
    context: The linked YouTube data, if any.

  Returns:
    The checked operations, the reply and notes.

  Raises:
    director.DirectorError: If Gemini is not set up or every call fails.
  """
  settings = config.get_settings()
  if settings.gemini_setup_error:
    raise director.DirectorError(settings.gemini_setup_error)
  client = gemini.make_client(settings)
  job = _EditJob(request=request, transcript=transcript, context=context)
  answer = await director.run_gemini(
      client, job, None, _ignore, thinking=_THINKING
  )
  return check_answer(answer.data, request, transcript)
