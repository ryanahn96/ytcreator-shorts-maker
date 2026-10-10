"""Checks the Look patches (style edits) in an Edit Request's answer."""

from __future__ import annotations

from collections.abc import Callable
import math
from typing import Any

from src.core import models
from src.edit_agent import values
from src.gemini import director

# Headline lines one patch may hold.
_MAX_HEADLINE_LINES = 10
# The shortest video box side a drag allows (MIN_VIDEO_BOX in
# frontend/src/lib/framing.ts); stricter than models.VideoBoxSpec.
_MIN_VIDEO_BOX = 120.0


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


class LookPatcher:
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

  def _numbers(
      self, raw: Any, group: str, ranges: dict[str, tuple[float, float]]
  ) -> dict[str, float]:
    """Reads the numbers `ranges` names, each moved into its range."""
    data = director.as_dict(raw)
    picked = {key: values.read_number(data.get(key)) for key in ranges}
    return {
        key: self._bounded((group, key), value, *ranges[key])
        for key, value in picked.items()
        if value is not None
    }

  def _color(self, data: dict[str, Any], key: str, out: dict[str, Any]) -> None:
    if data.get(key) is None:
      return
    color = values.read_hex_color(data[key])
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
      font_id = values.read_font_id(data['fontId'])
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
      value = values.read_number(data.get(key))
      if value is not None:
        out[key] = self._bounded((group, key), values.half_up(value), low, high)
    opacity = values.read_fraction(data.get('backgroundOpacity'))
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
    bounded = values.clamp(value, low, high)
    if bounded != value:
      self._note(
          f'{_label(path)} 값은 허용 범위 밖이라 {bounded:g}에 맞췄어요.'
      )
    return bounded

  def clean(self, raw: Any) -> dict[str, Any]:
    """Keeps the Look keys of a raw patch, with the types the models use.

    Args:
      raw: The look object of a patchLook operation.

    Returns:
      The typed patch in the key order of Look.to_json; empty when the
      answer gave nothing usable. defaultBox wins over a box given with it.
    """
    data = director.as_dict(raw)
    patch: dict[str, Any] = {}
    lines = director.as_dict(data.get('headline')).get('lines')
    if isinstance(lines, list):
      patch['headline'] = {
          'lines': [
              line.strip()[:values.MAX_TEXT_CHARS]
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
    border_width = values.read_number(style.get('borderWidth'))
    if border_width is not None:
      style_patch['borderWidth'] = self._bounded(
          ('borderWidth',),
          values.half_up(border_width),
          0,
          models.MAX_BORDER_WIDTH,
      )
    for key in ('headline', 'caption'):
      text_style = self._text_style(style.get(key), key)
      if text_style:
        style_patch[key] = text_style
    if style_patch:
      patch['style'] = style_patch
    return patch
