"""Checks the edit operations in Gemini's answer to an Edit Request.

check_answer validates every operation against the state that was sent
and the limits of the render models: out-of-range values move to the
nearest allowed value, operations it does not know are dropped, and what
it changed or skipped is reported as Korean notes.
"""

from __future__ import annotations

from collections.abc import Callable
import math
from typing import Any, ClassVar, NamedTuple

from src.core import config
from src.core import models
from src.edit_agent import look_patch
from src.edit_agent import values
from src.gemini import director

# Answers longer than this are cut; one request rarely needs more.
_MAX_OPERATIONS = 60
_MAX_REPLY_CHARS = 300
# Words one operation may name.
_MAX_WORDS = 2000
# Limits of the hand controls the operations stand in for.
_IMAGE_CLIP_SEC = (0.5, 60.0)
_DEFAULT_IMAGE_CLIP_SEC = 3.0
_DEFAULT_VIDEO_CLIP_SEC = 10.0
_UNKNOWN_VIDEO_CLIP_SEC = 5.0
_MIN_IMAGE_WIDTH = 24.0
_MAX_IMAGE_WIDTH_RATIO = 1.5
_CAPTION_MAX_CHARS = (4, 40)
PLACES = ('first', 'last', 'before', 'after')
EDGES = ('start', 'end')
TARGETS = ('shared', 'clip')
# Operations on Transcript Words; they apply to the current Shorts only.
_WORD_OPS = frozenset(
    {'setWordText', 'setLineText', 'resetWordText', 'cutWords', 'restoreWords'}
)


class _OpSpec(NamedTuple):
  """An operation's Korean label and its Checker handler."""

  label: str
  check: Callable[[Any, dict[str, Any]], dict[str, Any] | None]


class Checker:
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
      request: models.EditRequest,
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
    self._looks = look_patch.LookPatcher(self.note)
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
    number = values.read_integer(data.get(key))
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
    index = values.read_integer(data.get(key))
    word = self._by_index.get(index) if index is not None else None
    if word is None:
      self._skip(data, '대본에 그 단어 번호가 없어서')
    return word

  def _edge(self, data: dict[str, Any]) -> str | None:
    edge = data.get('edge')
    if edge not in EDGES:
      self._skip(data, '시작과 끝 중 어느 쪽인지 없어서')
      return None
    return edge

  def _delta(self, data: dict[str, Any]) -> float | None:
    """Reads deltaSec; skips the operation when it is missing or about 0."""
    delta = values.read_seconds(data.get('deltaSec'))
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
    fitted = (values.clamp(start, 0.0, limit), values.clamp(end, 0.0, limit))
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
    if place not in PLACES:
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
    found = values.find_file(
        name, (asset for asset in self._request.assets if asset.kind in kinds)
    )
    if found is not None:
      return found
    other = values.find_file(name, self._request.assets)
    if other is not None:
      wanted = ' 또는 '.join(values.KIND_LABELS[kind] for kind in kinds)
      self._skip(data, f'{other.filename!r} 파일은 {wanted} 파일이 아니라서')
    else:
      self._skip(data, f'올린 파일 중에 {name!r} 파일이 없어서')
    return None

  def _image_length(self, seconds: float) -> float:
    """Fits how long an image Clip shows into the allowed range."""
    low, high = _IMAGE_CLIP_SEC
    length = values.clamp(seconds, low, high)
    if abs(length - seconds) > 1e-6:
      self.note(f'이미지 클립은 {low:g}~{high:g}초라 {length:g}초로 맞췄어요.')
    return length

  def _image_duration(self, number: int, seconds: float) -> dict[str, Any]:
    """setClipDuration for an image Clip, whose range is only its length."""
    length = self._image_length(seconds)
    return {
        'op': 'setClipDuration',
        'clip': number,
        'durationSec': values.ms(length),
    }

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
    start = values.read_seconds(data.get('startSec'))
    end = values.read_seconds(data.get('endSec'))
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
        'startSec': values.ms(fitted[0]),
        'endSec': values.ms(fitted[1]),
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
      at = values.read_seconds(data.get('atSec'))
      if at is None:
        self._skip(data, '맞출 단어나 시간이 없어서')
        return None
    at = values.clamp(at, 0.0, self._limit(clip))
    if clip.media_kind == 'source':
      self._allow_edge(clip, edge, at)
    return {
        'op': 'setClipEdge',
        'clip': number,
        'edge': edge,
        'atSec': values.ms(at),
    }

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
      self._allow_edge(clip, edge, values.clamp(at, 0.0, self._limit(clip)))
    return {
        'op': 'moveClipEdge',
        'clip': number,
        'edge': edge,
        'deltaSec': values.ms(delta),
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
      start = values.clamp(
          clip.start_sec + delta, 0.0, max(0.0, limit - length)
      )
      self._allow(start, min(limit, start + length))
    return {'op': 'shiftClip', 'clip': number, 'deltaSec': values.ms(delta)}

  def _set_clip_duration(self, data: dict[str, Any]) -> dict[str, Any] | None:
    """setClipDuration: the start stays and the length is set.

    Image Clips take 0.5~60 s; other Clips need at least the shortest
    Subcut, and the browser fits the end into the media.
    """
    found = self._clip(data)
    if found is None:
      return None
    number, clip = found
    seconds = values.read_seconds(data.get('durationSec'))
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
        'durationSec': values.ms(seconds),
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
      at = values.read_seconds(data.get('atSec'))
    if (
        at is None
        or at - clip.start_sec < self._min_sec
        or clip.end_sec - at < self._min_sec
    ):
      self._skip(data, '나눌 지점이 클립 안에 없어서')
      return None
    return {'op': 'splitClip', 'clip': number, 'atSec': values.ms(at)}

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
      start_sec = values.read_seconds(data.get('startSec'))
      end_sec = values.read_seconds(data.get('endSec'))
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
        'startSec': values.ms(fitted[0]),
        'endSec': values.ms(fitted[1]),
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
    start = values.read_seconds(data.get('startSec'))
    end = values.read_seconds(data.get('endSec'))
    duration = values.read_seconds(data.get('durationSec'))
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
        'startSec': values.ms(fitted[0]),
        'endSec': values.ms(fitted[1]),
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
        target not in TARGETS and data.get('clip') is not None
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
    width = values.clamp(value, _MIN_IMAGE_WIDTH, high)
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
    raw_width = values.read_number(data.get('width'))
    if raw_width is None:
      ratio = config.COMPOSITION.default_image_width_ratio
      raw_width = round(canvas.canvas_width * ratio)
    width = self._image_width(raw_width)
    has_size = asset.width > 0 and asset.height > 0
    aspect = asset.height / asset.width if has_size else 1.0
    x = values.read_number(data.get('x'))
    y = values.read_number(data.get('y'))
    rotation = values.read_number(data.get('rotationDeg'))
    return {
        'op': 'addImage',
        **target,
        'assetId': asset.asset_id,
        'file': asset.filename,
        'x': round(canvas.canvas_width / 2 if x is None else x, 1),
        'y': round(canvas.canvas_height / 2 if y is None else y, 1),
        'width': width,
        'height': max(1, values.half_up(width * aspect)),
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
      value = values.read_number(data.get(key))
      if value is not None:
        changes[key] = round(value, 1)
    width = values.read_number(data.get('width'))
    if width is not None:
      changes['width'] = self._image_width(width)
    rotation = values.read_number(data.get('rotationDeg'))
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
      indices = [values.read_integer(value) for value in data['words']]
    elif data.get('startWord') is not None or data.get('endWord') is not None:
      start_word, end_word = data.get('startWord'), data.get('endWord')
      first = values.read_integer(
          start_word if start_word is not None else end_word
      )
      last = values.read_integer(
          end_word if end_word is not None else start_word
      )
      if first is None or last is None:
        self._skip(data, '단어 번호가 없어서')
        return None
      first, last = min(first, last), max(first, last)
      if last - first >= _MAX_WORDS:
        self._skip(data, '단어가 너무 많아서')
        return None
      indices = list(range(first, last + 1))
    else:
      indices = [values.read_integer(data.get('word'))]
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
        'text': text.strip()[:values.MAX_TEXT_CHARS],
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
        'text': text.strip()[:values.MAX_TEXT_CHARS],
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
    value = values.read_number(raw if raw is not None else data.get('value'))
    if value is None:
      self._skip(data, '글자 수가 없어서')
      return None
    low, high = _CAPTION_MAX_CHARS
    count = int(values.clamp(values.half_up(value), low, high))
    if count != values.half_up(value):
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
    value = values.read_fraction(data.get('volume'))
    if value is None:
      self._skip(data, '볼륨 값이 없어서')
      return None
    volume = values.clamp(value, 0.0, models.MAX_MUSIC_VOLUME)
    if abs(volume - value) > 1e-6:
      self.note(f'음악 볼륨은 0~100%라 {values.half_up(volume * 100)}%로 맞췄어요.')
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
    request: models.EditRequest,
    transcript: models.StoredTranscript | None,
) -> models.EditResponse:
  """Validates Gemini's answer to an Edit Request.

  Args:
    data: The answer JSON: operations and reply.
    request: The Edit Request with the state it was sent from.
    transcript: The stored full transcript; None when there is none.

  Returns:
    The operations the browser can apply as they are, the one-line reply
    and notes on what was adjusted or skipped.
  """
  checker = Checker(request, transcript)
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
  return models.EditResponse(
      reply=reply, operations=operations, notes=checker.notes
  )
