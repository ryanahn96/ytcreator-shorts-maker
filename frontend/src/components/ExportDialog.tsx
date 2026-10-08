/**
 * "내보내기": renders the selected Shorts as a 1080x1920 MP4 on the server,
 * plays the result, offers it for download, and lets the signed-in creator
 * upload it directly to their YouTube channel as a Shorts video.
 */

import {useEffect, useState} from 'react';

import {errorMessage, uploadShortToYouTube} from '../lib/api';
import {PRIVACY_LABELS} from '../lib/format';
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
  Notice,
  ProgressBar,
  Segmented,
  TEXT_FIELD,
} from './ui';

/** A render of one Shorts; planKey identifies the plan it was made from. */
export type RenderJob =
  | {status: 'running'; planKey: string}
  | {status: 'done'; planKey: string; output: RenderOutput}
  | {status: 'failed'; planKey: string; error: string};

const PRIVACY_OPTIONS: readonly {value: YouTubePrivacy; label: string}[] = (
  ['private', 'unlisted', 'public'] as const
).map((value) => ({value, label: PRIVACY_LABELS[value]}));

const QUALITY_OPTIONS: readonly {value: RenderQuality; label: string}[] = [
  {value: '1080p', label: '1080p FHD'},
  {value: '1440p', label: '1440p QHD (권장)'},
  {value: '2160p', label: '4K UHD 최고화질'},
];

const QUALITY_SPECS: Readonly<
  Record<RenderQuality, {resolution: string; detail: string}>
> = {
  '1080p': {
    resolution: '1080×1920 MP4',
    detail: '표준 FHD · 고비트레이트 H.264',
  },
  '1440p': {
    resolution: '1440×2560 MP4',
    detail: '고화질 QHD · 박스 안 1080p 원본 선명도 유지',
  },
  '2160p': {
    resolution: '2160×3840 MP4',
    detail: '최고화질 4K UHD · 원본 픽셀 100% 보존',
  },
};

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

function YouTubeDirectUpload(props: {
  renderId: string;
  defaultTitle: string;
  defaultDescription: string;
}) {
  const {renderId, defaultTitle, defaultDescription} = props;
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription);
  const [privacy, setPrivacy] = useState<YouTubePrivacy>('private');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<YouTubeUploadResult | null>(null);

  useEffect(() => {
    setTitle(defaultTitle);
    setDescription(defaultDescription);
    setUploadError(null);
    setUploaded(null);
  }, [renderId, defaultTitle, defaultDescription]);

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed || uploading) {
      return;
    }
    setUploading(true);
    setUploadError(null);
    uploadShortToYouTube({
      renderId,
      title: trimmed,
      description,
      privacyStatus: privacy,
    }).then(
      (result) => {
        setUploaded(result);
        setUploading(false);
      },
      (err: unknown) => {
        setUploadError(errorMessage(err));
        setUploading(false);
      },
    );
  };

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
            <span>제목 (최대 100자)</span>
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
            <span>설명 (#Shorts 자동 포함)</span>
            <textarea
              rows={2}
              value={description}
              disabled={uploading}
              onChange={(event) => setDescription(event.target.value)}
              className="w-full rounded-lg border border-outline-variant bg-surface p-2.5 text-sm text-on-surface focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none disabled:opacity-40"
            />
          </label>
          <div className="space-y-1">
            <span className="block text-xs text-on-surface-variant">공개 상태</span>
            <Segmented<YouTubePrivacy>
              label="공개 상태"
              value={privacy}
              disabled={uploading}
              options={PRIVACY_OPTIONS}
              onChange={setPrivacy}
            />
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
  onQualityChange: (quality: RenderQuality) => void;
  onRender: () => void;
  onClose: () => void;
}) {
  const {job, quality} = props;
  const running = job?.status === 'running';
  const done = job?.status === 'done' ? job : null;
  const stale = done !== null && done.planKey !== props.planKey;
  const canRender = props.plan !== null && !running && (done === null || stale);
  const spec = QUALITY_SPECS[quality];
  const defaultDesc = props.rationale
    ? `${props.rationale}\n\n#Shorts`
    : '#Shorts';

  return (
    <Dialog
      open={props.open}
      title="내보내기"
      width={520}
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
        <div>
          <p className="text-base text-on-surface">{props.title}</p>
          <p className="text-xs text-on-surface-variant tabular-nums">
            {spec.resolution} · {spec.detail}
          </p>
        </div>
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-on-surface-variant">
            화질 (해상도)
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
        {running && (
          <div className="space-y-2">
            <ProgressBar label="MP4 만들기" />
            <p>MP4를 만들고 있어요</p>
          </div>
        )}
        {job?.status === 'failed' && <Notice tone="error">{job.error}</Notice>}
        {done && (
          <div className="flex flex-col items-center gap-3">
            <video
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
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
