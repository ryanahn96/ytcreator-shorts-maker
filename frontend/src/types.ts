/**
 * API contract of the studio backend. Mirrors yt/studio/models.py, whose
 * pydantic models serialize to exactly these camelCase shapes.
 *
 * Terms follow CONTEXT.md: Source Video, Transcript Word, Editorial Prompt,
 * Scenario, Clip, Subcut, Look, Framing Layout, Text Layout, Image Overlay,
 * Background Music.
 */

/** Files the user adds to a short besides the Source Video. */
export type AssetKind = 'image' | 'audio' | 'video';
/** What media a Clip plays on the timeline. */
export type ClipMediaKind = 'source' | 'image' | 'video';
/**
 * Where the video goes: a rectangular box on the 9:16 canvas, or the whole
 * 9:16 canvas with text and images drawn over the video.
 */
export type VideoFit = 'box' | 'full';
/**
 * How a re-analysis of an already analyzed Source Video runs: 'fast' from
 * the stored full transcript alone, 'deep' with the video again (through
 * its Gemini Context Cache while that lives) for choices that need the
 * picture.
 */
export type ReanalyzeMode = 'fast' | 'deep';

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

/** Custom video frame rectangle in canvas units (1080x1920). */
export interface VideoBoxSpec {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How the source frame is placed on the canvas. The crop has the aspect
 * ratio of the area it fills (box or canvas), so zoom 1 is the largest crop
 * of that ratio.
 */
export interface FramingLayout {
  crop: CropRegion;
  fit: VideoFit;
  /** Custom box geometry in canvas units; null/undefined uses template default. */
  box?: VideoBoxSpec | null;
}

/**
 * The title above the video box for the whole short: any number of lines,
 * top to bottom. The first line is drawn in the accent color, the others in
 * the main headline color; empty lines are skipped.
 */
export interface Headline {
  lines: string[];
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

/** The uploaded Source Video. */
export interface SourceVideo {
  /** The uploaded file name without its extension. */
  title: string;
  durationSec: number;
  fps: number;
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

/**
 * The Headline's text style; color paints every line after the first,
 * which takes accentColor.
 */
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
  mediaKind?: ClipMediaKind;
  assetId?: string | null;
  muteAudio?: boolean;
}

export interface Scenario {
  scenarioId: string;
  /** Internal name for tabs and file names; not drawn on the video. */
  title: string;
  rationale: string;
  /** The Look shared by every Clip without its own. */
  look: Look;
  music: BackgroundMusic | null;
  /** Clips follow each other with hard cuts. */
  clips: Clip[];
}

export interface AnalysisReport {
  /**
   * List price in USD of every Gemini call of the analysis that returned
   * usage; null when a model has no known price or usage was missing.
   */
  costUsd: number | null;
  /** From the start of the analysis to its result. */
  elapsedSec: number;
  warnings: string[];
}

export type YouTubePrivacy = 'private' | 'unlisted' | 'public';

export interface YouTubeRetentionPoint {
  elapsedRatio: number;
  watchRatio: number;
  relativePerformance: number;
}

export interface YouTubeRetentionPeak {
  startSec: number;
  endSec: number;
  watchRatio: number;
  relativePerformance: number;
  label: string;
}

export interface YouTubeComment {
  commentId: string;
  author: string;
  text: string;
  likeCount: number;
  publishedAt: string;
  timestampSec: number | null;
}

export interface YouTubeVideoContext {
  videoId: string;
  title: string;
  publishedAt: string;
  durationSec: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  privacyStatus: string;
  retentionPoints: YouTubeRetentionPoint[];
  retentionPeaks: YouTubeRetentionPeak[];
  retentionLows: YouTubeRetentionPeak[];
  comments: YouTubeComment[];
  captionWords: TranscriptWord[];
  captionLineStarts: number[];
  captionLanguage: string;
}

export interface CreatorProfile {
  email: string;
  name: string;
  pictureUrl: string;
  channelTitle: string;
  channelHandle: string;
}

export interface AuthStatus {
  authenticated: boolean;
  oauthConfigured: boolean;
  oauthSetupError: string;
  user: CreatorProfile | null;
}

export interface YouTubeVideoItem {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  publishedAt: string;
  durationSec: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  privacyStatus: string;
  hasCaptions: boolean;
}

export interface YouTubeVideoList {
  videos: YouTubeVideoItem[];
}

export interface YouTubeUploadRequest {
  renderId: string;
  title: string;
  description: string;
  privacyStatus: YouTubePrivacy;
}

export interface YouTubeUploadResult {
  watchUrl: string;
  studioUrl: string;
}

export interface AnalysisResult {
  sourceVideo: SourceVideo;
  transcriptWords: TranscriptWord[];
  lineStartIndices: number[];
  scenarios: Scenario[];
  analysis: AnalysisReport;
  silences: TimeRange[];
  youtubeVideoId?: string;
  retentionPoints?: YouTubeRetentionPoint[];
  retentionPeaks?: YouTubeRetentionPeak[];
  retentionLows?: YouTubeRetentionPeak[];
  youtubeComments?: YouTubeComment[];
}

export interface AnalyzeRequest {
  /** An upload from the upload-source endpoint. */
  sourceId: string;
  editorialPrompt: string;
  /**
   * How to run when the Source Video was analyzed before; the first
   * analysis always watches the video and transcribes it in full.
   */
  mode: ReanalyzeMode;
  /**
   * Optional YouTube video ID from the signed-in creator's channel to pull
   * Audience Retention peaks and official captions for this Source Video.
   */
  youtubeVideoId?: string;
}

/** One NDJSON event of the analyze stream. */
export type AnalyzeEvent =
  | {type: 'progress'; stage: string; message: string}
  | {type: 'heartbeat'}
  | {type: 'result'; result: AnalysisResult}
  | {type: 'error'; error: string};

/** A Clip resolved into the Subcuts that are actually played. */
export interface RenderClip {
  subcuts: TimeRange[];
  /** The Look shown while this Clip's video plays, already resolved. */
  look: Look;
  mediaKind?: ClipMediaKind;
  assetId?: string | null;
  muteAudio?: boolean;
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

/** An edited Scenario resolved for rendering; Clips meet with hard cuts. */
export interface RenderPlan {
  clips: RenderClip[];
  cues: CaptionCue[];
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
}

export interface LocalVideoMetadata {
  durationSec: number;
  width: number;
  height: number;
}

export interface UploadInitResponse {
  mode: 'gcs' | 'direct';
  sourceId: string;
  uploadUrl: string;
}

export interface UploadCompleteRequest {
  sourceId: string;
  filename: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
}

export interface UploadedAsset {
  assetId: string;
  kind: AssetKind;
  filename: string;
  sizeBytes: number;
  /** Pixel size of an image or video; 0 for audio. */
  width: number;
  height: number;
  /** Length of an audio or video file; 0 for images. */
  durationSec: number;
  hasAudio?: boolean;
}

export type RenderQuality = '1080p' | '1440p' | '2160p';

export interface RenderRequest {
  sourceId: string;
  plan: RenderPlan;
  quality?: RenderQuality;
}

/** A rendered 9:16 MP4 and its measured stream durations. */
export interface RenderOutput {
  renderId: string;
  videoUrl: string;
  plannedDurationSec: number;
  measuredVideoSec: number;
  measuredAudioSec: number;
  width?: number;
  height?: number;
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
  /** Linear gain a newly added Background Music starts with. */
  defaultMusicVolume: number;
  /** The music fades out over this long at the end of the short. */
  musicFadeOutSec: number;
  /** Width of a newly added image, as a fraction of the canvas width. */
  defaultImageWidthRatio: number;
}

/**
 * The single short template in canvas units (the ASS PlayRes): a square-cornered
 * video box on a solid background, a Headline of one or more lines above it and
 * a one-line caption below it on the background. A Clip may instead fill the
 * whole canvas with its video or use a custom box size/position.
 */
export interface TemplateStyle {
  canvasWidth: number;
  canvasHeight: number;
  boxSideMargin: number;
  /** Default width / height of the video box; the crop uses the same ratio. */
  boxAspectRatio: number;
  boxCenterY: number;
  /** Extra space between consecutive Headline lines. */
  headlineLineGap: number;
  /** Default distance from the bottom of the Headline to the box top. */
  headlineGap: number;
  /** Space between text and the edge of its background box. */
  textBoxPadding: number;
  /** Default distance from the box bottom to the bottom of the caption line. */
  captionGap: number;
  /** Captions wrap within the box width minus this padding on both sides. */
  captionSidePadding: number;
  /** Default text anchors when the video fills the canvas ('full' fit). */
  fullHeadlineY: number;
  fullCaptionY: number;
}

/** A bundled font; the browser loads the same file ffmpeg uses. */
export interface FontEntry {
  fontId: string;
  label: string;
  url: string;
  /** CSS font-size per ASS font size. */
  emPerLineBox: number;
}

export interface StudioConfig {
  defaultEditorialPrompt: string;
  composition: CompositionSettings;
  templateStyle: TemplateStyle;
  /** Where the text goes by default for each VideoFit. */
  defaultTextLayouts: Record<VideoFit, TextLayout>;
  /** Colors and fonts of a new Look. */
  defaultLookStyle: LookStyle;
  fonts: FontEntry[];
  maxCropZoom: number;
  maxMusicVolume: number;
  /** Non-empty when bundled font files are missing. */
  fontWarning: string;
  /** Non-empty when the server cannot call Gemini; says what to configure. */
  geminiSetupError: string;
  /** Google / YouTube OAuth sign-in state and creator channel profile. */
  auth: AuthStatus;
}

/*
 * 말로 편집 (Edit Agent): POST /edit. Mirrors yt/studio/edit_agent.py.
 * Clips are named by Clip Number, counted from 1 as on screen when the
 * Edit Request was sent.
 */

/** An earlier Edit Request of this editor session. */
export interface EditTurnPayload {
  request: string;
  reply: string;
  operations: EditOperation[];
  /** Whether the user undid the edits of this turn. */
  undone: boolean;
}

/** One Edit Request and the state it was sent from. */
export interface EditRequest {
  /** The Source Video; the server adds its stored transcript and audience data. */
  sourceId: string;
  request: string;
  /** The Shorts on screen. */
  scenario: Scenario;
  shortsNumber: number;
  shortsCount: number;
  /** Clip Number of the selected Clip; null when there is none. */
  clipNumber: number | null;
  /** Source Video second under the playhead; null over an inserted clip. */
  playheadSec: number | null;
  sourceDurationSec: number;
  cutWords: number[];
  /** Word index -> caption text; JSON keys are strings, the server reads ints. */
  wordText: Record<number, string>;
  captionMaxChars: number;
  assets: UploadedAsset[];
  history: EditTurnPayload[];
}

export interface EditResponse {
  /** One line for the user. */
  reply: string;
  /** The reply written to be heard; 말로 편집 reads it aloud with the notes. */
  speech: string;
  /** Checked operations, in order; apply them as one undo step. */
  operations: EditOperation[];
  /** What the server moved into range or skipped. */
  notes: string[];
}

/** Where an added or moved Clip goes; before and after name otherClip. */
export type EditPlace = 'first' | 'last' | 'before' | 'after';
/** The shared Look, or the own Look of one Clip (which then gets one). */
export type EditTarget = 'shared' | 'clip';
export type ClipEdge = 'start' | 'end';

/** Only the Look values an operation changes. */
export interface LookPatch {
  headline?: Headline;
  framingLayout?: {
    fit?: VideoFit;
    crop?: Partial<CropRegion>;
    /** Merged into the Look's box, or the template's box when it has none. */
    box?: Partial<VideoBoxSpec>;
    /** Puts the video box back to the template's. */
    defaultBox?: true;
  };
  textLayout?: {
    headline?: Partial<TextPlacement>;
    caption?: Partial<TextPlacement>;
  };
  style?: Partial<Omit<LookStyle, 'headline' | 'caption'>> & {
    headline?: Partial<HeadlineStyle>;
    caption?: Partial<TextStyle>;
  };
}

interface EditPlacement {
  /** Absent: after the Clip selected when the request was sent. */
  place?: EditPlace;
  otherClip?: number;
}

/** The Look an image or style operation edits. */
interface EditLookTarget {
  target: EditTarget;
  /** Clip Number; set when target is 'clip'. */
  clip?: number;
}

export type EditOperation =
  | {op: 'setClipRange'; clip: number; startSec: number; endSec: number}
  | {op: 'setClipEdge'; clip: number; edge: ClipEdge; atSec: number}
  | {op: 'moveClipEdge'; clip: number; edge: ClipEdge; deltaSec: number}
  | {op: 'shiftClip'; clip: number; deltaSec: number}
  | {op: 'setClipDuration'; clip: number; durationSec: number}
  | {op: 'splitClip'; clip: number; atSec: number}
  | {op: 'deleteClip'; clip: number}
  | {op: 'moveClip'; clip: number; place: EditPlace; otherClip?: number}
  | {op: 'swapClips'; clip: number; otherClip: number}
  | ({op: 'addSourceClip'; startSec: number; endSec: number} & EditPlacement)
  | ({
      op: 'addMediaClip';
      assetId: string;
      mediaKind: 'image' | 'video';
      file: string;
      startSec: number;
      endSec: number;
    } & EditPlacement)
  | {op: 'setClipMute'; clip: number; mute: boolean}
  | ({op: 'patchLook'; look: LookPatch} & EditLookTarget)
  | {op: 'setOwnLook'; clip: number; own: boolean}
  | ({
      op: 'addImage';
      assetId: string;
      file: string;
      x: number;
      y: number;
      width: number;
      height: number;
      rotationDeg: number;
    } & EditLookTarget)
  | ({
      op: 'updateImage';
      imageId: string;
      x?: number;
      y?: number;
      width?: number;
      rotationDeg?: number;
    } & EditLookTarget)
  | ({op: 'removeImage'; imageId: string} & EditLookTarget)
  | {op: 'setWordText'; word: number; text: string}
  | {op: 'setLineText'; words: number[]; text: string}
  | {op: 'resetWordText'; words: number[]}
  | {op: 'cutWords'; words: number[]}
  | {op: 'restoreWords'; words: number[]}
  | {op: 'setCaptionMaxChars'; maxChars: number}
  | {op: 'setMusic'; assetId: string; file: string; volume?: number}
  | {op: 'setMusicVolume'; volume: number}
  | {op: 'removeMusic'}
  | {op: 'resetShorts'};
