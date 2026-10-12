/**
 * "내보내기": renders the selected Shorts as a 1080x1920 MP4 on the server,
 * plays the result, offers it for download, and lets the signed-in creator
 * upload it directly to their YouTube channel as a Shorts video.
 */

import {useEffect, useRef, useState, type RefObject} from 'react';

import type {AssetStore} from '../hooks/useAssets';
import {errorMessage, uploadShortToYouTube} from '../lib/api';
import {formatClock, PRIVACY_LABELS} from '../lib/format';
import type {
  RenderOutput,
  RenderPlan,
  RenderQuality,
  YouTubePrivacy,
  YouTubeUploadResult,
} from '../types';
import {Icon} from './Icon';
import {
  Button,
  buttonClass,
  Dialog,
  FilePicker,
  Notice,
  ProgressBar,
  Segmented,
  SliderField,
  TEXT_FIELD,
  Toggle,
} from './ui';

/** A render of one Shorts; planKey identifies the plan it was made from. */
export type RenderJob =
  | {status: 'running'; planKey: string}
  | {status: 'done'; planKey: string; output: RenderOutput}
  | {status: 'failed'; planKey: string; error: string};

type ThumbnailMode = 'recommended' | 'frame' | 'upload' | 'none';

const PRIVACY_OPTIONS: readonly {value: YouTubePrivacy; label: string}[] = (
  ['private', 'unlisted', 'public'] as const
).map((value) => ({value, label: PRIVACY_LABELS[value]}));

const QUALITY_OPTIONS: readonly {value: RenderQuality; label: string}[] = [
  {value: '1080p', label: '1080p'},
  {value: '1440p', label: '1440p (권장)'},
  {value: '2160p', label: '4K'},
];

const THUMBNAIL_OPTIONS: readonly {value: ThumbnailMode; label: string}[] = [
  {value: 'recommended', label: '추천 프레임'},
  {value: 'frame', label: '직접 선택'},
  {value: 'upload', label: '이미지 업로드'},
  {value: 'none', label: '기본값'},
];

// Characters Windows and macOS do not allow in file names.
const RESERVED_CHARS = new Set([...'\\/:*?"<>|']);
const MAX_STEM_CHARS = 120;

function safeFilePart(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return RESERVED_CHARS.has(char) || code < 0x20 || code === 0x7f ? '_' : char;
    })
    .join('')
    .trim();
}

/** "원본파일이름-Shorts제목.mp4", safe to save on any desktop OS. */
export function renderFilename(sourceTitle: string, shortsTitle: string): string {
  const stem = [safeFilePart(sourceTitle), safeFilePart(shortsTitle)]
    .filter((part) => part !== '')
    .join('-');
  const short = [...stem].slice(0, MAX_STEM_CHARS).join('').trim();
  return `${short || 'shorts'}.mp4`;
}

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function makeGoldenPreset(
  dayOffset: number,
  hour: number,
): {label: string; value: string; timeMs: number} {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    hour,
    0,
    0,
    0,
  );
  if (target.getTime() <= now.getTime() + 10 * 60 * 1000) {
    target.setDate(target.getDate() + 1);
    const dayLabel = dayOffset === 0 ? '내일' : '모레';
    return {
      label: `${dayLabel} ${hour}:00`,
      value: toLocalInputValue(target),
      timeMs: target.getTime(),
    };
  }
  const dayLabel =
    dayOffset === 0 ? '오늘' : dayOffset === 1 ? '내일' : '모레';
  return {
    label: `${dayLabel} ${hour}:00`,
    value: toLocalInputValue(target),
    timeMs: target.getTime(),
  };
}

function buildDefaultFirstComment(
  youtubeVideoId?: string,
  firstClipStartSec?: number,
): string {
  const vid = (youtubeVideoId ?? '').trim();
  if (vid) {
    const sec = Math.max(0, Math.floor(firstClipStartSec ?? 0));
    return `풀버전 영상 보기 👉 https://www.youtube.com/watch?v=${vid}&t=${sec}s`;
  }
  return '시청해 주셔서 감사합니다! 전체 영상은 채널에서 확인해 보세요.';
}

function YouTubeDirectUpload(props: {
  renderId: string;
  defaultTitle: string;
  defaultDescription: string;
  durationSec: number;
  recommendedThumbSec: number;
  youtubeVideoId?: string;
  firstClipStartSec?: number;
  assets?: AssetStore;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const {
    renderId,
    defaultTitle,
    defaultDescription,
    durationSec,
    recommendedThumbSec,
    youtubeVideoId,
    firstClipStartSec,
    assets,
    videoRef,
  } = props;
  const maxThumbSec = Math.max(
    0.1,
    Math.floor(Math.max(0.1, durationSec - 0.05) * 10) / 10,
  );
  const clampedRecSec = Math.min(
    Math.max(0, Math.round(recommendedThumbSec * 10) / 10),
    maxThumbSec,
  );

  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription);
  const [privacy, setPrivacy] = useState<YouTubePrivacy>('private');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [publishAtLocal, setPublishAtLocal] = useState(
    () => makeGoldenPreset(0, 18).value,
  );
  const [firstCommentEnabled, setFirstCommentEnabled] = useState(
    Boolean(youtubeVideoId),
  );
  const [firstComment, setFirstComment] = useState(() =>
    buildDefaultFirstComment(youtubeVideoId, firstClipStartSec),
  );
  const [thumbMode, setThumbMode] = useState<ThumbnailMode>('recommended');
  const [frameSec, setFrameSec] = useState(clampedRecSec);
  const [thumbAssetId, setThumbAssetId] = useState<string | null>(null);
  const [thumbUploading, setThumbUploading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<YouTubeUploadResult | null>(null);

  useEffect(() => {
    setTitle(defaultTitle);
    setDescription(defaultDescription);
    setFirstCommentEnabled(Boolean(youtubeVideoId));
    setFirstComment(buildDefaultFirstComment(youtubeVideoId, firstClipStartSec));
    setThumbMode('recommended');
    setFrameSec(clampedRecSec);
    setThumbAssetId(null);
    setUploadError(null);
    setUploaded(null);
  }, [
    renderId,
    defaultTitle,
    defaultDescription,
    youtubeVideoId,
    firstClipStartSec,
    clampedRecSec,
  ]);

  const seekVideoTo = (sec: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = Math.min(Math.max(0, sec), maxThumbSec);
  };

  const handleThumbModeChange = (mode: ThumbnailMode) => {
    setThumbMode(mode);
    if (mode === 'recommended') {
      seekVideoTo(clampedRecSec);
    } else if (mode === 'frame') {
      seekVideoTo(frameSec);
    }
  };

  const handleThumbFile = (file: File) => {
    if (!assets) return;
    setThumbUploading(true);
    setUploadError(null);
    assets
      .add(file, 'image')
      .then((asset) => setThumbAssetId(asset.assetId))
      .catch((err: unknown) => setUploadError(errorMessage(err)))
      .finally(() => setThumbUploading(false));
  };

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed || uploading) {
      return;
    }
    let publishAtIso: string | null = null;
    if (scheduleEnabled) {
      const parsed = new Date(publishAtLocal);
      if (Number.isNaN(parsed.getTime())) {
        setUploadError('예약 발행 시각을 올바르게 선택해 주세요.');
        return;
      }
      if (parsed.getTime() <= Date.now() + 60_000) {
        setUploadError('예약 발행 시각은 현재 시각 이후여야 합니다.');
        return;
      }
      publishAtIso = parsed.toISOString();
    }
    if (thumbMode === 'upload' && !thumbAssetId) {
      setUploadError('업로드할 썸네일 이미지 파일을 먼저 선택해 주세요.');
      return;
    }
    setUploading(true);
    setUploadError(null);
    uploadShortToYouTube({
      renderId,
      title: trimmed,
      description,
      privacyStatus: scheduleEnabled ? 'private' : privacy,
      publishAt: publishAtIso,
      firstComment: firstCommentEnabled ? firstComment.trim() : '',
      thumbnailTimeSec:
        thumbMode === 'recommended'
          ? clampedRecSec
          : thumbMode === 'frame'
            ? frameSec
            : null,
      thumbnailAssetId: thumbMode === 'upload' ? thumbAssetId : null,
    })
      .then(setUploaded, (err: unknown) => setUploadError(errorMessage(err)))
      .finally(() => setUploading(false));
  };

  const presets = [
    makeGoldenPreset(0, 18),
    makeGoldenPreset(1, 12),
    makeGoldenPreset(1, 19),
  ].sort((a, b) => a.timeMs - b.timeMs);
  const uploadedThumbUrl =
    thumbAssetId && assets ? assets.urls.get(thumbAssetId) : undefined;
  const uploadedThumbName =
    thumbAssetId && assets
      ? assets.records.get(thumbAssetId)?.filename
      : undefined;

  return (
    <div className="w-full space-y-3 rounded-2xl bg-surface p-4">
      <div className="flex items-center gap-2">
        <Icon name="upload" size={18} className="text-primary" />
        <h3 className="text-sm font-medium text-on-surface">
          내 YouTube 채널에 바로 올리기
        </h3>
      </div>

      {uploaded ? (
        <div className="space-y-3">
          <p className="text-sm text-on-surface">
            YouTube Shorts 업로드가 완료되었어요!
          </p>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {uploaded.thumbnailSet && (
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary-container px-2.5 py-0.5 font-medium text-on-secondary-container">
                <Icon name="check" size={14} />
                커스텀 썸네일 등록됨
              </span>
            )}
            {uploaded.commentPosted && (
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary-container px-2.5 py-0.5 font-medium text-on-secondary-container">
                <Icon name="check" size={14} />
                첫 댓글 자동 등록됨
              </span>
            )}
          </div>
          {uploaded.warnings && uploaded.warnings.length > 0 && (
            <Notice tone="warning">{uploaded.warnings.join('\n')}</Notice>
          )}
          <div className="flex flex-wrap gap-2">
            <a
              href={uploaded.watchUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonClass('filled', 'sm')}
            >
              <Icon name="open_in_new" size={18} />
              YouTube Shorts 보기
            </a>
            <a
              href={uploaded.studioUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonClass('tonal', 'sm')}
            >
              <Icon name="open_in_new" size={18} />
              YouTube Studio에서 편집
            </a>
          </div>
        </div>
      ) : (
        <>
          <label className="block space-y-1 text-xs text-on-surface-variant">
            <span>제목</span>
            <input
              type="text"
              maxLength={100}
              value={title}
              disabled={uploading}
              onChange={(event) => setTitle(event.target.value)}
              className={`${TEXT_FIELD} w-full`}
            />
          </label>
          <label className="block space-y-1 text-xs text-on-surface-variant">
            <span>설명</span>
            <textarea
              rows={2}
              value={description}
              disabled={uploading}
              onChange={(event) => setDescription(event.target.value)}
              className="w-full rounded-lg border border-outline-variant bg-surface p-2.5 text-sm text-on-surface focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-40"
            />
          </label>

          {/* Thumbnail Selection (3 options + default) */}
          <div className="space-y-2 rounded-xl bg-surface-container-low p-3">
            <span className="block text-xs font-medium text-on-surface">
              썸네일 설정
            </span>
            <Segmented<ThumbnailMode>
              label="썸네일 설정"
              value={thumbMode}
              disabled={uploading}
              options={THUMBNAIL_OPTIONS}
              onChange={handleThumbModeChange}
            />
            {thumbMode === 'recommended' && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-on-surface-variant">
                <span>
                  Gemini 추천 훅 프레임:{' '}
                  <strong className="font-semibold text-on-surface tabular-nums">
                    {formatClock(clampedRecSec)} ({clampedRecSec.toFixed(1)}초)
                  </strong>
                </span>
                <Button
                  variant="text"
                  size="sm"
                  icon="play_arrow"
                  disabled={uploading}
                  onClick={() => seekVideoTo(clampedRecSec)}
                >
                  미리보기 확인
                </Button>
              </div>
            )}
            {thumbMode === 'frame' && (
              <div className="space-y-2 pt-1">
                <SliderField
                  label="썸네일 프레임 시각"
                  value={frameSec}
                  min={0}
                  max={maxThumbSec}
                  step={0.1}
                  disabled={uploading}
                  format={(v) => `${formatClock(v)} (${v.toFixed(1)}초)`}
                  onChange={(val) => {
                    setFrameSec(val);
                    seekVideoTo(val);
                  }}
                />
                <div className="flex justify-end">
                  <Button
                    variant="tonal"
                    size="sm"
                    icon="image"
                    disabled={uploading}
                    onClick={() => {
                      const current = videoRef.current?.currentTime ?? 0;
                      const rounded = Math.min(
                        Math.max(0, Math.round(current * 10) / 10),
                        maxThumbSec,
                      );
                      setFrameSec(rounded);
                    }}
                  >
                    현재 재생 위치 사용
                  </Button>
                </div>
              </div>
            )}
            {thumbMode === 'upload' && (
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                {uploadedThumbUrl ? (
                  <div className="flex min-w-0 items-center gap-2.5">
                    <img
                      src={uploadedThumbUrl}
                      alt={uploadedThumbName ?? '썸네일'}
                      className="h-14 w-10 shrink-0 rounded-lg object-cover ring-1 ring-outline-variant"
                    />
                    <span className="truncate text-xs text-on-surface">
                      {uploadedThumbName}
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-on-surface-variant">
                    직접 만든 표지 이미지를 올리세요 (2MB 이하 자동 최적화)
                  </span>
                )}
                <FilePicker
                  label={uploadedThumbUrl ? '다른 이미지' : '이미지 선택'}
                  accept="image/*"
                  busy={thumbUploading}
                  icon="add_photo_alternate"
                  variant="tonal"
                  size="sm"
                  onFile={handleThumbFile}
                />
              </div>
            )}
          </div>

          {/* Privacy & Scheduled Publishing */}
          <div className="space-y-2 rounded-xl bg-surface-container-low p-3">
            <div className="space-y-1">
              <span className="block text-xs font-medium text-on-surface">
                공개 상태
              </span>
              <Segmented<YouTubePrivacy>
                label="공개 상태"
                value={scheduleEnabled ? 'private' : privacy}
                disabled={uploading || scheduleEnabled}
                options={PRIVACY_OPTIONS}
                onChange={setPrivacy}
              />
            </div>
            <Toggle
              label="예약 발행"
              checked={scheduleEnabled}
              disabled={uploading}
              onChange={setScheduleEnabled}
            />
            {scheduleEnabled && (
              <div className="space-y-2 pt-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-on-surface-variant">
                    골든타임 추천:
                  </span>
                  {presets.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      disabled={uploading}
                      onClick={() => setPublishAtLocal(preset.value)}
                      className="rounded-full bg-secondary-container px-2.5 py-1 text-xs font-medium text-on-secondary-container hover:ring-1 hover:ring-primary disabled:opacity-40"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <input
                  type="datetime-local"
                  value={publishAtLocal}
                  disabled={uploading}
                  onChange={(event) => setPublishAtLocal(event.target.value)}
                  className={`${TEXT_FIELD} w-full`}
                />
                <p className="text-[11px] text-on-surface-variant">
                  예약 시각 전까지는 비공개로 유지되며, 지정한 시각에 자동으로 공개됩니다.
                </p>
              </div>
            )}
          </div>

          {/* First Comment Auto-Posting */}
          <div className="space-y-2 rounded-xl bg-surface-container-low p-3">
            <Toggle
              label="첫 댓글 자동 등록"
              checked={firstCommentEnabled}
              disabled={uploading}
              onChange={setFirstCommentEnabled}
            />
            {firstCommentEnabled && (
              <div className="space-y-1 pt-1">
                <textarea
                  rows={2}
                  value={firstComment}
                  disabled={uploading}
                  onChange={(event) => setFirstComment(event.target.value)}
                  placeholder="업로드 직후 첫 댓글로 자동 등록할 문구 (롱폼 링크 등)"
                  className="w-full rounded-lg border border-outline-variant bg-surface p-2 text-xs text-on-surface focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-40"
                />
              </div>
            )}
          </div>

          {uploading && (
            <ProgressBar label="YouTube 채널에 Shorts 업로드 중" />
          )}
          {uploadError && <Notice tone="error">{uploadError}</Notice>}
          <div className="flex justify-end">
            <Button
              variant="filled"
              size="sm"
              icon="upload"
              disabled={uploading || title.trim() === ''}
              onClick={submit}
            >
              {uploading ? '업로드 중…' : 'YouTube Shorts로 업로드'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function ExportDialog(props: {
  open: boolean;
  /** Title of the Shorts being exported. */
  title: string;
  /** Rationale of the Shorts, used as default description. */
  rationale?: string;
  /** The uploaded file name without its extension. */
  sourceTitle: string;
  /** Null when no Clip has anything left to play. */
  plan: RenderPlan | null;
  /** Key of the current plan and quality, compared with the job's. */
  planKey: string;
  quality: RenderQuality;
  job: RenderJob | undefined;
  /** Non-empty when bundled font files are missing on the server. */
  fontWarning: string;
  /** Recommended thumbnail timestamp in the rendered output timeline. */
  recommendedThumbSec?: number;
  /** Linked long-form YouTube video ID, if any. */
  youtubeVideoId?: string;
  /** Start second of the first source clip in the original long-form video. */
  firstClipStartSec?: number;
  assets?: AssetStore;
  onQualityChange: (quality: RenderQuality) => void;
  onRender: () => void;
  onClose: () => void;
}) {
  const {job, quality} = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const running = job?.status === 'running';
  const done = job?.status === 'done' ? job : null;
  const stale = done !== null && done.planKey !== props.planKey;
  const canRender = props.plan !== null && !running && (done === null || stale);
  const defaultDesc = props.rationale
    ? `${props.rationale}\n\n#Shorts`
    : '#Shorts';

  return (
    <Dialog
      open={props.open}
      title="내보내기"
      width={560}
      onClose={props.onClose}
      actions={
        <>
          <Button variant="text" onClick={props.onClose}>
            닫기
          </Button>
          <Button icon="movie" disabled={!canRender} onClick={props.onRender}>
            MP4 만들기
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-base text-on-surface">{props.title}</p>
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-on-surface-variant">
            화질
          </span>
          <Segmented<RenderQuality>
            label="화질 선택"
            value={quality}
            disabled={running}
            options={QUALITY_OPTIONS}
            onChange={props.onQualityChange}
          />
        </div>
        {props.plan === null && (
          <Notice tone="warning">재생할 구간이 없어서 만들 수 없어요</Notice>
        )}
        {props.fontWarning !== '' && <Notice tone="warning">{props.fontWarning}</Notice>}
        {running && <ProgressBar label="MP4 만들기" />}
        {job?.status === 'failed' && <Notice tone="error">{job.error}</Notice>}
        {done && (
          <div className="flex flex-col items-center gap-3">
            <video
              ref={videoRef}
              key={done.output.renderId}
              src={done.output.videoUrl}
              controls
              playsInline
              className="aspect-[9/16] max-h-[42vh] rounded-2xl bg-black"
            />
            {stale && (
              <Notice tone="warning" className="w-full">
                편집이 바뀌었어요. 다시 만들어 주세요
              </Notice>
            )}
            <a
              href={done.output.videoUrl}
              download={renderFilename(props.sourceTitle, props.title)}
              className={buttonClass('tonal')}
            >
              <Icon name="download" />
              MP4 파일 다운로드
            </a>
            <YouTubeDirectUpload
              renderId={done.output.renderId}
              defaultTitle={props.title}
              defaultDescription={defaultDesc}
              durationSec={
                done.output.measuredVideoSec || done.output.plannedDurationSec
              }
              recommendedThumbSec={props.recommendedThumbSec ?? 0.5}
              youtubeVideoId={props.youtubeVideoId}
              firstClipStartSec={props.firstClipStartSec}
              assets={props.assets}
              videoRef={videoRef}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

