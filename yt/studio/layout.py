"""Template geometry shared by the composer and the analysis defaults.

All values are in canvas units (models.TemplateStyle canvas size, which is
also the ASS PlayRes) unless a function says it works in output pixels.
frontend/src/lib/framing.ts mirrors crop_rect, fit_aspect and video_box so
the preview frames exactly what ffmpeg renders; the default Text Layouts
reach the client through the config endpoint.
"""

from __future__ import annotations

import dataclasses
import typing

from yt.studio import models


@dataclasses.dataclass(frozen=True)
class Box:
  """A rectangle in canvas or output units."""

  x: float
  y: float
  width: float
  height: float

  @property
  def bottom(self) -> float:
    return self.y + self.height


def even_floor(value: float) -> int:
  """Rounds down to an even integer (keeps yuv420p chroma aligned)."""
  return int(value) // 2 * 2


def _clamp_custom_box(
    style: models.TemplateStyle, spec: models.VideoBoxSpec
) -> Box:
  """Clamps a custom VideoBoxSpec to the canvas in canvas units."""
  width = min(max(64.0, spec.width), float(style.canvas_width))
  height = min(max(64.0, spec.height), float(style.canvas_height))
  x = min(max(0.0, spec.x), style.canvas_width - width)
  y = min(max(0.0, spec.y), style.canvas_height - height)
  return Box(x=x, y=y, width=width, height=height)


def fit_aspect(
    style: models.TemplateStyle,
    framing: models.FramingLayout,
) -> float:
  """Returns the width / height of the area the video fills."""
  if framing.fit == 'full':
    return style.canvas_width / style.canvas_height
  if framing.box is not None:
    clamped = _clamp_custom_box(style, framing.box)
    return clamped.width / clamped.height
  return style.box_aspect_ratio


def crop_rect(
    region: models.CropRegion, aspect: float, width: int, height: int
) -> tuple[int, int, int, int]:
  """Returns (w, h, x, y) of the crop for a target aspect ratio.

  The base rectangle is the largest one of the target aspect that fits the
  source; zoom shrinks it around the requested center, clamped to the frame.

  Args:
    region: Normalized center and zoom.
    aspect: Target width / height.
    width: Source width in pixels.
    height: Source height in pixels.

  Returns:
    Even-valued crop width, height, x and y in source pixels.
  """
  if width / height > aspect:
    base_w, base_h = height * aspect, float(height)
  else:
    base_w, base_h = float(width), width / aspect
  crop_w = max(2, even_floor(base_w / region.zoom))
  crop_h = max(2, even_floor(base_h / region.zoom))
  x = min(max(region.center_x * width - crop_w / 2, 0.0), width - crop_w)
  y = min(max(region.center_y * height - crop_h / 2, 0.0), height - crop_h)
  return crop_w, crop_h, even_floor(x), even_floor(y)


def video_box(
    style: models.TemplateStyle,
    width: int,
    target: models.FramingLayout | models.VideoFit = 'box',
) -> Box:
  """Returns the area the video fills, in output pixels.

  A 'box' spans the custom VideoBoxSpec when set or the template's default
  16:9 box; 'full' is the whole output. Values are even so the yuv420p
  chroma planes stay aligned.

  Args:
    style: The template style.
    width: Output width in pixels; the output has the canvas aspect ratio.
    target: FramingLayout or VideoFit naming where the video goes.

  Returns:
    The video area in output pixels.
  """
  scale = width / style.canvas_width
  out_h = even_floor(style.canvas_height * scale)
  fit = target.fit if isinstance(target, models.FramingLayout) else target
  if fit == 'full':
    return Box(x=0, y=0, width=width, height=out_h)
  if isinstance(target, models.FramingLayout) and target.box is not None:
    clamped = _clamp_custom_box(style, target.box)
    box_w = min(width, max(2, even_floor(clamped.width * scale)))
    box_h = min(out_h, max(2, even_floor(clamped.height * scale)))
    box_x = min(width - box_w, max(0, even_floor(clamped.x * scale)))
    box_y = min(out_h - box_h, max(0, even_floor(clamped.y * scale)))
    return Box(x=box_x, y=box_y, width=box_w, height=box_h)
  box_w = even_floor((style.canvas_width - 2 * style.box_side_margin) * scale)
  box_h = even_floor(box_w / style.box_aspect_ratio)
  return Box(
      x=even_floor((width - box_w) / 2),
      y=even_floor(style.box_center_y * scale - box_h / 2),
      width=box_w,
      height=box_h,
  )


def canvas_video_box(
    style: models.TemplateStyle,
    width: int,
    framing: models.FramingLayout,
) -> Box:
  """Returns the area ffmpeg fills at an output width, in canvas units."""
  box = video_box(style, width, framing)
  scale = style.canvas_width / width
  return Box(
      x=box.x * scale,
      y=box.y * scale,
      width=box.width * scale,
      height=box.height * scale,
  )


def default_text_layout(
    style: models.TemplateStyle, fit: models.VideoFit = 'box'
) -> models.TextLayout:
  """Returns where the template puts the Headline and the captions.

  In a 'box' fit the Headline's last line ends headline_gap above the box
  and the caption line ends caption_gap below the box bottom, so the
  caption sits on the background under the video. In a 'full' fit both sit
  at the template's full-frame anchors. Both are centered horizontally.

  Args:
    style: The template style.
    fit: Where the video goes.

  Returns:
    The default Text Layout in canvas units.
  """
  center_x = style.canvas_width / 2
  if fit == 'full':
    headline_y = float(style.full_headline_y)
    caption_y = float(style.full_caption_y)
  else:
    box = video_box(style, style.canvas_width)
    headline_y = box.y - style.headline_gap
    caption_y = box.bottom + style.caption_gap
  return models.TextLayout(
      headline=models.TextPlacement(x=center_x, y=headline_y),
      caption=models.TextPlacement(x=center_x, y=caption_y),
  )


def default_text_layouts(
    style: models.TemplateStyle,
) -> dict[str, models.TextLayout]:
  """Returns the default Text Layout of every VideoFit."""
  return {
      fit: default_text_layout(style, fit)
      for fit in typing.get_args(models.VideoFit)
  }
