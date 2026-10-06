/**
 * API contract of the studio backend. Mirrors yt/studio/models.py, whose
 * pydantic models serialize to exactly these camelCase shapes.
 *
 * Terms follow CONTEXT.md: Source Video, Transcript Word, Editorial Prompt,
 * Scenario, Clip, Subcut, Look, Framing Layout, Audio Transition, Text
 * Layout, Image Overlay, Background Music.
 */

export type RenderQuality = 'preview' | 'final';
/** How the server calls Gemini: API key (AI Studio) or Vertex AI with ADC. */
export type GeminiBackend = 'ai_studio' | 'vertex';
/** Files the user adds to a short besides the Source Video. */
export type AssetKind = 'image' | 'audio';
/**
 * Where the video goes: the template's 16:9 box, or the whole 9:16 canvas
 * with text and images drawn over the video.
 */
export type VideoFit = 'box' | 'full';

/** One selectable option (framing, transition, caption source). */
export interface CatalogEntry {
  kind: string;
  label: string;
  description: string;
}

/** A half-open [startSec, endSec) range in Source Video seconds. */
export interface TimeRange {
  startSec: number;
  endSec: number;
}

/** Normalized crop center (0..1) and zoom (1 = largest crop that fits). */
export interface CropRegion {
  centerX: number;
  centerY: number;
  zoom: number;
}

/**
 * How the source frame is placed on the canvas. The crop has the aspect
 * ratio of the area it fills (box or canvas), so zoom 1 is the largest crop
 * of that ratio.
 */
export interface FramingLayout {
  crop: CropRegion;
  fit: VideoFit;
  /** Rounds the box corners; ignored in a 'full' fit. */
  rounded: boolean;
}

/** The two-line title above the video box for the whole short. */
export interface Headline {
  /** First line, drawn in the accent color. */
  accent: string;
  /** Second line, drawn in the main headline color. */
  main: string;
}

/**
 * Anchor of a text block in canvas units: the bottom center of its last
 * line (ASS alignment 2 with \pos).
 */
export interface TextPlacement {
  x: number;
  y: number;
}

/** Where the Headline and the captions sit on the canvas. */
export interface TextLayout {
  headline: TextPlacement;
  caption: TextPlacement;
}

/**
 * An uploaded image drawn above the video and text for the whole short.
 * x/y is its center and width/height its size before rotation, in canvas
 * units; rotationDeg turns it clockwise.
 */
export interface ImageOverlay {
  overlayId: string;
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDeg: number;
}

/** An uploaded audio file looped under the original voice. */
export interface BackgroundMusic {
  assetId: string;
  /** Linear gain, 0..maxMusicVolume. */
  volume: number;
}

/** The transition applied to every Clip boundary of a Scenario. */
export interface AudioTransition {
  kind: string;
  durationSec: number;
}

export interface SourceVideo {
  videoId: string;
  url: string;
  title: string;
  channel: string;
  durationSec: number;
  language: string;
  fps: number;
  width: number;
  height: number;
  thumbnailUrl: string;
  captionSource: string;
}

export interface TranscriptWord {
  index: number;
  text: string;
  startSec: number;
  endSec: number;
  isSoundTag: boolean;
}

/**
 * Everything drawn on screen while a Clip plays. A Scenario has one Look
 * that every Clip shares; a Clip may carry its own copy instead.
 */
/**
 * How a text block is drawn. size is an ASS font size (one line box in
 * canvas units); with background on, every line sits on a padded box.
 */
export interface TextStyle {
  fontId: string;
  size: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  background: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
}

/** The Headline's text style; color is the second line's color. */
export interface HeadlineStyle extends TextStyle {
  accentColor: string;
}

/** Colors and fonts of a Look. The border rings a boxed video only. */
export interface LookStyle {
  backgroundColor: string;
  border: boolean;
  borderColor: string;
  borderWidth: number;
  headline: HeadlineStyle;
  caption: TextStyle;
}

export interface Look {
  headline: Headline;
  framingLayout: FramingLayout;
  textLayout: TextLayout;
  style: LookStyle;
  images: ImageOverlay[];
}

export interface Clip {
  clipId: string;
  startSec: number;
  endSec: number;
  speaker: string;
  purpose: string;
  /** This Clip's own Look; null follows the Scenario's Look. */
  look: Look | null;
}

export interface Scenario {
  scenarioId: string;
  /** Internal name for tabs and file names; not drawn on the video. */
  title: string;
  rationale: string;
  /** The Look shared by every Clip without its own. */
  look: Look;
  audioTransition: AudioTransition;
  music: BackgroundMusic | null;
  clips: Clip[];
}

export interface AnalysisReport {
  geminiBackend: GeminiBackend;
  geminiModel: string;
  mediaProcessing: string;
  structuredOutput: boolean;
  agenticSteps: number;
  toolUseTokens: number;
  thoughtsTokens: number;
  elapsedSec: number;
  warnings: string[];
}

export interface AnalysisResult {
  sourceVideo: SourceVideo;
  transcriptWords: TranscriptWord[];
  lineStartIndices: number[];
  videoSummary: string;
  speakers: string[];
  scenarios: Scenario[];
  cutWordIndices: number[];
  analysis: AnalysisReport;
}

/** Exactly one of youtubeUrl and sourceId is non-empty. */
export interface AnalyzeRequest {
  youtubeUrl: string;
  /** An upload from the upload-source endpoint, analyzed as the source. */
  sourceId: string;
  editorialPrompt: string;
}

/** One NDJSON event of the analyze stream. */
export type AnalyzeEvent =
  | {
      type: 'progress';
      stage: string;
      message: string;
      elapsedSec: number;
      model?: string;
      agenticSteps?: number;
      attempt?: number;
    }
  | {type: 'heartbeat'; elapsedSec: number}
  | {type: 'result'; result: AnalysisResult}
  | {type: 'error'; error: string};

/** A Clip resolved into the Subcuts that are actually played. */
export interface RenderClip {
  subcuts: TimeRange[];
  /** The Look shown while this Clip's video plays, already resolved. */
  look: Look;
}

export interface CueWord {
  text: string;
  startSec: number;
  endSec: number;
}

/** A caption line; clipIndex points into RenderPlan.clips. */
export interface CaptionCue {
  clipIndex: number;
  words: CueWord[];
}

export interface RenderPlan {
  clips: RenderClip[];
  cues: CaptionCue[];
  audioTransition: AudioTransition;
  music: BackgroundMusic | null;
}

export interface MediaInfo {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
}

export interface UploadedSource {
  sourceId: string;
  filename: string;
  sizeBytes: number;
  media: MediaInfo;
  hasAudio: boolean;
  silences: TimeRange[];
}

export interface UploadedAsset {
  assetId: string;
  kind: AssetKind;
  filename: string;
  sizeBytes: number;
  /** Pixel size of an image; 0 for audio. */
  width: number;
  height: number;
  /** Length of an audio file; 0 for images. */
  durationSec: number;
}

export interface RenderRequest {
  sourceId: string;
  quality: RenderQuality;
  plan: RenderPlan;
}

export interface ExportRequest {
  media: MediaInfo;
  sourceFilename: string;
  quality: RenderQuality;
  plan: RenderPlan;
}

export interface ExportOutput {
  plannedDurationSec: number;
  ffmpegCommand: string;
  srt: string;
  ass: string;
  /** The command reads the ASS captions from this file name. */
  assFilename: string;
  /** Image and music files the command reads, besides the Source Video. */
  assetFilenames: string[];
}

export interface RenderOutput extends ExportOutput {
  renderId: string;
  videoUrl: string;
  measuredVideoSec: number;
  measuredAudioSec: number;
  elapsedSec: number;
}

export interface CompositionSettings {
  silenceThresholdSec: number;
  cutMarginSec: number;
  minSubcutSec: number;
  captionMaxChars: number;
  captionMaxGapSec: number;
  newClipSec: number;
  editWindowPadSec: number;
  nudgeStepsSec: number[];
  durationToleranceSec: number;
  /** Linear gain a newly added Background Music starts with. */
  defaultMusicVolume: number;
  /** The music fades out over this long at the end of the short. */
  musicFadeOutSec: number;
  /** Width of a newly added image, as a fraction of the canvas width. */
  defaultImageWidthRatio: number;
}

/**
 * The single short template in canvas units (the ASS PlayRes): a video box
 * (rounded or square) on a solid background, a two-line Headline above it
 * and a one-line caption inside it near the bottom. A Clip may instead fill
 * the whole canvas with its video. This is its geometry only; colors and
 * fonts are per Look (LookStyle).
 */
export interface TemplateStyle {
  canvasWidth: number;
  canvasHeight: number;
  boxSideMargin: number;
  /** Width / height of the video box; the crop uses the same ratio. */
  boxAspectRatio: number;
  boxCenterY: number;
  boxCornerRadius: number;
  /** Extra space between the accent line and the main line. */
  headlineLineGap: number;
  /** Default distance from the bottom of the Headline to the box top. */
  headlineGap: number;
  /** Space between text and the edge of its background box. */
  textBoxPadding: number;
  /** Default distance from the bottom of the caption line to the box bottom. */
  captionBottomInset: number;
  /** Captions wrap within the box width minus this padding on both sides. */
  captionSidePadding: number;
  /** Default text anchors when the video fills the canvas ('full' fit). */
  fullHeadlineY: number;
  fullCaptionY: number;
}

export interface RenderProfile {
  width: number;
  height: number;
  x264Preset: string;
  crf: number;
  audioBitrate: string;
}

/** A bundled font; the browser loads the same file ffmpeg uses. */
export interface FontEntry {
  fontId: string;
  label: string;
  family: string;
  url: string;
  bold: boolean;
  /** CSS font-size per ASS font size. */
  emPerLineBox: number;
}

export interface StudioConfig {
  defaultEditorialPrompt: string;
  audioTransitions: CatalogEntry[];
  captionSources: CatalogEntry[];
  composition: CompositionSettings;
  templateStyle: TemplateStyle;
  /** Where the text goes by default for each VideoFit. */
  defaultTextLayouts: Record<VideoFit, TextLayout>;
  /** Colors and fonts of a new Look. */
  defaultLookStyle: LookStyle;
  fonts: FontEntry[];
  renderProfiles: Record<RenderQuality, RenderProfile>;
  maxCropZoom: number;
  maxTransitionSec: number;
  maxMusicVolume: number;
  /** Non-empty when bundled font files are missing. */
  fontWarning: string;
  geminiBackend: GeminiBackend;
  /** Vertex AI target; shown only when geminiBackend is 'vertex'. */
  vertexProject: string;
  vertexLocation: string;
  /** Non-empty when the server cannot call Gemini; says what to configure. */
  geminiSetupError: string;
  modelChain: string[];
}
