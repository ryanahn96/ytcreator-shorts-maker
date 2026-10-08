/**
 * The first screen: drop or pick the Source Video file, optionally link the
 * matching long-form video from the signed-in creator's YouTube channel (to
 * pull its Audience Retention peaks/lows, viewer comments, and official
 * captions), optionally tune the Editorial Prompt with those data insights,
 * then start the analysis with "Shorts 만들기".
 */

import {useEffect, useRef, useState, type DragEvent, type ReactNode} from 'react';

import type {UploadState} from '../hooks/useSourceUpload';
import {
  errorMessage,
  getYouTubeVideoContext,
  listYouTubeVideos,
} from '../lib/api';
import {formatClock, formatLength, formatMegabytes, PRIVACY_LABELS} from '../lib/format';
import type {
  YouTubeRetentionPeak,
  YouTubeRetentionPoint,
  YouTubeVideoContext,
  YouTubeVideoItem,
} from '../types';
import {Icon} from './Icon';
import {PromptEditor} from './PromptEditor';
import {
  Button,
  FilePicker,
  Notice,
  ProgressBar,
  STATE_LAYER,
  TEXT_FIELD,
} from './ui';

const VIDEO_ACCEPT = 'video/*';
// The suffixes the server stores (yt/studio/storage.py); some browsers
// leave file.type empty for .mkv.
const VIDEO_SUFFIXES = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'];
const DURATION_MATCH_TOLERANCE_SEC = 2.0;
const TUNED_SECTION_HEADER = '[YouTube 데이터 기반 맞춤 지시]';

function isVideoFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    file.type.startsWith('video/') ||
    VIDEO_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/** Extracts a YouTube video ID from a URL or returns the trimmed ID. */
function parseYouTubeVideoId(input: string): string {
  const raw = input.trim();
  if (!raw) {
    return '';
  }
  try {
    const url = new URL(raw);
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.replace(/^\//, '').split('/')[0] ?? '';
    }
    const v = url.searchParams.get('v');
    if (v) {
      return v.trim();
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const shortsIdx = parts.findIndex(
      (part) => part === 'shorts' || part === 'video' || part === 'live',
    );
    if (shortsIdx >= 0 && parts[shortsIdx + 1]) {
      return parts[shortsIdx + 1];
    }
  } catch {
    // Plain video ID.
  }
  return raw;
}

function formatPublishedDate(iso: string | undefined): string {
  if (!iso) {
    return '';
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso.slice(0, 10);
  }
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getDate()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd}`;
}

function formatPrivacyLabel(privacy: string | undefined): string {
  switch (privacy) {
    case 'public':
    case 'unlisted':
    case 'private':
      return PRIVACY_LABELS[privacy];
    default:
      return privacy || '공개';
  }
}

function isDurationMatched(
  videoDurationSec: number,
  localDurationSec: number,
): boolean {
  if (videoDurationSec <= 0 || localDurationSec <= 0) {
    return false;
  }
  return (
    Math.abs(videoDurationSec - localDurationSec) <=
    DURATION_MATCH_TOLERANCE_SEC
  );
}

/** Injects or updates the data-driven editorial instruction block in prompt. */
function buildDataTunedPrompt(
  currentPrompt: string,
  context: YouTubeVideoContext,
): string {
  const markerIdx = currentPrompt.indexOf(TUNED_SECTION_HEADER);
  const basePrompt = (
    markerIdx >= 0 ? currentPrompt.slice(0, markerIdx) : currentPrompt
  ).trimEnd();

  const lines: string[] = [TUNED_SECTION_HEADER];
  if (context.title) {
    lines.push(`- 연결된 원본 YouTube 영상: "${context.title}"`);
  }
  if (context.retentionPeaks.length > 0) {
    lines.push(
      '- [시청자 집중 피크 구간 — 최우선 선별] 아래 구간은 시청자가 가장 많이 보거나 반복 시청한 하이라이트이므로 각 Shorts의 첫 도입부(Hook)나 핵심 Clip으로 적극 포함하세요:',
    );
    for (const peak of context.retentionPeaks) {
      const watchPct = Math.round(peak.watchRatio * 100);
      const relPct = Math.round(peak.relativePerformance * 100);
      lines.push(
        `  * ${formatClock(peak.startSec)} ~ ${formatClock(peak.endSec)} (유지율 ${watchPct}%, 상대 성과 ${relPct}% · ${peak.label})`,
      );
    }
  }
  const lows = context.retentionLows ?? [];
  if (lows.length > 0) {
    lines.push(
      '- [시청자 이탈·저조 구간 — 제외 지시] 아래 구간은 시청자가 스킵하거나 이탈한 구간이므로 Shorts 클립에서 제외하세요:',
    );
    for (const low of lows) {
      const watchPct = Math.round(low.watchRatio * 100);
      lines.push(
        `  * ${formatClock(low.startSec)} ~ ${formatClock(low.endSec)} (유지율 ${watchPct}% · ${low.label})`,
      );
    }
  }
  const comments = context.comments ?? [];
  if (comments.length > 0) {
    lines.push(
      '- [실제 시청자 댓글 반응 반영] 시청자들이 댓글로 극찬하거나 언급한 아래 포인트와 타임스탬프를 시나리오 주제 및 상단 헤드라인 문구에 반영하세요:',
    );
    for (const comment of comments.slice(0, 5)) {
      const cleanText = comment.text.replace(/\s+/g, ' ').slice(0, 110);
      const tsLabel =
        comment.timestampSec !== null
          ? `[${formatClock(comment.timestampSec)} 언급] `
          : '';
      lines.push(
        `  * ${tsLabel}"${cleanText}" (좋아요 ${comment.likeCount}개)`,
      );
    }
  }
  if (lines.length === 1) {
    lines.push(
      '- 연결된 YouTube 영상의 시청자 반응과 핵심 하이라이트를 중심으로 가장 몰입도 높은 구간을 선별하세요.',
    );
  }
  return `${basePrompt}\n\n${lines.join('\n')}\n`;
}

/** Draws an SVG chart of the Audience Retention curve with peak/low bands. */
export function RetentionSparkline(props: {
  points: readonly YouTubeRetentionPoint[];
  peaks?: readonly YouTubeRetentionPeak[];
  lows?: readonly YouTubeRetentionPeak[];
  durationSec?: number;
}) {
  const {points, peaks = [], lows = [], durationSec = 0} = props;
  if (points.length < 2) {
    return null;
  }
  const maxWatch = Math.max(1, ...points.map((p) => p.watchRatio));
  const coords = points.map((p) => {
    const x = Math.min(Math.max(p.elapsedRatio, 0), 1) * 100;
    const y = (1 - Math.min(Math.max(p.watchRatio / maxWatch, 0), 1)) * 32 + 4;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const linePath = `M ${coords.join(' L ')}`;
  const areaPath = `${linePath} L 100,38 L 0,38 Z`;
  return (
    <svg
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      className="h-20 w-full rounded-xl bg-surface-container-highest p-1.5"
      aria-label="YouTube 시청자 유지율 곡선"
    >
      {durationSec > 0 &&
        peaks.map((peak, idx) => {
          const x = Math.max(0, (peak.startSec / durationSec) * 100);
          const w = Math.max(
            1,
            ((peak.endSec - peak.startSec) / durationSec) * 100,
          );
          return (
            <rect
              key={`peak-${idx}`}
              x={x}
              y={2}
              width={Math.min(100 - x, w)}
              height={36}
              className="fill-primary/20"
            />
          );
        })}
      {durationSec > 0 &&
        lows.map((low, idx) => {
          const x = Math.max(0, (low.startSec / durationSec) * 100);
          const w = Math.max(
            1,
            ((low.endSec - low.startSec) / durationSec) * 100,
          );
          return (
            <rect
              key={`low-${idx}`}
              x={x}
              y={2}
              width={Math.min(100 - x, w)}
              height={36}
              className="fill-error/15"
            />
          );
        })}
      <path d={areaPath} className="fill-primary/15" />
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        vectorEffect="non-scaling-stroke"
        className="text-primary"
      />
    </svg>
  );
}

function YouTubeChannelLinkSection(props: {
  videoId: string;
  durationSec: number;
  hasUploadedFile: boolean;
  onChange: (videoId: string) => void;
  onTunePrompt: (context: YouTubeVideoContext) => void;
}) {
  const {
    videoId,
    durationSec,
    hasUploadedFile,
    onChange,
    onTunePrompt,
  } = props;
  const [isOpen, setIsOpen] = useState(false);
  const [videos, setVideos] = useState<YouTubeVideoItem[] | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState(videoId);
  const [context, setContext] = useState<YouTubeVideoContext | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const autoMatchedDurationRef = useRef<number>(0);

  const loadList = () => {
    setLoadingList(true);
    setListError(null);
    listYouTubeVideos().then(
      (res) => {
        const sorted = [...res.videos].sort((a, b) =>
          b.publishedAt.localeCompare(a.publishedAt),
        );
        setVideos(sorted);
        setLoadingList(false);
      },
      (err: unknown) => {
        setListError(errorMessage(err));
        setLoadingList(false);
      },
    );
  };

  // Auto-open and load the channel long-form video list when a file is uploaded.
  useEffect(() => {
    if (hasUploadedFile) {
      setIsOpen(true);
      if (videos === null && !loadingList) {
        loadList();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUploadedFile]);

  // Auto-select the newest upload whose duration matches the uploaded file.
  useEffect(() => {
    if (
      durationSec <= 0 ||
      !videos ||
      videos.length === 0 ||
      autoMatchedDurationRef.current === durationSec
    ) {
      return;
    }
    autoMatchedDurationRef.current = durationSec;
    if (videoId.trim()) {
      return;
    }
    const matched = videos.find((item) =>
      isDurationMatched(item.durationSec, durationSec),
    );
    if (matched) {
      onChange(matched.videoId);
    }
  }, [durationSec, videos, videoId, onChange]);

  useEffect(() => {
    setManualInput(videoId);
    if (!videoId) {
      setContext(null);
      setContextError(null);
      return;
    }
    let cancelled = false;
    setLoadingContext(true);
    setContextError(null);
    getYouTubeVideoContext(videoId, durationSec).then(
      (ctx) => {
        if (!cancelled) {
          setContext(ctx);
          setLoadingContext(false);
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setContextError(errorMessage(err));
          setLoadingContext(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [videoId, durationSec]);

  // Videos are already sorted by newest publishedAt first.
  const newestMatchedVideoId =
    durationSec > 0 && videos
      ? (videos.find((v) => isDurationMatched(v.durationSec, durationSec))
          ?.videoId ?? '')
      : '';
  const selectedItem =
    videos?.find((item) => item.videoId === videoId) ?? null;
  const linkedDurationSec =
    context?.durationSec || selectedItem?.durationSec || 0;
  const linkedDurationMatches = isDurationMatched(
    linkedDurationSec,
    durationSec,
  );
  const durationDiffSec =
    durationSec > 0 && linkedDurationSec > 0
      ? Math.abs(linkedDurationSec - durationSec)
      : null;

  return (
    <details
      open={isOpen}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setIsOpen(nextOpen);
        if (nextOpen && videos === null && !loadingList) {
          loadList();
        }
      }}
      className="group rounded-[28px] bg-surface-container-low open:bg-surface-container"
    >
      <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-2 rounded-[28px] px-6 py-3 text-sm font-medium text-on-surface-variant select-none hover:text-on-surface">
        <Icon
          name="expand_more"
          className="transition-transform group-open:rotate-180"
        />
        <Icon name="insights" size={18} className="text-primary" />
        <span>내 채널 영상 연결</span>
        {videoId && (
          <span className="ms-auto inline-flex items-center gap-1.5 rounded-full bg-secondary-container px-3 py-1 text-xs font-medium text-on-secondary-container">
            <Icon name="check" size={14} />
            {context?.title || selectedItem?.title
              ? `연결됨: ${context?.title || selectedItem?.title}`
              : `ID: ${videoId}`}
          </span>
        )}
      </summary>
      <div className="space-y-4 px-6 pb-6">
        {durationSec > 0 && linkedDurationSec > 0 && !linkedDurationMatches && (
          <Notice tone="warning">
            {`업로드한 파일(${formatClock(durationSec)})과 연결된 YouTube 영상(${formatClock(linkedDurationSec)})의 길이가 다릅니다 (차이 ${(durationDiffSec ?? 0).toFixed(1)}초).`}
          </Notice>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={manualInput}
            onChange={(event) => setManualInput(event.target.value)}
            placeholder="YouTube 영상 URL 또는 영상 ID 직접 입력"
            className={`${TEXT_FIELD} min-w-56 flex-1`}
          />
          <Button
            variant="tonal"
            size="sm"
            icon="link"
            onClick={() => onChange(parseYouTubeVideoId(manualInput))}
          >
            적용
          </Button>
          {videoId && (
            <Button
              variant="text"
              size="sm"
              icon="close"
              onClick={() => {
                setManualInput('');
                onChange('');
              }}
            >
              연결 해제
            </Button>
          )}
          <Button
            variant="text"
            size="sm"
            icon="refresh"
            disabled={loadingList}
            onClick={loadList}
          >
            새로고침
          </Button>
        </div>

        {loadingContext && <ProgressBar label="YouTube 데이터 조회 중" />}
        {contextError && <Notice tone="warning">{contextError}</Notice>}

        {/* Linked Video Analytics & Comments Panel */}
        {context && !loadingContext && (
          <div className="space-y-4 rounded-2xl bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-base font-semibold text-on-surface">
                    {context.title || `영상 ID: ${context.videoId}`}
                  </p>
                  {context.privacyStatus && (
                    <span className="rounded-full bg-surface-container-highest px-2.5 py-0.5 text-[11px] font-medium text-on-surface-variant">
                      {formatPrivacyLabel(context.privacyStatus)}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-on-surface-variant tabular-nums">
                  {context.publishedAt &&
                    `업로드 ${formatPublishedDate(context.publishedAt)} · `}
                  {context.durationSec > 0 &&
                    `길이 ${formatClock(context.durationSec)} · `}
                  {typeof context.viewCount === 'number' &&
                    `조회수 ${context.viewCount.toLocaleString()}회 · `}
                  {typeof context.likeCount === 'number' &&
                    `좋아요 ${context.likeCount.toLocaleString()} · `}
                  {typeof context.commentCount === 'number' &&
                    `댓글 ${context.commentCount.toLocaleString()}개 · `}
                  {context.captionWords.length > 0
                    ? `공식 자막 (${context.captionWords.length}단어)`
                    : '공식 자막 없음'}
                </p>
              </div>
              <Button
                variant="filled"
                size="sm"
                icon="tune"
                onClick={() => onTunePrompt(context)}
              >
                ✨ 데이터로 편집 요청 튜닝
              </Button>
            </div>

            {context.retentionPoints.length > 1 ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-on-surface-variant">
                  <span className="font-medium text-on-surface">
                    시청자 유지율
                  </span>
                  <span>
                    피크 {context.retentionPeaks.length} · 이탈{' '}
                    {(context.retentionLows ?? []).length}
                  </span>
                </div>
                <RetentionSparkline
                  points={context.retentionPoints}
                  peaks={context.retentionPeaks}
                  lows={context.retentionLows}
                  durationSec={context.durationSec || durationSec}
                />
              </div>
            ) : (
              <p className="text-xs text-on-surface-variant">
                집계된 유지율 데이터가 없습니다.
              </p>
            )}

            {/* High-retention peaks & Low-retention drop-offs */}
            {(context.retentionPeaks.length > 0 ||
              (context.retentionLows ?? []).length > 0) && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2 rounded-xl bg-surface-container-low p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-on-surface">
                    <Icon name="insights" size={16} className="text-primary" />
                    많이 본 구간
                  </p>
                  {context.retentionPeaks.length === 0 ? (
                    <p className="text-xs text-on-surface-variant">없음</p>
                  ) : (
                    <div className="space-y-1.5">
                      {context.retentionPeaks.map((peak, index) => (
                        <div
                          key={index}
                          className="rounded-lg bg-secondary-container/70 px-3 py-2 text-xs text-on-secondary-container"
                        >
                          <div className="flex items-center justify-between font-semibold tabular-nums">
                            <span>
                              {formatClock(peak.startSec)} –{' '}
                              {formatClock(peak.endSec)}
                            </span>
                            <span>
                              유지율 {Math.round(peak.watchRatio * 100)}%
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2 rounded-xl bg-surface-container-low p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-on-surface">
                    <Icon name="warning" size={16} className="text-error" />
                    이탈 구간
                  </p>
                  {(context.retentionLows ?? []).length === 0 ? (
                    <p className="text-xs text-on-surface-variant">없음</p>
                  ) : (
                    <div className="space-y-1.5">
                      {(context.retentionLows ?? []).map((low, index) => (
                        <div
                          key={index}
                          className="rounded-lg bg-error-container/60 px-3 py-2 text-xs text-on-error-container"
                        >
                          <div className="flex items-center justify-between font-semibold tabular-nums">
                            <span>
                              {formatClock(low.startSec)} –{' '}
                              {formatClock(low.endSec)}
                            </span>
                            <span>
                              유지율 {Math.round(low.watchRatio * 100)}%
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Viewer comments */}
            <div className="space-y-2 rounded-xl bg-surface-container-low p-3">
              <p className="text-xs font-semibold text-on-surface">
                댓글 {(context.comments ?? []).length}개
              </p>
              {(context.comments ?? []).length === 0 ? (
                <p className="text-xs text-on-surface-variant">없음</p>
              ) : (
                <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
                  {(context.comments ?? []).map((comment) => (
                    <div
                      key={comment.commentId}
                      className="rounded-lg bg-surface p-2.5 text-xs"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
                        <span className="font-semibold text-on-surface">
                          {comment.author}
                        </span>
                        {comment.publishedAt && (
                          <span>{formatPublishedDate(comment.publishedAt)}</span>
                        )}
                        {comment.likeCount > 0 && (
                          <span>👍 {comment.likeCount.toLocaleString()}</span>
                        )}
                        {comment.timestampSec !== null && (
                          <span className="rounded-full bg-secondary-container px-2 py-0.5 font-medium text-on-secondary-container tabular-nums">
                            ⏱ {formatClock(comment.timestampSec)}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-on-surface">
                        {comment.text}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {loadingList && <ProgressBar label="내 채널 영상 목록 불러오는 중" />}
        {listError && <Notice tone="warning">{listError}</Notice>}
        {videos !== null && !loadingList && (
          videos.length === 0 ? (
            <p className="text-xs text-on-surface-variant">
              표시할 채널 영상이 없습니다.
            </p>
          ) : (
            <div className="space-y-2">
              <span className="block text-xs font-medium text-on-surface">
                내 채널 영상 ({videos.length}개)
              </span>
              <div className="grid max-h-[460px] grid-cols-1 gap-3 overflow-y-auto pr-1">
                {videos.map((item) => {
                  const selected = item.videoId === videoId;
                  const durationMatched = isDurationMatched(
                    item.durationSec,
                    durationSec,
                  );
                  const isNewestMatch =
                    durationMatched && item.videoId === newestMatchedVideoId;
                  return (
                    <div
                      key={item.videoId}
                      role="button"
                      tabIndex={0}
                      onClick={() => onChange(selected ? '' : item.videoId)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onChange(selected ? '' : item.videoId);
                        }
                      }}
                      className={`flex cursor-pointer flex-col gap-3 rounded-2xl p-3.5 text-left transition-colors sm:flex-row sm:items-start ${STATE_LAYER} ${
                        selected
                          ? 'bg-secondary-container/80 text-on-secondary-container ring-2 ring-primary'
                          : durationMatched
                            ? 'bg-primary-container/20 text-on-surface ring-1 ring-primary/60'
                            : 'bg-surface text-on-surface'
                      }`}
                    >
                      <div className="relative h-28 w-full shrink-0 overflow-hidden rounded-xl bg-surface-container-highest sm:h-28 sm:w-48">
                        {item.thumbnailUrl ? (
                          <img
                            src={item.thumbnailUrl}
                            alt={item.title}
                            referrerPolicy="no-referrer"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="grid h-full w-full place-items-center">
                            <Icon name="video_library" size={28} />
                          </span>
                        )}
                        {item.durationSec > 0 && (
                          <span className="absolute right-2 bottom-2 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold text-white tabular-nums">
                            {formatClock(item.durationSec)}
                          </span>
                        )}
                      </div>

                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {isNewestMatch && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-on-primary">
                              자동 매칭
                            </span>
                          )}
                          {!isNewestMatch && durationMatched && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-primary/85 px-2.5 py-0.5 text-[11px] font-semibold text-on-primary">
                              길이 일치
                            </span>
                          )}
                          <span className="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-medium text-on-surface-variant">
                            {formatPrivacyLabel(item.privacyStatus)}
                          </span>
                          {item.hasCaptions && (
                            <span className="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-medium text-on-surface-variant">
                              공식 자막
                            </span>
                          )}
                          {selected && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-primary/20 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
                              <Icon name="check" size={14} />
                              선택됨
                            </span>
                          )}
                        </div>

                        <div className="flex items-start justify-between gap-2">
                          <p className="line-clamp-2 text-sm font-semibold sm:text-base">
                            {item.title}
                          </p>
                          <a
                            href={`https://www.youtube.com/watch?v=${item.videoId}`}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="YouTube에서 보기"
                            className="shrink-0 rounded-lg p-1 text-on-surface-variant hover:bg-surface-container-highest hover:text-primary"
                          >
                            <Icon name="open_in_new" size={16} />
                          </a>
                        </div>

                        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs opacity-85 tabular-nums">
                          {item.publishedAt && (
                            <span>
                              {formatPublishedDate(item.publishedAt)}
                            </span>
                          )}
                          <span>
                            조회수 {item.viewCount.toLocaleString()}회
                          </span>
                          <span>
                            좋아요 {(item.likeCount ?? 0).toLocaleString()}
                          </span>
                          <span>
                            댓글 {(item.commentCount ?? 0).toLocaleString()}개
                          </span>
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )
        )}
      </div>
    </details>
  );
}

/** Drag-and-drop of one video file onto an element. */
function useFileDrop(onFile: (file: File) => void, onReject: () => void) {
  const [dragging, setDragging] = useState(false);
  const handlers = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (event.dataTransfer.types.includes('Files')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
        setDragging(false);
      }
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (!file) {
        return;
      }
      if (isVideoFile(file)) {
        onFile(file);
      } else {
        onReject();
      }
    },
  };
  return {dragging, handlers};
}

function DropZone(props: {
  dragging: boolean;
  handlers: ReturnType<typeof useFileDrop>['handlers'];
  onFile: (file: File) => void;
}) {
  return (
    <div
      {...props.handlers}
      className={`flex min-h-80 flex-col items-center justify-center gap-6 rounded-[28px] border-2 border-dashed px-6 py-12 text-center transition-colors ${
        props.dragging
          ? 'border-primary bg-primary-container/40'
          : 'border-outline-variant bg-surface-container-low'
      }`}
    >
      <span className="grid h-16 w-16 place-items-center rounded-full bg-secondary-container text-on-secondary-container">
        <Icon name="upload" size={32} />
      </span>
      <p className="text-lg text-on-surface">
        영상 파일을 끌어다 놓거나 선택하세요
      </p>
      <FilePicker
        label="파일 선택"
        accept={VIDEO_ACCEPT}
        busy={false}
        icon="movie"
        variant="filled"
        size="md"
        onFile={props.onFile}
      />
    </div>
  );
}

function FileCard(props: {
  upload: Exclude<UploadState, {status: 'empty'}>;
  dragging: boolean;
  handlers: ReturnType<typeof useFileDrop>['handlers'];
  onFile: (file: File) => void;
  children?: ReactNode;
}) {
  const {upload} = props;
  let detail: string;
  switch (upload.status) {
    case 'uploading':
      detail =
        upload.loadedBytes >= upload.file.size
          ? '영상을 확인하고 있어요'
          : `${formatMegabytes(upload.loadedBytes)} / ${formatMegabytes(upload.file.size)}`;
      break;
    case 'ready':
      detail = `${formatClock(upload.source.media.durationSec)} (${formatLength(upload.source.media.durationSec)}) · ${upload.source.media.width}×${upload.source.media.height}`;
      break;
    case 'failed':
      detail = '올리지 못했어요';
      break;
    default: {
      const unhandled: never = upload;
      throw new Error(`Unhandled upload ${JSON.stringify(unhandled)}`);
    }
  }
  return (
    <div
      {...props.handlers}
      className={`rounded-[28px] p-6 transition-colors ${
        props.dragging
          ? 'bg-primary-container/40 ring-2 ring-primary'
          : 'bg-surface-container'
      }`}
    >
      <div className="flex items-center gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-secondary-container text-on-secondary-container">
          <Icon name="movie" size={28} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-base font-medium text-on-surface"
            title={upload.file.name}
          >
            {upload.file.name}
          </p>
          <p className="text-sm text-on-surface-variant tabular-nums">
            {detail}
          </p>
        </div>
        <FilePicker
          label="다른 파일"
          accept={VIDEO_ACCEPT}
          busy={false}
          icon="upload"
          variant="text"
          size="md"
          onFile={props.onFile}
        />
      </div>
      {upload.status === 'uploading' && (
        <ProgressBar
          className="mt-5"
          label="업로드"
          value={
            upload.loadedBytes >= upload.file.size
              ? undefined
              : upload.loadedBytes / Math.max(1, upload.file.size)
          }
        />
      )}
      {upload.status === 'failed' && (
        <Notice tone="error" className="mt-5">
          {upload.error}
        </Notice>
      )}
      {props.children}
    </div>
  );
}

export function StartScreen(props: {
  upload: UploadState;
  onFile: (file: File) => void;
  prompt: string;
  defaultPrompt: string;
  onPromptChange: (value: string) => void;
  youtubeVideoId: string;
  onYoutubeVideoIdChange: (videoId: string) => void;
  /** Non-empty when the server cannot call Gemini. */
  setupError: string;
  /** The last analysis failure, kept until dismissed. */
  analysisError: string | null;
  onDismissError: () => void;
  onStart: () => void;
}) {
  const {upload} = props;
  const [rejected, setRejected] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);

  const pick = (file: File) => {
    setRejected(false);
    props.onDismissError();
    props.onYoutubeVideoIdChange('');
    props.onFile(file);
  };
  const drop = useFileDrop(pick, () => setRejected(true));
  const ready = upload.status === 'ready';
  const durationSec = ready ? upload.source.media.durationSec : 0;

  const handleTunePrompt = (context: YouTubeVideoContext) => {
    const tuned = buildDataTunedPrompt(props.prompt, context);
    props.onPromptChange(tuned);
    setPromptOpen(true);
  };

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 pt-[6vh] pb-16 sm:px-6">
      {props.setupError && <Notice tone="error">{props.setupError}</Notice>}
      {props.analysisError && (
        <Notice tone="error" onClose={props.onDismissError}>
          {props.analysisError}
        </Notice>
      )}
      {rejected && (
        <Notice tone="error" onClose={() => setRejected(false)}>
          영상 파일만 올릴 수 있어요
        </Notice>
      )}
      {upload.status === 'empty' ? (
        <DropZone
          dragging={drop.dragging}
          handlers={drop.handlers}
          onFile={pick}
        />
      ) : (
        <FileCard
          upload={upload}
          dragging={drop.dragging}
          handlers={drop.handlers}
          onFile={pick}
        >
          {ready && (
            <div className="rise-in mt-6 flex justify-center">
              <Button
                variant="gradient"
                size="lg"
                disabled={props.setupError !== '' || props.prompt.trim() === ''}
                onClick={props.onStart}
                className="min-w-56"
              >
                Shorts 만들기
              </Button>
            </div>
          )}
        </FileCard>
      )}
      <YouTubeChannelLinkSection
        videoId={props.youtubeVideoId}
        durationSec={durationSec}
        hasUploadedFile={upload.status !== 'empty'}
        onChange={props.onYoutubeVideoIdChange}
        onTunePrompt={handleTunePrompt}
      />
      <details
        open={promptOpen}
        onToggle={(event) => setPromptOpen(event.currentTarget.open)}
        className="group rounded-[28px] bg-surface-container-low open:bg-surface-container"
      >
        <summary className="flex h-14 cursor-pointer list-none items-center gap-2 rounded-[28px] px-6 text-sm font-medium text-on-surface-variant select-none hover:text-on-surface">
          <Icon
            name="expand_more"
            className="transition-transform group-open:rotate-180"
          />
          <span>편집 요청 바꾸기</span>
          {props.prompt.includes(TUNED_SECTION_HEADER) && (
            <span className="ms-auto rounded-full bg-secondary-container px-3 py-0.5 text-xs font-medium text-on-secondary-container">
              데이터 튜닝 적용됨
            </span>
          )}
        </summary>
        <div className="px-4 pb-4">
          <PromptEditor
            value={props.prompt}
            defaultValue={props.defaultPrompt}
            onChange={props.onPromptChange}
          />
        </div>
      </details>
    </main>
  );
}
