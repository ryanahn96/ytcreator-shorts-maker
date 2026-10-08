"""API and domain models for the studio (terms follow CONTEXT.md).

Every model serializes to camelCase JSON, which is the contract mirrored by
frontend/src/types.ts, while Python code keeps snake_case attributes.
"""

from __future__ import annotations

import string
from typing import Annotated, Any, Literal

import pydantic
from pydantic import alias_generators

from yt.studio import fonts

MAX_CROP_ZOOM = 4.0
# Limits of the Look style controls, in canvas units (ASS sizes).
MIN_TEXT_SIZE = 16
MAX_TEXT_SIZE = 200
MAX_TEXT_OUTLINE = 12
MAX_BORDER_WIDTH = 40
# Background Music gain is at most the file's own level (the browser
# preview cannot boost an <audio> element either).
MAX_MUSIC_VOLUME = 1.0

# How the server calls Gemini:
#   ai_studio: Gemini Developer API with GEMINI_API_KEY.
#   vertex: Vertex AI (GOOGLE_GENAI_USE_VERTEXAI=true) with Application
#     Default Credentials, GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.
GeminiBackend = Literal['ai_studio', 'vertex']
# Files the user adds to a short besides the Source Video.
AssetKind = Literal['image', 'audio', 'video']
# Media backing a Clip in the Scenario sequence.
ClipMediaKind = Literal['source', 'image', 'video']
# Where the video goes on the canvas:
#   box: the template's box (or custom VideoBoxSpec) between Headline and
#     caption.
#   full: the whole 9:16 canvas; text and images are drawn over the video.
VideoFit = Literal['box', 'full']
# How a re-analysis of an already analyzed Source Video runs:
#   fast: text only, from the stored full transcript (no video sent).
#   deep: the video again, through its Gemini Context Cache when one is
#     still alive, for choices that need the picture (slides, faces, crop).
ReanalyzeMode = Literal['fast', 'deep']
# Visibility of a Shorts video uploaded to the creator's YouTube channel.
YouTubePrivacy = Literal['private', 'unlisted', 'public']
# Output resolution preset for MP4 rendering.
RenderQuality = Literal['1080p', '1440p', '2160p']


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


class VideoBoxSpec(StudioModel):
  """Custom video box geometry in canvas units (top-left x, y and size)."""

  x: float = pydantic.Field(ge=0.0)
  y: float = pydantic.Field(ge=0.0)
  width: float = pydantic.Field(ge=64.0)
  height: float = pydantic.Field(ge=64.0)


class FramingLayout(StudioModel):
  """How the source frame is placed on the canvas.

  In a 'box' fit the video sits in the template's box (or custom `box` when
  set) with square corners; in a 'full' fit it covers the whole 9:16 canvas.
  The crop has the aspect ratio of the area it fills, so zoom 1 is the
  largest crop of that ratio.
  """

  crop: CropRegion
  fit: VideoFit = 'box'
  box: VideoBoxSpec | None = None


class Headline(StudioModel):
  """The title shown above the video box for the whole short.

  Any number of lines, stacked top to bottom. The first line is drawn in
  the accent color, the others in the main headline color (both from the
  Look Style). Empty lines are skipped when drawing.
  """

  lines: list[str] = []

  def shown_lines(self) -> list[str]:
    """Returns the non-empty lines, stripped, in order."""
    return [line.strip() for line in self.lines if line.strip()]


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
  """The Headline's text style.

  color paints every line after the first, which takes accent_color.
  """

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
  """Metadata of the uploaded long-form Source Video."""

  # The uploaded file name without its extension.
  title: str
  duration_sec: float
  fps: float


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
  """A contiguous range of the Source Video or an inserted media asset."""

  clip_id: str
  start_sec: float = pydantic.Field(ge=0.0)
  end_sec: float = pydantic.Field(ge=0.0)
  speaker: str = ''
  purpose: str = ''
  # This Clip's own Look; None follows the Scenario's Look.
  look: Look | None = None
  media_kind: ClipMediaKind = 'source'
  asset_id: str | None = None
  mute_audio: bool = False


class Scenario(StudioModel):
  """An ordered sequence of Clips that forms one short.

  Clips follow each other with hard cuts: picture and sound change at the
  same instant.
  """

  scenario_id: str
  # Internal name used for tabs and file names; not drawn on the video.
  title: str
  rationale: str
  # The Look shared by every Clip without its own.
  look: Look
  music: BackgroundMusic | None = None
  clips: list[Clip]


class AnalysisReport(StudioModel):
  """What one analysis cost and how long it took, reported as measured."""

  # List price in USD of every Gemini call that returned usage, including
  # calls retried for an unusable answer. None when a call's model has no
  # known price or its usage is missing (see pricing.py).
  cost_usd: float | None
  # From the start of the analysis to its result, ingestion included.
  elapsed_sec: float
  warnings: list[str] = []


class YouTubeRetentionPoint(StudioModel):
  """One bucket of the YouTube Analytics Audience Retention curve.

  elapsed_ratio runs from 0.0 to 1.0 across the video length; watch_ratio is
  audienceWatchRatio and relative_performance is relativeRetentionPerformance
  (0..1, where > 0.5 beats videos of similar length).
  """

  elapsed_ratio: float = pydantic.Field(ge=0.0, le=1.0)
  watch_ratio: float = pydantic.Field(ge=0.0)
  relative_performance: float = pydantic.Field(ge=0.0, le=1.0)


class YouTubeRetentionPeak(StudioModel):
  """A high-retention peak or low-retention drop-off span in seconds."""

  start_sec: float = pydantic.Field(ge=0.0)
  end_sec: float = pydantic.Field(ge=0.0)
  watch_ratio: float = pydantic.Field(ge=0.0)
  relative_performance: float = pydantic.Field(ge=0.0, le=1.0)
  label: str = ''


class YouTubeComment(StudioModel):
  """A top-level viewer comment on a YouTube video."""

  comment_id: str
  author: str = ''
  text: str
  like_count: int = 0
  published_at: str = ''
  timestamp_sec: float | None = None


class YouTubeVideoContext(StudioModel):
  """Creator-owned YouTube data linked to a Source Video.

  Fetched through the creator's OAuth token from YouTube Data API v3 and
  YouTube Analytics API v2 and stored in the Workspace (youtube.json).
  """

  video_id: str
  title: str = ''
  published_at: str = ''
  duration_sec: float = 0.0
  view_count: int = 0
  like_count: int = 0
  comment_count: int = 0
  privacy_status: str = 'public'
  retention_points: list[YouTubeRetentionPoint] = []
  retention_peaks: list[YouTubeRetentionPeak] = []
  retention_lows: list[YouTubeRetentionPeak] = []
  comments: list[YouTubeComment] = []
  caption_words: list[TranscriptWord] = []
  caption_line_starts: list[int] = []
  caption_language: str = ''


class AnalysisResult(StudioModel):
  """Everything the editor needs after analyzing a Source Video."""

  source_video: SourceVideo
  transcript_words: list[TranscriptWord]
  line_start_indices: list[int]
  scenarios: list[Scenario]
  analysis: AnalysisReport
  silences: list[TimeRange] = []
  youtube_video_id: str = ''
  retention_points: list[YouTubeRetentionPoint] = []
  retention_peaks: list[YouTubeRetentionPeak] = []
  retention_lows: list[YouTubeRetentionPeak] = []
  youtube_comments: list[YouTubeComment] = []


class AnalyzeRequest(StudioModel):
  """Request body of the analyze endpoint."""

  # A file already sent to the upload-source endpoint.
  source_id: str = pydantic.Field(min_length=1)
  editorial_prompt: str = pydantic.Field(min_length=1)
  # Ignored by the first analysis of a Source Video, which always watches
  # the video and transcribes it in full; decides how later analyses run.
  mode: ReanalyzeMode = 'fast'
  # Optional YouTube video id from the signed-in creator's channel; when
  # given, its Audience Retention curve and official captions are fetched and
  # passed to Gemini.
  youtube_video_id: str = ''


class StoredTranscript(StudioModel):
  """The full transcript of a Source Video, extracted once.

  Kept in the Workspace (transcript.json) so a re-analysis can work from
  text alone instead of sending the video again.
  """

  words: list[TranscriptWord]
  line_start_indices: list[int]
  # The Gemini model that transcribed it.
  model: str = ''


class CachedVideoMeta(StudioModel):
  """A Gemini Context Cache that holds a Source Video's analysis proxy.

  Caches are per model and per backend; the entry is useless on another
  one. expire_time_epoch is Unix seconds.
  """

  name: str
  model: str
  backend: GeminiBackend
  expire_time_epoch: float
  token_count: int = 0

  def is_alive(self, now: float, margin_sec: float = 60.0) -> bool:
    """Whether the cache still exists at `now` plus a safety margin."""
    return self.expire_time_epoch - margin_sec > now


class RenderClip(StudioModel):
  """A Clip resolved into the Subcuts that are actually played."""

  subcuts: list[TimeRange] = pydantic.Field(min_length=1)
  # The Look shown while this Clip's video plays (its own or the
  # Scenario's, already resolved by the client).
  look: Look
  media_kind: ClipMediaKind = 'source'
  asset_id: str | None = None
  mute_audio: bool = False


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
  """An edited Scenario, resolved for rendering (hard cuts between Clips)."""

  clips: list[RenderClip] = pydantic.Field(min_length=1)
  cues: list[CaptionCue] = []
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


class UploadInitRequest(StudioModel):
  """Request body of the upload-source/init endpoint."""

  filename: str = pydantic.Field(min_length=1)
  size_bytes: int = pydantic.Field(gt=0)
  content_type: str = 'video/mp4'


class UploadInitResponse(StudioModel):
  """Response body of the upload-source/init endpoint."""

  mode: Literal['gcs', 'direct']
  source_id: str = ''
  upload_url: str = ''


class UploadCompleteRequest(StudioModel):
  """Request body of the upload-source/complete endpoint."""

  source_id: str = pydantic.Field(min_length=1)
  filename: str = pydantic.Field(min_length=1)
  size_bytes: int = pydantic.Field(gt=0)
  duration_sec: float = 0.0
  width: int = 0
  height: int = 0
  fps: float = 30.0
  has_audio: bool = True


class UploadedAsset(StudioModel):
  """An image, audio or video file added for clips, overlays or music."""

  asset_id: str
  kind: AssetKind
  filename: str
  size_bytes: int
  # Pixel size of an image or video; 0 for audio.
  width: int = 0
  height: int = 0
  # Length of an audio or video file; 0 for images.
  duration_sec: float = 0.0
  has_audio: bool = False


class RenderRequest(StudioModel):
  """Request body of the render endpoint."""

  source_id: str = pydantic.Field(min_length=1)
  plan: RenderPlan
  quality: RenderQuality = '1440p'


class RenderOutput(StudioModel):
  """A rendered short and its measured stream durations."""

  render_id: str
  video_url: str
  planned_duration_sec: float
  measured_video_sec: float
  measured_audio_sec: float
  width: int = 1440
  height: int = 2560


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
  # Linear gain a newly added Background Music starts with.
  default_music_volume: float
  # The music fades out over this long at the end of the short.
  music_fade_out_sec: float
  # Width of a newly added image, as a fraction of the canvas width.
  default_image_width_ratio: float


class TemplateStyle(StudioModel):
  """Geometry of the single short template, in canvas units.

  A solid background holds a square-cornered video box centered
  vertically, a Headline of one or more lines above the box and a one-line
  caption below the box, on the background rather than over the picture.
  A Clip may instead fill the whole canvas with its video, or customize
  its video box size and position. Colors and fonts live in each Look's
  LookStyle. The ASS file uses the canvas size as PlayRes, so renders at
  other sizes scale every value.
  """

  canvas_width: int
  canvas_height: int
  box_side_margin: int
  # Width / height of the video box; the crop uses the same ratio.
  box_aspect_ratio: float
  box_center_y: int
  # Extra space between consecutive Headline lines.
  headline_line_gap: int
  # Default distance from the bottom of the Headline to the box top.
  headline_gap: int
  # Space between text and the edge of its background box.
  text_box_padding: int
  # Default distance from the box bottom to the bottom of the caption line
  # (the caption's anchor), so the caption sits under the video.
  caption_gap: int
  # Horizontal room kept between the caption and the box edges; captions
  # wrap within the box width minus this padding on both sides.
  caption_side_padding: int
  # Default anchors (bottom of the last line) of the Headline and the
  # caption when the video fills the canvas ('full' fit).
  full_headline_y: int
  full_caption_y: int


class RenderProfile(StudioModel):
  """Output size and encoder settings of the render."""

  width: int
  height: int
  x264_preset: str
  crf: int
  audio_bitrate: str


class FontEntry(StudioModel):
  """A font the UI offers; the browser loads it from url."""

  font_id: str
  label: str
  url: str
  # CSS font-size per ASS font size (see fonts.em_per_line_box).
  em_per_line_box: float


class CreatorProfile(StudioModel):
  """Signed-in Google / YouTube creator account and channel metadata."""

  email: str = ''
  name: str = ''
  picture_url: str = ''
  channel_title: str = ''
  channel_handle: str = ''


class OAuthSession(StudioModel):
  """Server-side OAuth 2.0 session stored in the Workspace."""

  session_id: str
  access_token: str
  refresh_token: str = ''
  expires_at_epoch: float
  user: CreatorProfile


class AuthStatus(StudioModel):
  """Authentication state returned to the browser."""

  authenticated: bool
  oauth_configured: bool
  oauth_setup_error: str = ''
  user: CreatorProfile | None = None


class YouTubeVideoItem(StudioModel):
  """A long-form video from the signed-in creator's YouTube channel."""

  video_id: str
  title: str
  description: str = ''
  thumbnail_url: str = ''
  published_at: str = ''
  duration_sec: float = 0.0
  view_count: int = 0
  like_count: int = 0
  comment_count: int = 0
  privacy_status: str = 'public'
  has_captions: bool = False


class YouTubeVideoList(StudioModel):
  """Videos listed from the signed-in creator's YouTube channel."""

  videos: list[YouTubeVideoItem] = []


class YouTubeUploadRequest(StudioModel):
  """Request body of the YouTube Shorts upload endpoint."""

  render_id: str = pydantic.Field(min_length=1)
  title: str = pydantic.Field(min_length=1, max_length=100)
  description: str = ''
  privacy_status: YouTubePrivacy = 'private'


class YouTubeUploadResult(StudioModel):
  """Result of uploading a rendered Shorts MP4 to YouTube."""

  watch_url: str
  studio_url: str


class StudioConfig(StudioModel):
  """Static configuration the UI loads at startup."""

  default_editorial_prompt: str
  composition: CompositionSettings
  template_style: TemplateStyle
  # Where the text goes by default for each VideoFit.
  default_text_layouts: dict[str, TextLayout]
  # Colors and fonts of a new Look.
  default_look_style: LookStyle
  fonts: list[FontEntry]
  max_crop_zoom: float
  max_music_volume: float
  # Non-empty when bundled font files are missing.
  font_warning: str
  # Non-empty when the server cannot call Gemini; says what to configure.
  gemini_setup_error: str
  auth: AuthStatus
