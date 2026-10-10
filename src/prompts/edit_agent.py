"""What 말로 편집 sends to Gemini: the system instruction and the request.

The request text carries the Shorts on screen, the selected Clip, the
playhead, the conversation of this editor session, the stored full
transcript with word numbers, the audience data, the uploaded files and
the bundled fonts.
"""

from __future__ import annotations

import bisect
import json
from typing import Any

from src.core import config
from src.core import fonts
from src.core import models
from src.edit_agent import values
from src.render import layout

# The conversation sent back to the model: the latest turns, each with its
# operations as JSON cut to this many characters.
_HISTORY_TURNS = 10
_HISTORY_OPS_CHARS = 1500
# Viewer comments listed in the request.
_COMMENTS = 8


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


def _sec_text(seconds: float) -> str:
  """Seconds to the millisecond without trailing zeros, e.g. '36.04'.

  The prompt states times this exactly: one decimal made a 5.44 s Clip
  read as 5.4 s, so "1초 줄여" cut 1.04 s.
  """
  return f'{seconds:.3f}'.rstrip('0').rstrip('.')


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
    request: models.EditRequest,
    words: _Words,
    assets: dict[str, models.UploadedAsset],
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
    request: models.EditRequest,
    words: _Words,
    assets: dict[str, models.UploadedAsset],
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
        f'볼륨 {volume:g} ({values.half_up(volume * 100)}%)'
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


def _asset_lines(request: models.EditRequest) -> list[str]:
  lines = []
  for asset in request.assets:
    size = f'{asset.width}×{asset.height}'
    length = f'{asset.duration_sec:.1f}초'
    detail = {
        'image': size,
        'audio': length,
        'video': f'{size}, {length}',
    }[asset.kind]
    lines.append(
        f'- {asset.filename} ({values.KIND_LABELS[asset.kind]}, {detail})'
    )
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
    request: models.EditRequest,
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
    request: models.EditRequest, transcript: models.StoredTranscript | None
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


def _history_lines(history: list[models.EditTurn]) -> list[str]:
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
    request: models.EditRequest,
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
