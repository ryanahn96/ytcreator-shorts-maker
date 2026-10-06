"""API and domain models for the studio (terms follow CONTEXT.md).

Every model serializes to camelCase JSON, which is the contract mirrored by
frontend/src/types.ts, while Python code keeps snake_case attributes.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

import string

import pydantic
from pydantic import alias_generators

from yt.studio import fonts

MAX_CROP_ZOOM = 4.0
# Limits of the Look style controls, in canvas units (ASS sizes).
MIN_TEXT_SIZE = 16
MAX_TEXT_SIZE = 200
MAX_TEXT_OUTLINE = 12
MAX_BORDER_WIDTH = 40
MAX_TRANSITION_SEC = 1.0
# Background Music gain is at most the file's own level (the browser
# preview cannot boost an <audio> element either).
MAX_MUSIC_VOLUME = 1.0

# How the Transcript Words were obtained:
#   manual_aligned: uploaded captions with timing aligned to YouTube ASR words.
#   asr: YouTube automatic speech recognition words.
#   manual: uploaded captions only; word timing is interpolated inside lines.
#   gemini: no captions; Gemini transcribed the chosen Clips.
CaptionSource = Literal['manual_aligned', 'asr', 'manual', 'gemini']
RenderQuality = Literal['preview', 'final']
# How the server calls Gemini:
#   ai_studio: Gemini Developer API with GEMINI_API_KEY.
#   vertex: Vertex AI (GOOGLE_GENAI_USE_VERTEXAI=true) with Application
#     Default Credentials, GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.
GeminiBackend = Literal['ai_studio', 'vertex']
# Files the user adds to a short besides the Source Video.
AssetKind = Literal['image', 'audio']
# Where the video goes on the canvas:
#   box: the template's 16:9 box between the Headline and the bottom area.
#   full: the whole 9:16 canvas; text and images are drawn over the video.
VideoFit = Literal['box', 'full']


class StudioModel(pydantic.BaseModel):
  """Base model with camelCase JSON aliases."""

  model_config = pydantic.ConfigDict(
      alias_generator=alias_generators.to_camel,
      populate_by_name=True,
      extra='ignore',
  )

  def to_json(self) -> dict[str, Any]:
    """Returns a camelCase, JSON-compatible dict of this model."""
    return self.model_dump(by_alias=True, mode='json')


class CatalogEntry(StudioModel):
  """One selectable option that the UI lists with a label."""

  kind: str
  label: str
  description: str


AUDIO_TRANSITIONS: tuple[CatalogEntry, ...] = (
    CatalogEntry(
        kind='hard_cut',
        label='하드 컷',
        description='영상과 음성이 같은 지점에서 바뀝니다.',
    ),
    CatalogEntry(
        kind='j_cut',
        label='J컷',
        description='다음 Clip의 음성이 먼저 들리고 화면은 조금 늦게 바뀝니다.',
    ),
    CatalogEntry(
        kind='l_cut',
        label='L컷',
        description='화면이 먼저 바뀌고 이전 Clip의 음성이 조금 더 이어집니다.',
    ),
)

CAPTION_SOURCES: tuple[CatalogEntry, ...] = (
    CatalogEntry(
        kind='manual_aligned',
        label='업로드 자막 + ASR 타이밍',
        description='업로드된 자막 문장을 자동 자막의 단어 타이밍에 맞췄습니다.',
    ),
    CatalogEntry(
        kind='asr',
        label='자동 생성 자막',
        description='YouTube 음성 인식 단어와 타이밍을 그대로 씁니다.',
    ),
    CatalogEntry(
        kind='manual',
        label='업로드 자막 (타이밍 추정)',
        description='문장 안의 단어 타이밍은 글자 수로 나눈 추정값입니다.',
    ),
    CatalogEntry(
        kind='gemini',
        label='Gemini 받아쓰기',
        description='자막이 없어 Gemini가 선택한 Clip을 받아썼습니다.',
    ),
)


def catalog_kinds(catalog: tuple[CatalogEntry, ...]) -> list[str]:
  """Returns the kind identifiers of a catalog in display order."""
  return [entry.kind for entry in catalog]


def _require_kind(value: str, catalog: tuple[CatalogEntry, ...]) -> str:
  kinds = catalog_kinds(catalog)
  if value not in kinds:
    raise ValueError(f'{value!r} is not one of {kinds}')
  return value


def _hex_color(value: str) -> str:
  """Checks a #RRGGBB color and returns it in upper case."""
  digits = value.removeprefix('#')
  if (
      not value.startswith('#')
      or len(digits) != 6
      or any(char not in string.hexdigits for char in digits)
  ):
    raise ValueError(f'{value!r} is not a #RRGGBB color')
  return value.upper()


HexColor = Annotated[str, pydantic.AfterValidator(_hex_color)]


def _font_id(value: str) -> str:
  if value not in fonts.font_ids():
    raise ValueError(f'{value!r} is not one of {fonts.font_ids()}')
  return value


FontId = Annotated[str, pydantic.AfterValidator(_font_id)]


class TimeRange(StudioModel):
  """A half-open [start, end) range in Source Video seconds."""

  start_sec: float = pydantic.Field(ge=0.0)
  end_sec: float = pydantic.Field(ge=0.0)

  @pydantic.model_validator(mode='after')
  def _check_order(self) -> TimeRange:
    if self.end_sec <= self.start_sec:
      raise ValueError('endSec must be greater than startSec')
    return self


class CropRegion(StudioModel):
  """Normalized crop center (0..1) and zoom factor inside the source frame."""

  center_x: float = pydantic.Field(ge=0.0, le=1.0)
  center_y: float = pydantic.Field(ge=0.0, le=1.0)
  zoom: float = pydantic.Field(ge=1.0, le=MAX_CROP_ZOOM)


class FramingLayout(StudioModel):
  """How the source frame is placed on the canvas.

  In a 'box' fit the video sits in the template's box (rounded or square);
  in a 'full' fit it covers the whole 9:16 canvas. The crop has the aspect
  ratio of the area it fills, so zoom 1 is the largest crop of that ratio.
  """

  crop: CropRegion
  fit: VideoFit = 'box'
  # Rounds the box corners; ignored in a 'full' fit.
  rounded: bool = True


class Headline(StudioModel):
  """The two-line title shown above the video box for the whole short."""

  # First line, drawn in the accent color.
  accent: str = ''
  # Second line, drawn in the main headline color.
  main: str = ''


class AudioTransition(StudioModel):
  """The transition applied to every Clip boundary of a Scenario."""

  kind: str
  duration_sec: float = pydantic.Field(ge=0.0, le=MAX_TRANSITION_SEC)

  @pydantic.field_validator('kind')
  @classmethod
  def _known_kind(cls, value: str) -> str:
    return _require_kind(value, AUDIO_TRANSITIONS)


class TextPlacement(StudioModel):
  """Anchor of a text block: the bottom center of its last line.

  Values are canvas units, so they may leave the canvas while dragging;
  the renderer simply clips what falls outside.
  """

  x: float
  y: float


class TextLayout(StudioModel):
  """Where the Headline and the captions sit on the canvas."""

  headline: TextPlacement
  caption: TextPlacement


class TextStyle(StudioModel):
  """How a text block (Headline or caption) is drawn.

  size is an ASS font size: the height of one line box in canvas units.
  With background on, every line sits on a box of background_color,
  padded by the template's text_box_padding.
  """

  font_id: FontId
  size: int = pydantic.Field(ge=MIN_TEXT_SIZE, le=MAX_TEXT_SIZE)
  color: HexColor
  outline_color: HexColor
  outline_width: int = pydantic.Field(ge=0, le=MAX_TEXT_OUTLINE)
  background: bool = False
  background_color: HexColor = '#000000'
  background_opacity: float = pydantic.Field(default=0.6, ge=0.0, le=1.0)


class HeadlineStyle(TextStyle):
  """The Headline's text style; color is the second line's color."""

  accent_color: HexColor


class LookStyle(StudioModel):
  """Colors and fonts of a Look.

  background_color fills the canvas around a boxed video. The border is a
  ring of border_width outside the video box (a 'box' fit only).
  """

  background_color: HexColor
  border: bool = False
  border_color: HexColor = '#FFFFFF'
  border_width: int = pydantic.Field(default=6, ge=0, le=MAX_BORDER_WIDTH)
  headline: HeadlineStyle
  caption: TextStyle


class ImageOverlay(StudioModel):
  """An uploaded image drawn above the video and text for the whole short.

  x and y are the image center in canvas units; width and height are its
  size before rotation (the client keeps the image's aspect ratio).
  """

  overlay_id: str = pydantic.Field(min_length=1)
  asset_id: str = pydantic.Field(min_length=1)
  x: float
  y: float
  width: float = pydantic.Field(gt=0.0)
  height: float = pydantic.Field(gt=0.0)
  rotation_deg: float = pydantic.Field(default=0.0, ge=-180.0, le=180.0)


class BackgroundMusic(StudioModel):
  """An uploaded audio file looped under the original voice."""

  asset_id: str = pydantic.Field(min_length=1)
  # Linear gain applied to the music; the voice always stays at 1.
  volume: float = pydantic.Field(ge=0.0, le=MAX_MUSIC_VOLUME)


class SourceVideo(StudioModel):
  """Metadata of the long-form Source Video."""

  video_id: str
  url: str
  title: str
  channel: str
  duration_sec: float
  language: str
  fps: float
  width: int
  height: int
  thumbnail_url: str
  caption_source: CaptionSource


class TranscriptWord(StudioModel):
  """A timed word of the Source Video transcript."""

  index: int
  text: str
  start_sec: float
  end_sec: float
  is_sound_tag: bool = False


class Look(StudioModel):
  """Everything drawn on screen while a Clip plays.

  A Scenario has one Look that every Clip shares; a Clip may carry its own
  Look instead (a copy the user then edits for that Clip only).
  """

  headline: Headline = Headline()
  framing_layout: FramingLayout
  text_layout: TextLayout
  style: LookStyle
  images: list[ImageOverlay] = []


class Clip(StudioModel):
  """A contiguous range of the Source Video used inside a Scenario."""

  clip_id: str
  start_sec: float = pydantic.Field(ge=0.0)
  end_sec: float = pydantic.Field(ge=0.0)
  speaker: str = ''
  purpose: str = ''
  # This Clip's own Look; None follows the Scenario's Look.
  look: Look | None = None


class Scenario(StudioModel):
  """An ordered sequence of Clips that forms one short."""

  scenario_id: str
  # Internal name used for tabs and file names; not drawn on the video.
  title: str
  rationale: str
  # The Look shared by every Clip without its own.
  look: Look
  audio_transition: AudioTransition
  music: BackgroundMusic | None = None
  clips: list[Clip]


class AnalysisReport(StudioModel):
  """How the Gemini analysis ran, reported as measured."""

  gemini_backend: GeminiBackend
  gemini_model: str
  media_processing: str
  structured_output: bool
  agentic_steps: int
  tool_use_tokens: int
  thoughts_tokens: int
  elapsed_sec: float
  warnings: list[str] = []


class AnalysisResult(StudioModel):
  """Everything the editor needs after analyzing a Source Video."""

  source_video: SourceVideo
  transcript_words: list[TranscriptWord]
  line_start_indices: list[int]
  video_summary: str
  speakers: list[str]
  scenarios: list[Scenario]
  cut_word_indices: list[int]
  analysis: AnalysisReport


class AnalyzeRequest(StudioModel):
  """Request body of the analyze endpoint.

  Exactly one of youtube_url and source_id names the Source Video: a
  YouTube URL, or a file already sent to the upload-source endpoint.
  """

  youtube_url: str = ''
  source_id: str = ''
  editorial_prompt: str = pydantic.Field(min_length=1)

  @pydantic.model_validator(mode='after')
  def _one_source(self) -> AnalyzeRequest:
    if bool(self.youtube_url.strip()) == bool(self.source_id.strip()):
      raise ValueError('youtubeUrl과 sourceId 중 하나만 보내야 합니다.')
    return self


class RenderClip(StudioModel):
  """A Clip resolved into the Subcuts that are actually played."""

  subcuts: list[TimeRange] = pydantic.Field(min_length=1)
  # The Look shown while this Clip's video plays (its own or the
  # Scenario's, already resolved by the client).
  look: Look


class CueWord(StudioModel):
  """A caption word in Source Video seconds."""

  text: str
  start_sec: float = pydantic.Field(ge=0.0)
  end_sec: float = pydantic.Field(ge=0.0)


class CaptionCue(StudioModel):
  """A caption line that belongs to one RenderClip."""

  clip_index: int = pydantic.Field(ge=0)
  words: list[CueWord] = pydantic.Field(min_length=1)


class RenderPlan(StudioModel):
  """An edited Scenario, resolved for rendering or export."""

  clips: list[RenderClip] = pydantic.Field(min_length=1)
  cues: list[CaptionCue] = []
  audio_transition: AudioTransition
  music: BackgroundMusic | None = None


class MediaInfo(StudioModel):
  """Stream properties of a media file."""

  duration_sec: float = pydantic.Field(gt=0.0)
  fps: float = pydantic.Field(gt=0.0)
  width: int = pydantic.Field(gt=0)
  height: int = pydantic.Field(gt=0)


class UploadedSource(StudioModel):
  """An MP4 of the Source Video uploaded by the user."""

  source_id: str
  filename: str
  size_bytes: int
  media: MediaInfo
  has_audio: bool
  silences: list[TimeRange]


class UploadedAsset(StudioModel):
  """An image or audio file the user added for overlays or music."""

  asset_id: str
  kind: AssetKind
  filename: str
  size_bytes: int
  # Pixel size of an image; 0 for audio.
  width: int = 0
  height: int = 0
  # Length of an audio file; 0 for images.
  duration_sec: float = 0.0


class RenderRequest(StudioModel):
  """Request body of the render endpoint."""

  source_id: str = pydantic.Field(min_length=1)
  quality: RenderQuality = 'preview'
  plan: RenderPlan


class ExportRequest(StudioModel):
  """Request body of the export endpoint (no upload needed)."""

  media: MediaInfo
  source_filename: str = pydantic.Field(default='source.mp4', min_length=1)
  quality: RenderQuality = 'final'
  plan: RenderPlan


class ExportOutput(StudioModel):
  """An ffmpeg command plus captions for running the edit elsewhere."""

  planned_duration_sec: float
  ffmpeg_command: str
  srt: str
  ass: str
  # The command reads the ASS captions from this file name.
  ass_filename: str
  # Image and music files the command reads, besides the Source Video.
  asset_filenames: list[str] = []


class RenderOutput(ExportOutput):
  """A rendered short and its measured stream durations."""

  render_id: str
  video_url: str
  measured_video_sec: float
  measured_audio_sec: float
  elapsed_sec: float


class CompositionSettings(StudioModel):
  """Editor defaults for Subcuts, captions, range editing and music."""

  silence_threshold_sec: float
  cut_margin_sec: float
  min_subcut_sec: float
  caption_max_chars: int
  caption_max_gap_sec: float
  new_clip_sec: float
  edit_window_pad_sec: float
  nudge_steps_sec: list[float]
  duration_tolerance_sec: float
  # Linear gain a newly added Background Music starts with.
  default_music_volume: float
  # The music fades out over this long at the end of the short.
  music_fade_out_sec: float
  # Width of a newly added image, as a fraction of the canvas width.
  default_image_width_ratio: float


class TemplateStyle(StudioModel):
  """Geometry of the single short template, in canvas units.

  A solid background holds a video box (rounded or square) centered
  vertically, a two-line Headline above the box and a one-line caption
  inside the box near its bottom edge. A Clip may instead fill the whole
  canvas with its video, and then the text sits over the video. Colors
  and fonts live in each Look's LookStyle. The ASS file uses the canvas
  size as PlayRes, so renders at other sizes scale every value.
  """

  canvas_width: int
  canvas_height: int
  box_side_margin: int
  # Width / height of the video box; the crop uses the same ratio.
  box_aspect_ratio: float
  box_center_y: int
  box_corner_radius: int
  # Extra space between the accent line and the main line.
  headline_line_gap: int
  # Default distance from the bottom of the Headline to the box top.
  headline_gap: int
  # Space between text and the edge of its background box.
  text_box_padding: int
  # Default distance from the bottom of the caption line to the box bottom.
  caption_bottom_inset: int
  # Horizontal room kept between the caption and the box edges; captions
  # wrap within the box width minus this padding on both sides.
  caption_side_padding: int
  # Default anchors (bottom of the last line) of the Headline and the
  # caption when the video fills the canvas ('full' fit).
  full_headline_y: int
  full_caption_y: int


class RenderProfile(StudioModel):
  """Output size and encoder settings of one render quality."""

  width: int
  height: int
  x264_preset: str
  crf: int
  audio_bitrate: str


class FontEntry(StudioModel):
  """A font the UI offers; the browser loads it from url."""

  font_id: str
  label: str
  family: str
  url: str
  bold: bool
  # CSS font-size per ASS font size (see fonts.em_per_line_box).
  em_per_line_box: float


class StudioConfig(StudioModel):
  """Static configuration the UI loads at startup."""

  default_editorial_prompt: str
  audio_transitions: list[CatalogEntry]
  caption_sources: list[CatalogEntry]
  composition: CompositionSettings
  template_style: TemplateStyle
  # Where the text goes by default for each VideoFit.
  default_text_layouts: dict[str, TextLayout]
  # Colors and fonts of a new Look.
  default_look_style: LookStyle
  fonts: list[FontEntry]
  render_profiles: dict[str, RenderProfile]
  max_crop_zoom: float
  max_transition_sec: float
  max_music_volume: float
  # Non-empty when bundled font files are missing.
  font_warning: str
  gemini_backend: GeminiBackend
  # Vertex AI target; shown only when gemini_backend is 'vertex'.
  vertex_project: str
  vertex_location: str
  # Non-empty when the server cannot call Gemini; says what to configure.
  gemini_setup_error: str
  model_chain: list[str]
