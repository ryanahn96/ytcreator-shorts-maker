"""Composer: turns a RenderPlan into a frame-accurate ffmpeg edit and captions.

Sync rules:
  * Every Subcut boundary is snapped to the source frame grid, so each video
    segment holds a whole number of frames and its audio segment lasts
    exactly as long.
  * Audio is never cross-faded (acrossfade shortens it). Each audio segment
    only gets a very short fade on both edges so joins do not click.
  * Audio Transitions move video boundaries only. A J-cut keeps showing the
    previous Clip while the next Clip's audio starts and skips the first
    frames of the next Clip's video; an L-cut does the opposite. Speech is
    never shortened and total video and audio durations stay equal.
  * Captions follow the audio timeline; a Look (Headline, framing, Text
    Layout, images) stays on screen while its Clip's video plays.

Layout: every short uses one template (models.TemplateStyle). Each Clip's
video is cropped by its Look's Framing Layout, then either scaled into the
box on the Look's background color or scaled to the whole canvas, before
the Clips are joined. The ASS file draws, per Look, the background-colored
pieces that round the box corners, the box border, and the Headline and
captions at the Look's Text Layout in its fonts and colors (fonts come
from yt/studio/fonts through the subtitles filter's fontsdir). Image Overlays are composited above everything during their
Look, and Background Music is looped, trimmed to the voice track and mixed
under it, so the edit stays one ffmpeg command plus one ASS file (and the
user's image and music files).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import dataclasses
import json
import math
import pathlib
import subprocess

from yt.studio import config
from yt.studio import fonts
from yt.studio import layout
from yt.studio import models

ASS_FILENAME = 'captions.ass'
_EPSILON = 1e-6
_STDERR_TAIL_LINES = 12
# Control-point distance of a cubic Bezier that approximates a quarter
# circle, as a fraction of the radius.
_QUARTER_CIRCLE_KAPPA = 0.5523


class CompositionError(ValueError):
  """Raised when a RenderPlan does not fit the Source Video."""


class RenderError(RuntimeError):
  """Raised when ffmpeg or ffprobe fails."""


@dataclasses.dataclass(frozen=True)
class Span:
  """A range of Source Video seconds on the frame grid."""

  start: float
  end: float

  @property
  def duration(self) -> float:
    return self.end - self.start


@dataclasses.dataclass(frozen=True)
class ClipTimeline:
  """Where one Clip's video and audio Subcuts land in the output."""

  video: tuple[Span, ...]
  audio: tuple[Span, ...]
  audio_offsets: tuple[float, ...]
  # Index of the RenderClip this came from.
  plan_index: int

  @property
  def video_duration(self) -> float:
    return sum(span.duration for span in self.video)


@dataclasses.dataclass(frozen=True)
class TimedCue:
  """A caption line in output seconds."""

  start: float
  end: float
  text: str


@dataclasses.dataclass(frozen=True)
class Timeline:
  """The resolved output timeline of a RenderPlan."""

  fps: float
  clips: tuple[ClipTimeline, ...]
  cues: tuple[TimedCue, ...]
  duration_sec: float


@dataclasses.dataclass(frozen=True)
class LookSpan:
  """Output seconds during which one Look is on screen.

  Looks follow the video, so J-cuts and L-cuts move their boundaries
  together with the picture.
  """

  start: float
  end: float
  look: models.Look


@dataclasses.dataclass(frozen=True)
class Composition:
  """Everything needed to render (or hand over) one edit."""

  timeline: Timeline
  args: list[str]
  srt: str
  ass: str


# --------------------------------------------------------------------------
# Timeline
# --------------------------------------------------------------------------


def _snap(seconds: float, fps: float) -> float:
  return round(seconds * fps) / fps


def _floor_frames(seconds: float, fps: float) -> float:
  return math.floor(seconds * fps + _EPSILON) / fps


def _merge(spans: Sequence[Span]) -> list[Span]:
  merged: list[Span] = []
  for span in sorted(spans, key=lambda item: item.start):
    if merged and span.start <= merged[-1].end + _EPSILON:
      merged[-1] = Span(merged[-1].start, max(merged[-1].end, span.end))
    else:
      merged.append(span)
  return merged


def _apply_transition(
    video: list[list[Span]],
    transition: models.AudioTransition,
    fps: float,
    last_frame_time: float,
) -> None:
  """Shifts video boundaries between Clips for J-cuts and L-cuts in place."""
  lead = _snap(transition.duration_sec, fps)
  frame = 1.0 / fps
  if transition.kind == 'hard_cut' or lead <= 0:
    return
  for k in range(len(video) - 1):
    last = video[k][-1]
    first = video[k + 1][0]
    if transition.kind == 'j_cut':
      room = min(lead, last_frame_time - last.end, first.duration - frame)
      room = _floor_frames(max(0.0, room), fps)
      if room > 0:
        video[k][-1] = Span(last.start, last.end + room)
        video[k + 1][0] = Span(first.start + room, first.end)
    elif transition.kind == 'l_cut':
      room = min(lead, first.start, last.duration - frame)
      room = _floor_frames(max(0.0, room), fps)
      if room > 0:
        video[k][-1] = Span(last.start, last.end - room)
        video[k + 1][0] = Span(first.start - room, first.end)


def _to_output(seconds: float, clip: ClipTimeline) -> float:
  """Maps a source time inside a Clip to output time along its audio."""
  for span, offset in zip(clip.audio, clip.audio_offsets):
    if seconds <= span.start:
      return offset
    if seconds < span.end:
      return offset + (seconds - span.start)
  return clip.audio_offsets[-1] + clip.audio[-1].duration


def build_timeline(
    plan: models.RenderPlan, media: models.MediaInfo
) -> Timeline:
  """Quantizes Subcuts, applies the Audio Transition and maps captions.

  Args:
    plan: The edited Scenario.
    media: Frame rate and duration of the Source Video file.

  Returns:
    The output timeline.

  Raises:
    CompositionError: If a Subcut lies outside the Source Video or nothing
      is left to render.
  """
  fps = media.fps
  frame = 1.0 / fps
  last_frame_time = _floor_frames(media.duration_sec, fps)
  resolved: list[tuple[list[Span], int]] = []
  for plan_index, clip in enumerate(plan.clips):
    spans = []
    for subcut in clip.subcuts:
      if subcut.end_sec > media.duration_sec + frame:
        raise CompositionError(
            f'Clip {plan_index + 1}의 구간 끝({subcut.end_sec:.2f}s)이 원본 '
            f'길이({media.duration_sec:.2f}s)를 벗어납니다. 같은 영상을 '
            '업로드했는지 확인하세요.'
        )
      start = min(_snap(subcut.start_sec, fps), last_frame_time)
      end = min(_snap(subcut.end_sec, fps), last_frame_time)
      if end - start >= frame - _EPSILON:
        spans.append(Span(start, end))
    spans = _merge(spans)
    if spans:
      resolved.append((spans, plan_index))
  if not resolved:
    raise CompositionError('렌더할 구간이 없습니다. 모든 Subcut이 한 프레임보다 짧습니다.')

  audio = [list(spans) for spans, _ in resolved]
  video = [list(spans) for spans, _ in resolved]
  _apply_transition(video, plan.audio_transition, fps, last_frame_time)

  clips = []
  audio_cursor = 0.0
  for k, (_, plan_index) in enumerate(resolved):
    offsets = []
    for span in audio[k]:
      offsets.append(audio_cursor)
      audio_cursor += span.duration
    clips.append(
        ClipTimeline(
            video=tuple(video[k]),
            audio=tuple(audio[k]),
            audio_offsets=tuple(offsets),
            plan_index=plan_index,
        )
    )

  timeline_index = {
      plan_index: k for k, (_, plan_index) in enumerate(resolved)
  }
  cues = []
  for cue in plan.cues:
    k = timeline_index.get(cue.clip_index)
    if k is None:
      continue
    start = _to_output(cue.words[0].start_sec, clips[k])
    end = _to_output(cue.words[-1].end_sec, clips[k])
    if end - start >= frame:
      cues.append(
          TimedCue(
              start=start,
              end=end,
              text=' '.join(word.text for word in cue.words),
          )
      )
  cues.sort(key=lambda item: item.start)
  trimmed = []
  for index, cue in enumerate(cues):
    end = cue.end
    if index + 1 < len(cues):
      end = min(end, cues[index + 1].start)
    if end - cue.start >= frame:
      trimmed.append(dataclasses.replace(cue, end=end))
  return Timeline(
      fps=fps,
      clips=tuple(clips),
      cues=tuple(trimmed),
      duration_sec=audio_cursor,
  )


def look_spans(
    timeline: Timeline, plan: models.RenderPlan
) -> tuple[LookSpan, ...]:
  """Places each Clip's Look on the output timeline along its video.

  Consecutive Clips with equal Looks become one span, so nothing redraws
  at their boundary.

  Args:
    timeline: The resolved output timeline.
    plan: The plan whose RenderClips carry the Looks.

  Returns:
    Spans covering [0, timeline.duration_sec) in order.
  """
  spans: list[LookSpan] = []
  cursor = 0.0
  for clip in timeline.clips:
    look = plan.clips[clip.plan_index].look
    end = cursor + clip.video_duration
    if spans and spans[-1].look == look:
      spans[-1] = dataclasses.replace(spans[-1], end=end)
    else:
      spans.append(LookSpan(start=cursor, end=end, look=look))
    cursor = end
  return tuple(spans)


# --------------------------------------------------------------------------
# Captions
# --------------------------------------------------------------------------


def _srt_time(seconds: float) -> str:
  millis = round(max(0.0, seconds) * 1000)
  hours, millis = divmod(millis, 3_600_000)
  minutes, millis = divmod(millis, 60_000)
  secs, millis = divmod(millis, 1000)
  return f'{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}'


def _ass_time(seconds: float) -> str:
  centis = round(max(0.0, seconds) * 100)
  hours, centis = divmod(centis, 360_000)
  minutes, centis = divmod(centis, 6000)
  secs, centis = divmod(centis, 100)
  return f'{hours}:{minutes:02d}:{secs:02d}.{centis:02d}'


def _ass_color(hex_rgb: str, opacity: float = 1.0) -> str:
  """Converts #RRGGBB plus opacity into the ASS &HAABBGGRR form."""
  digits = hex_rgb.removeprefix('#').upper()
  red, green, blue = digits[0:2], digits[2:4], digits[4:6]
  alpha = round((1.0 - opacity) * 255)
  return f'&H{alpha:02X}{blue}{green}{red}'


def _ass_text(text: str) -> str:
  # Braces start override blocks and backslashes start escapes in ASS.
  return text.replace('\\', '/').replace('{', '(').replace('}', ')')


def build_srt(timeline: Timeline) -> str:
  """Returns the captions as SRT in output time."""
  blocks = []
  for number, cue in enumerate(timeline.cues, start=1):
    blocks.append(
        f'{number}\n{_srt_time(cue.start)} --> {_srt_time(cue.end)}\n'
        f'{cue.text}\n'
    )
  return '\n'.join(blocks)


def _drawing_number(value: float) -> str:
  return str(round(value))


def _corner_drawing(box: layout.Box, radius: float) -> str:
  """Returns ASS drawing commands that cover the four box corners.

  Each piece is the corner square minus a quarter circle, so filling it
  with the background color rounds the video box.
  """
  n = _drawing_number
  r = min(radius, box.width / 2, box.height / 2)
  c = r * _QUARTER_CIRCLE_KAPPA
  left, top = box.x, box.y
  right, bottom = box.x + box.width, box.y + box.height
  corners = [
      (
          (left, top),
          (left + r, top),
          (left + r - c, top),
          (left, top + r - c),
          (left, top + r),
      ),
      (
          (right, top),
          (right, top + r),
          (right, top + r - c),
          (right - r + c, top),
          (right - r, top),
      ),
      (
          (right, bottom),
          (right - r, bottom),
          (right - r + c, bottom),
          (right, bottom - r + c),
          (right, bottom - r),
      ),
      (
          (left, bottom),
          (left, bottom - r),
          (left, bottom - r + c),
          (left + r - c, bottom),
          (left + r, bottom),
      ),
  ]
  commands = []
  for corner, start, control_a, control_b, end in corners:
    commands.append(
        f'm {n(corner[0])} {n(corner[1])} l {n(start[0])} {n(start[1])} '
        f'b {n(control_a[0])} {n(control_a[1])} {n(control_b[0])} '
        f'{n(control_b[1])} {n(end[0])} {n(end[1])}'
    )
  return ' '.join(commands)


def _rounded_rect_path(
    box: layout.Box, radius: float, reverse: bool = False
) -> str:
  """Returns an ASS drawing contour of a rounded rectangle.

  The contour runs clockwise on screen, or counterclockwise when reverse
  is set; a reversed contour inside another one cuts a hole in it.
  """
  n = _drawing_number
  r = max(0.0, min(radius, box.width / 2, box.height / 2))
  # Distance of the Bezier control points from the corner.
  c = r * (1.0 - _QUARTER_CIRCLE_KAPPA)
  left, top = box.x, box.y
  right, bottom = box.x + box.width, box.y + box.height
  corners = [
      ((right - r, top), (right - c, top), (right, top + c), (right, top + r)),
      (
          (right, bottom - r),
          (right, bottom - c),
          (right - c, bottom),
          (right - r, bottom),
      ),
      ((left + r, bottom), (left + c, bottom), (left, bottom - c),
       (left, bottom - r)),
      ((left, top + r), (left, top + c), (left + c, top), (left + r, top)),
  ]
  if reverse:
    corners = [corner[::-1] for corner in reversed(corners)]
  first = corners[0][0]
  commands = [f'm {n(first[0])} {n(first[1])}']
  for start, control_a, control_b, end in corners:
    commands.append(f'l {n(start[0])} {n(start[1])}')
    if r > 0:
      commands.append(
          f'b {n(control_a[0])} {n(control_a[1])} {n(control_b[0])} '
          f'{n(control_b[1])} {n(end[0])} {n(end[1])}'
      )
  return ' '.join(commands)


def _border_drawing(box: layout.Box, radius: float, width: float) -> str:
  """Returns an ASS drawing of a ring of `width` around the video box."""
  outer = layout.Box(
      box.x - width, box.y - width, box.width + 2 * width,
      box.height + 2 * width,
  )
  outer_radius = radius + width if radius > 0 else 0.0
  return (
      f'{_rounded_rect_path(outer, outer_radius)} '
      f'{_rounded_rect_path(box, radius, reverse=True)}'
  )


def _override_color(hex_rgb: str) -> str:
  """Converts #RRGGBB into the &HBBGGRR& form of an ASS \\c override."""
  digits = hex_rgb.removeprefix('#').upper()
  return f'&H{digits[4:6]}{digits[2:4]}{digits[0:2]}&'


def _override_alpha(opacity: float) -> str:
  """Converts an opacity (0..1) into an ASS alpha override value."""
  return f'&H{round((1.0 - opacity) * 255):02X}&'


_HIDDEN = _override_alpha(0.0)


def _position(placement: models.TextPlacement) -> str:
  # Alignment 2 anchors the bottom center of the last line at \pos.
  return f'\\an2\\pos({round(placement.x)},{round(placement.y)})'


def _font_tags(text_style: models.TextStyle) -> str:
  font = fonts.get(text_style.font_id)
  return f'\\fn{font.family}\\b{1 if font.bold else 0}\\fs{text_style.size}'


def _text_tags(text_style: models.TextStyle) -> str:
  """Override tags of a text event: font, fill, outline."""
  return (
      f'{_font_tags(text_style)}\\c{_override_color(text_style.color)}'
      f'\\3c{_override_color(text_style.outline_color)}'
      f'\\bord{text_style.outline_width}\\shad0'
  )


def _box_tags(text_style: models.TextStyle, padding: int) -> str:
  """Override tags of a background event (style Box, BorderStyle 3).

  BorderStyle 3 draws an opaque box of the outline color around every
  line, padded by the outline width; the text itself stays invisible and
  the text event on the layer above draws it.
  """
  return (
      f'{_font_tags(text_style)}\\1a{_HIDDEN}'
      f'\\3c{_override_color(text_style.background_color)}'
      f'\\3a{_override_alpha(text_style.background_opacity)}'
      f'\\bord{padding}\\shad0'
  )


def _headline_body(
    headline: models.Headline,
    text_style: models.HeadlineStyle,
    line_gap: int,
    box_alpha: str | None,
) -> str:
  """Returns the Headline lines of one ASS event (after its tags).

  One event keeps the lines stacked when either of them wraps. An empty
  line of line_gap size between them adds the template's extra line
  spacing, since ASS has no line spacing setting. For the background
  event (box_alpha set) that spacer line gets no box.
  """
  lines = []
  accent = headline.accent.strip()
  main = headline.main.strip()
  for text, color in (
      (accent, text_style.accent_color),
      (main, text_style.color),
  ):
    if text:
      tint = '' if box_alpha else f'{{\\c{_override_color(color)}}}'
      lines.append(f'{tint}{_ass_text(text)}')
  if line_gap <= 0:
    return '\\N'.join(lines)
  if box_alpha:
    spacer = (
        f'\\N{{\\fs{line_gap}\\3a{_HIDDEN}}}\\h'
        f'{{\\fs{text_style.size}\\3a{box_alpha}}}\\N'
    )
  else:
    spacer = f'\\N{{\\fs{line_gap}}}\\h{{\\fs{text_style.size}}}\\N'
  return spacer.join(lines)


def _caption_side(box: layout.Box, style: models.TemplateStyle) -> int:
  """Side margin that wraps captions inside the video area."""
  return round(box.x + style.caption_side_padding)


# Event layers, bottom to top.
_LAYER_SHAPES = 0
_LAYER_HEADLINE_BOX = 1
_LAYER_HEADLINE = 2
_LAYER_CAPTION_BOX = 3
_LAYER_CAPTION = 4


def build_ass(
    timeline: Timeline,
    spans: Sequence[LookSpan],
    style: models.TemplateStyle,
    output_width: int,
) -> str:
  """Returns every Look's text, corner pieces and border as ASS.

  Each LookSpan gets its own Headline event and, for a boxed video, its
  own corner pieces (rounded box) and border ring, all in the span's
  colors and fonts. Captions follow the audio, so a caption that crosses
  a span boundary is split there and each piece is drawn the way that
  span's Look says. A text with a background gets a second event below it
  that draws only the boxes.

  Args:
    timeline: The resolved output timeline.
    spans: The Looks on the output timeline (see look_spans).
    style: The template geometry; its canvas size becomes PlayRes.
    output_width: Output width in pixels; the corner pieces follow the box
      exactly as ffmpeg places it at this width.

  Returns:
    The ASS document.
  """
  default_font = fonts.get(fonts.DEFAULT_CAPTION_FONT).family
  padding = style.text_box_padding

  def style_line(
      name: str, border_style: int, alignment: int, margin_side: int
  ) -> str:
    white = '&H00FFFFFF'
    black = '&H00000000'
    fields = [
        name, default_font, 40, white, white, black, black, 0, 0, 0, 0,
        100, 100, 0, 0, border_style, 0, 0, alignment, margin_side,
        margin_side, 0, 1,
    ]
    return 'Style: ' + ','.join(str(field) for field in fields)

  lines = [
      '[Script Info]',
      'ScriptType: v4.00+',
      f'PlayResX: {style.canvas_width}',
      f'PlayResY: {style.canvas_height}',
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, '
      'OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, '
      'ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, '
      'MarginL, MarginR, MarginV, Encoding',
      style_line('Shape', 1, 7, 0),
      # Text wraps within PlayResX minus the side margins, wherever \pos
      # puts it. Caption events override the margins with their span's
      # video area.
      style_line('Text', 1, 2, style.box_side_margin),
      style_line('Box', 3, 2, style.box_side_margin),
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, '
      'Effect, Text',
  ]

  def event(
      layer: int, start: float, end: float, name: str, side: int, text: str
  ) -> str:
    return (
        f'Dialogue: {layer},{_ass_time(start)},{_ass_time(end)},{name},,'
        f'{side},{side},0,,{text}'
    )

  for span in spans:
    look = span.look
    look_style = look.style
    framing = look.framing_layout
    box = layout.canvas_video_box(style, output_width, framing.fit)
    if framing.fit == 'box':
      radius = style.box_corner_radius if framing.rounded else 0
      shape = '{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\c'
      if radius:
        lines.append(event(
            _LAYER_SHAPES, span.start, span.end, 'Shape', 0,
            f'{shape}{_override_color(look_style.background_color)}}}'
            f'{_corner_drawing(box, radius)}',
        ))
      if look_style.border and look_style.border_width > 0:
        lines.append(event(
            _LAYER_SHAPES, span.start, span.end, 'Shape', 0,
            f'{shape}{_override_color(look_style.border_color)}}}'
            f'{_border_drawing(box, radius, look_style.border_width)}',
        ))
    headline_style = look_style.headline
    where = _position(look.text_layout.headline)
    text = _headline_body(
        look.headline, headline_style, style.headline_line_gap, None
    )
    if text:
      if headline_style.background:
        alpha = _override_alpha(headline_style.background_opacity)
        lines.append(event(
            _LAYER_HEADLINE_BOX, span.start, span.end, 'Box', 0,
            f'{{{where}{_box_tags(headline_style, padding)}}}'
            + _headline_body(
                look.headline, headline_style, style.headline_line_gap, alpha
            ),
        ))
      lines.append(event(
          _LAYER_HEADLINE, span.start, span.end, 'Text', 0,
          f'{{{where}{_text_tags(headline_style)}}}{text}',
      ))
  for cue in timeline.cues:
    for span in spans:
      start = max(cue.start, span.start)
      end = min(cue.end, span.end)
      if end - start < 1.0 / timeline.fps:
        continue
      caption_style = span.look.style.caption
      side = _caption_side(
          layout.canvas_video_box(
              style, output_width, span.look.framing_layout.fit
          ),
          style,
      )
      where = _position(span.look.text_layout.caption)
      if caption_style.background:
        lines.append(event(
            _LAYER_CAPTION_BOX, start, end, 'Box', side,
            f'{{{where}{_box_tags(caption_style, padding)}}}'
            f'{_ass_text(cue.text)}',
        ))
      lines.append(event(
          _LAYER_CAPTION, start, end, 'Text', side,
          f'{{{where}{_text_tags(caption_style)}}}{_ass_text(cue.text)}',
      ))
  return '\n'.join(lines) + '\n'


# --------------------------------------------------------------------------
# ffmpeg
# --------------------------------------------------------------------------


def _crop_filter(rect: tuple[int, int, int, int]) -> str:
  return 'crop={}:{}:{}:{}'.format(*rect)


def _template_filters(
    look: models.Look,
    media: models.MediaInfo,
    profile: models.RenderProfile,
    style: models.TemplateStyle,
) -> str:
  """Crops the video to the area its fit fills and places it on the canvas.

  A 'box' is scaled into the template's box and padded onto the background;
  a 'full' fit is scaled to the whole output.
  """
  framing = look.framing_layout
  box = layout.video_box(style, profile.width, framing.fit)
  rect = layout.crop_rect(
      framing.crop,
      layout.fit_aspect(style, framing.fit),
      media.width,
      media.height,
  )
  steps = [
      _crop_filter(rect),
      f'scale={box.width:.0f}:{box.height:.0f}:flags=lanczos,setsar=1',
  ]
  if framing.fit == 'box':
    color = '0x' + look.style.background_color.removeprefix('#')
    steps.append(
        f'pad={profile.width}:{profile.height}:{box.x:.0f}:{box.y:.0f}:'
        f'color={color}'
    )
  return ','.join(steps)


@dataclasses.dataclass(frozen=True)
class _ImageUse:
  """One Image Overlay shown during one LookSpan."""

  image: models.ImageOverlay
  start: float
  end: float


def _image_uses(spans: Sequence[LookSpan]) -> list[_ImageUse]:
  """Returns every image of every span, in ffmpeg input order."""
  return [
      _ImageUse(image=image, start=span.start, end=span.end)
      for span in spans
      for image in span.look.images
  ]


def _image_chains(
    uses: Sequence[_ImageUse],
    first_input: int,
    source: str,
    fps: float,
    profile: models.RenderProfile,
    style: models.TemplateStyle,
) -> tuple[list[str], str]:
  """Scales, rotates and overlays each image during its span.

  Later images of a span are drawn on top.

  Returns:
    (filter chains, label of the composited video).
  """
  scale = profile.width / style.canvas_width
  # Frame timestamps sit on the grid; half a frame earlier than each span
  # boundary picks exactly the span's frames despite rounding noise.
  half_frame = 0.5 / fps
  chains = []
  current = source
  for index, use in enumerate(uses):
    image = use.image
    width = max(1, round(image.width * scale))
    height = max(1, round(image.height * scale))
    steps = [f'format=rgba,scale={width}:{height}:flags=lanczos']
    if image.rotation_deg:
      angle = f'{math.radians(image.rotation_deg):.6f}'
      # Clockwise like CSS rotate(); the canvas grows to the rotated
      # bounding box and the new corners stay transparent.
      steps.append(f'rotate={angle}:ow=rotw({angle}):oh=roth({angle}):c=none')
    chains.append(
        f'[{first_input + index}:v:0]{",".join(steps)}[img{index}]'
    )
    center_x = image.x * scale
    center_y = image.y * scale
    start = max(0.0, use.start - half_frame)
    end = use.end - half_frame
    target = f'vimg{index}'
    # A still image is a one-frame stream; eof_action=repeat keeps it.
    chains.append(
        f'[{current}][img{index}]overlay='
        f'x={center_x:.2f}-overlay_w/2:y={center_y:.2f}-overlay_h/2:'
        f'eof_action=repeat:format=auto:'
        f"enable='gte(t,{start:.6f})*lt(t,{end:.6f})'[{target}]"
    )
    current = target
  return chains, current


def _music_chains(
    music: models.BackgroundMusic,
    music_input: int,
    voice: str,
    duration_sec: float,
    target: str,
) -> list[str]:
  """Loops, trims and fades the music, then mixes it under the voice."""
  fade = min(config.COMPOSITION.music_fade_out_sec, duration_sec)
  return [
      f'[{music_input}:a:0]atrim=duration={duration_sec:.6f},'
      f'asetpts=PTS-STARTPTS,volume={music.volume:.4f},'
      f'afade=t=out:st={duration_sec - fade:.6f}:d={fade:.4f}[music]',
      # duration=first keeps the output exactly as long as the voice, and
      # normalize=0 keeps the voice at its original level.
      f'[{voice}][music]amix=inputs=2:duration=first:dropout_transition=0:'
      f'normalize=0[{target}]',
  ]


def _fan_out(
    chains: list[str], source: str, filter_name: str, prefix: str, count: int
) -> list[str]:
  if count == 1:
    return [source]
  labels = [f'[{prefix}{index}]' for index in range(count)]
  chains.append(f'{source}{filter_name}={count}{"".join(labels)}')
  return labels


def _clip_window(clip: ClipTimeline) -> tuple[float, float]:
  start = min(clip.video[0].start, clip.audio[0].start)
  end = max(clip.video[-1].end, clip.audio[-1].end)
  return start, end


def _uses_music(plan: models.RenderPlan) -> bool:
  return plan.music is not None and plan.music.volume > 0


def _filter_graph(
    timeline: Timeline,
    plan: models.RenderPlan,
    spans: Sequence[LookSpan],
    media: models.MediaInfo,
    profile: models.RenderProfile,
    style: models.TemplateStyle,
    ass_filename: str,
    fonts_dir: str,
) -> str:
  half_frame = 0.5 / timeline.fps
  chains: list[str] = []
  clip_labels: list[str] = []
  audio_labels: list[str] = []
  for k, clip in enumerate(timeline.clips):
    window_start, _ = _clip_window(clip)
    count = len(clip.video)
    video_inputs = _fan_out(chains, f'[{k}:v:0]', 'split', f'vsrc{k}_', count)
    audio_inputs = _fan_out(chains, f'[{k}:a:0]', 'asplit', f'asrc{k}_', count)
    video_labels = []
    for i, (video, audio) in enumerate(zip(clip.video, clip.audio)):
      # Half a frame earlier than the grid time selects exactly the frames
      # whose timestamps fall on [start, end) even with rounding noise.
      video_start = max(0.0, video.start - window_start - half_frame)
      video_end = video.end - window_start - half_frame
      chains.append(
          f'{video_inputs[i]}trim=start={video_start:.6f}:end={video_end:.6f},'
          f'setpts=PTS-STARTPTS[v{k}_{i}]'
      )
      audio_start = audio.start - window_start
      edge = min(config.AUDIO_FADE_SEC, audio.duration / 4)
      chains.append(
          f'{audio_inputs[i]}atrim=start={audio_start:.6f}:'
          f'end={audio_start + audio.duration:.6f},asetpts=PTS-STARTPTS,'
          f'afade=t=in:st=0:d={edge:.4f},'
          f'afade=t=out:st={audio.duration - edge:.6f}:d={edge:.4f}[a{k}_{i}]'
      )
      video_labels.append(f'[v{k}_{i}]')
      audio_labels.append(f'[a{k}_{i}]')
    # Each Clip is framed by its own Look before the Clips are joined.
    look = plan.clips[clip.plan_index].look
    joined = (
        f'{"".join(video_labels)}concat=n={count}:v=1:a=0,'
        if count > 1
        else f'{video_labels[0]}'
    )
    chains.append(
        f'{joined}{_template_filters(look, media, profile, style)}'
        f'[vclip{k}]'
    )
    clip_labels.append(f'[vclip{k}]')
  music = _uses_music(plan)
  voice = 'avoice' if music else 'aout'
  chains.append(
      f'{"".join(clip_labels)}concat=n={len(clip_labels)}:v=1:a=0[vframe]'
  )
  chains.append(
      f'{"".join(audio_labels)}concat=n={len(audio_labels)}:v=0:a=1[{voice}]'
  )
  chains.append(
      f'[vframe]subtitles=filename={ass_filename}:fontsdir={fonts_dir}[vtext]'
  )
  uses = _image_uses(spans)
  image_start = len(timeline.clips)
  image_chains, video_out = _image_chains(
      uses, image_start, 'vtext', timeline.fps, profile, style
  )
  chains.extend(image_chains)
  chains.append(f'[{video_out}]null[vout]')
  if music and plan.music is not None:
    chains.extend(
        _music_chains(
            plan.music,
            image_start + len(uses),
            voice,
            timeline.duration_sec,
            'aout',
        )
    )
  return ';'.join(chains)


@dataclasses.dataclass(frozen=True)
class RenderPaths:
  """Where the ffmpeg command finds its inputs and writes its output.

  For a server render these are workspace paths; for an export they are
  bare file names the user keeps next to each other.
  """

  ffmpeg_bin: str
  source: str
  output: str
  # Image and music file of every asset id the plan uses.
  assets: Mapping[str, str] = dataclasses.field(default_factory=dict)
  # Folder holding the font files (see fonts.py).
  fonts_dir: str = str(fonts.FONT_DIR)


def _asset_path(asset_paths: Mapping[str, str], asset_id: str) -> str:
  path = asset_paths.get(asset_id)
  if path is None:
    raise CompositionError(
        '추가한 이미지나 음악 파일을 찾을 수 없습니다. 다시 추가하세요.'
    )
  return path


def build_ffmpeg_args(
    timeline: Timeline,
    plan: models.RenderPlan,
    spans: Sequence[LookSpan],
    media: models.MediaInfo,
    profile: models.RenderProfile,
    style: models.TemplateStyle,
    paths: RenderPaths,
) -> list[str]:
  """Builds the ffmpeg command line.

  Inputs are one seeked Source Video input per Clip, then one input per
  Image Overlay of every LookSpan, then the looped Background Music. The
  command burns in ASS_FILENAME from its working directory, which holds
  the Headlines, captions and rounded box corners.

  Args:
    timeline: The resolved output timeline.
    plan: The edited Scenario (per-Clip Looks, music).
    spans: The Looks on the output timeline (see look_spans).
    media: Size and frame rate of the Source Video file.
    profile: Output size and encoder settings.
    style: The template style.
    paths: Executable, input and output paths.

  Returns:
    The argument list.

  Raises:
    CompositionError: If an image or music file is not available.
  """
  frame = 1.0 / timeline.fps
  args = [paths.ffmpeg_bin, '-nostdin', '-hide_banner', '-y']
  for clip in timeline.clips:
    window_start, window_end = _clip_window(clip)
    duration = min(window_end + frame, media.duration_sec) - window_start
    args += [
        '-ss',
        f'{window_start:.6f}',
        '-t',
        f'{duration:.6f}',
        '-i',
        paths.source,
    ]
  for use in _image_uses(spans):
    args += ['-i', _asset_path(paths.assets, use.image.asset_id)]
  if _uses_music(plan) and plan.music is not None:
    args += [
        '-stream_loop',
        '-1',
        '-i',
        _asset_path(paths.assets, plan.music.asset_id),
    ]
  args += [
      '-filter_complex',
      _filter_graph(
          timeline, plan, spans, media, profile, style, ASS_FILENAME,
          paths.fonts_dir,
      ),
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-c:v',
      'libx264',
      '-preset',
      profile.x264_preset,
      '-crf',
      str(profile.crf),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      profile.audio_bitrate,
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      paths.output,
  ]
  return args


def plan_asset_ids(plan: models.RenderPlan) -> list[str]:
  """Returns the asset ids a plan reads, in input order, without repeats."""
  ids = [
      image.asset_id for clip in plan.clips for image in clip.look.images
  ]
  if _uses_music(plan) and plan.music is not None:
    ids.append(plan.music.asset_id)
  return list(dict.fromkeys(ids))


def plan_font_files(plan: models.RenderPlan) -> list[str]:
  """Returns the font file names a plan's Looks use, without repeats."""
  names = []
  for clip in plan.clips:
    for text_style in (clip.look.style.headline, clip.look.style.caption):
      names.append(fonts.get(text_style.font_id).filename)
  return list(dict.fromkeys(names))


def compose(
    plan: models.RenderPlan,
    media: models.MediaInfo,
    profile: models.RenderProfile,
    paths: RenderPaths,
) -> Composition:
  """Resolves a RenderPlan into a timeline, ffmpeg arguments and captions."""
  style = config.get_settings().template_style
  timeline = build_timeline(plan, media)
  spans = look_spans(timeline, plan)
  args = build_ffmpeg_args(
      timeline, plan, spans, media, profile, style, paths
  )
  return Composition(
      timeline=timeline,
      args=args,
      srt=build_srt(timeline),
      ass=build_ass(timeline, spans, style, profile.width),
  )


def _run(command: Sequence[str], cwd: pathlib.Path | None = None) -> str:
  settings = config.get_settings()
  try:
    proc = subprocess.run(
        list(command),
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=settings.subprocess_timeout_sec,
        check=False,
        stdin=subprocess.DEVNULL,
    )
  except (OSError, subprocess.SubprocessError) as exc:
    raise RenderError(f'{command[0]} 실행 실패: {exc}') from exc
  if proc.returncode != 0:
    tail = '\n'.join(proc.stderr.strip().splitlines()[-_STDERR_TAIL_LINES:])
    raise RenderError(f'{pathlib.Path(command[0]).name} 실패:\n{tail}')
  return proc.stdout


def run(composition: Composition, workdir: pathlib.Path) -> None:
  """Writes the captions next to the output and runs ffmpeg there."""
  (workdir / ASS_FILENAME).write_text(composition.ass, encoding='utf-8')
  _run(composition.args, cwd=workdir)


def measure_streams(path: pathlib.Path) -> tuple[float, float]:
  """Returns (video seconds, audio seconds) measured with ffprobe."""
  stdout = _run([
      config.get_settings().ffprobe_bin,
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      str(path),
  ])
  try:
    streams = json.loads(stdout).get('streams') or []
  except json.JSONDecodeError as exc:
    raise RenderError('ffprobe 출력이 JSON 형식이 아닙니다.') from exc
  durations = {'video': 0.0, 'audio': 0.0}
  for stream in streams:
    kind = stream.get('codec_type')
    if kind in durations:
      try:
        durations[kind] = float(stream.get('duration') or 0.0)
      except ValueError:
        durations[kind] = 0.0
  return durations['video'], durations['audio']
