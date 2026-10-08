/**
 * The editor of one analysis. The header holds the Shorts tabs, the cost
 * and time of the analysis and the actions; the body has the clips on the
 * left, the pinned preview in the middle and the 자막 · 스타일 · 소리 tabs
 * on the right (layout in index.css). Every edit resolves on the client
 * (lib/timeline.ts) and feeds the preview and the MP4 render at once.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type {AnalysisState} from '../hooks/useAnalysis';
import type {AssetStore} from '../hooks/useAssets';
import {errorMessage, renderPlan} from '../lib/api';
import {createEditorState, editorReducer, type EditorAction} from '../lib/editor';
import {tabOf, type FocusRequest, type FocusTarget} from '../lib/focus';
import {formatClock, formatCost, formatDuration} from '../lib/format';
import {lookTarget} from '../lib/look';
import {
  clipSubcuts,
  resolveScenario,
  wordsStartingIn,
  type ResolvedScenario,
  type Transcript,
  type TranscriptEdits,
} from '../lib/timeline';
import type {
  AnalysisReport,
  AnalysisResult,
  Look,
  RenderQuality,
  Scenario,
  StudioConfig,
  TimeRange,
  UploadedSource,
  YouTubeComment,
  YouTubeRetentionPeak,
  YouTubeRetentionPoint,
} from '../types';
import {statusLine} from './AnalyzingScreen';
import {Brand, CreatorBadge} from './AppHeader';
import {ClipEditor} from './ClipEditor';
import {ExportDialog, type RenderJob} from './ExportDialog';
import {Icon, type IconName} from './Icon';
import {LookControls} from './LookControls';
import {
  PreviewStage,
  type PlaybackState,
  type SourceSeekRequest,
} from './preview/PreviewStage';
import {ScenarioAudioControls} from './ScenarioAudioControls';
import {RetentionSparkline} from './StartScreen';
import {ThemeMenu} from './ThemeMenu';
import {TranscriptPanel} from './TranscriptPanel';
import {Button, Card, IconButton, Notice, ProgressBar, STATE_LAYER} from './ui';

/**
 * Arrow, Home and End keys move the selection of a tab list; focus follows
 * the selected tab.
 */
function onTabListKey(
  event: KeyboardEvent<HTMLElement>,
  index: number,
  count: number,
  select: (index: number) => void,
) {
  let next: number;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (index + 1) % count;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (index - 1 + count) % count;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  select(next);
  const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
  tabs?.[next]?.focus();
}

/**
 * A horizontal strip of the Scenarios Gemini proposed, placed above the
 * editor grid so it takes no column width. Titles are never truncated: the
 * strip scrolls sideways (wheel, drag-free trackpad, arrow buttons) with
 * fading edges, and the selected Scenario scrolls into view. The rationale
 * of a Scenario shows as its tooltip.
 */
function ScenarioList(props: {
  scenarios: readonly Scenario[];
  original: readonly Scenario[];
  durations: readonly number[];
  index: number;
  onSelect: (index: number) => void;
}) {
  const {scenarios, original, durations, index} = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({left: false, right: false});

  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdges((prev) =>
      prev.left === left && prev.right === right ? prev : {left, right},
    );
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    // Vertical wheel scrolls the strip sideways while it can still move.
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const next = el.scrollLeft + event.deltaY;
      if ((next <= 0 && el.scrollLeft <= 0) || (next >= max && el.scrollLeft >= max)) {
        return;
      }
      event.preventDefault();
      el.scrollBy({left: event.deltaY, behavior: 'auto'});
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    return () => {
      observer.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
  }, [updateEdges, scenarios.length]);

  useEffect(() => {
    const el = scrollerRef.current;
    const tab = el?.querySelectorAll<HTMLElement>('[role="tab"]')[index];
    if (!el || !tab) return;
    const tabLeft = tab.offsetLeft - el.offsetLeft;
    const tabRight = tabLeft + tab.offsetWidth;
    if (tabLeft < el.scrollLeft || tabRight > el.scrollLeft + el.clientWidth) {
      el.scrollTo({
        left: tabLeft - (el.clientWidth - tab.offsetWidth) / 2,
        behavior: 'smooth',
      });
    }
  }, [index]);

  const scrollByPage = (direction: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({left: direction * el.clientWidth * 0.8, behavior: 'smooth'});
  };

  return (
    <section
      aria-label="시나리오"
      className="scenario-strip relative flex items-center gap-2 rounded-3xl bg-surface-container-low px-2 py-2"
    >
      <span className="hidden shrink-0 ps-2 pe-1 text-xs font-medium text-on-surface-variant sm:inline">
        시나리오 {scenarios.length}개
      </span>
      {edges.left && (
        <IconButton
          icon="chevron_left"
          label="이전 시나리오 보기"
          onClick={() => scrollByPage(-1)}
          className="shrink-0"
        />
      )}
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label="시나리오 목록"
        onScroll={updateEdges}
        className={`scenario-strip-scroller flex min-w-0 flex-1 snap-x snap-proximity gap-2 overflow-x-auto scroll-smooth ${
          edges.left ? 'fade-left' : ''
        } ${edges.right ? 'fade-right' : ''}`}
      >
        {scenarios.map((scenario, position) => {
          const selected = position === index;
          const edited = scenario !== original[position];
          const duration = durations[position];
          const title = scenario.title.trim() || `시나리오 ${position + 1}`;
          return (
            <button
              key={scenario.scenarioId}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              title={scenario.rationale ? `${title}\n\n${scenario.rationale}` : title}
              onClick={() => props.onSelect(position)}
              onKeyDown={(event) =>
                onTabListKey(event, position, scenarios.length, props.onSelect)
              }
              className={`flex shrink-0 snap-start items-center gap-2 rounded-full px-4 py-2 text-left whitespace-nowrap transition-all ${STATE_LAYER} ${
                selected
                  ? 'bg-secondary-container text-on-secondary-container shadow-xs'
                  : 'bg-surface-container text-on-surface hover:bg-surface-container-high'
              }`}
            >
              {selected && (
                <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-primary p-0.5 text-on-primary">
                  <Icon name="check" size={14} />
                </span>
              )}
              <span className="text-xs font-semibold text-on-surface-variant">
                {position + 1}
              </span>
              <span className="text-sm font-medium">
                {title}
                {edited && (
                  <span className="ms-1 font-bold text-warning" title="수정됨">
                    •
                  </span>
                )}
              </span>
              <span className="text-xs text-on-surface-variant">
                클립 {scenario.clips.length}개
                {duration !== undefined && duration > 0 &&
                  ` · ${formatDuration(duration)}`}
              </span>
            </button>
          );
        })}
      </div>
      {edges.right && (
        <IconButton
          icon="chevron_right"
          label="다음 시나리오 보기"
          onClick={() => scrollByPage(1)}
          className="shrink-0"
        />
      )}
    </section>
  );
}

/**
 * Right-hand tab showing YouTube Audience Retention curve, high-watch peaks,
 * low-watch drop-off intervals, and actual viewer comments with quick seek &
 * clip-add actions.
 */
function YouTubeInsightsPanel(props: {
  youtubeVideoId?: string;
  sourceDurationSec: number;
  clipIndex: number;
  retentionPoints?: readonly YouTubeRetentionPoint[];
  retentionPeaks?: readonly YouTubeRetentionPeak[];
  retentionLows?: readonly YouTubeRetentionPeak[];
  comments?: readonly YouTubeComment[];
  onSeekSource: (sourceSec: number) => void;
  dispatch: Dispatch<EditorAction>;
}) {
  const {
    youtubeVideoId,
    sourceDurationSec,
    clipIndex,
    retentionPoints = [],
    retentionPeaks = [],
    retentionLows = [],
    comments = [],
    onSeekSource,
    dispatch,
  } = props;

  const hasAnyData =
    Boolean(youtubeVideoId) ||
    retentionPoints.length > 0 ||
    retentionPeaks.length > 0 ||
    retentionLows.length > 0 ||
    comments.length > 0;

  if (!hasAnyData) {
    return (
      <div className="space-y-2 rounded-2xl bg-surface p-5 text-center">
        <p className="text-sm font-medium text-on-surface">
          연결된 YouTube 영상 데이터가 없어요
        </p>
        <p className="text-xs text-on-surface-variant">
          첫 화면에서 내 채널의 롱폼 영상을 연결하면 시청자 유지율 곡선(많이 본
          피크 구간 · 이탈 구간)과 실제 시청자 댓글 반응을 여기서 바로 확인하고
          클립으로 추가할 수 있습니다.
        </p>
      </div>
    );
  }

  const addSpanAsClip = (startSec: number, endSec: number) => {
    const safeStart = Math.max(0, startSec);
    const safeEnd = Math.min(
      sourceDurationSec > 0 ? sourceDurationSec : endSec,
      Math.max(safeStart + 2, endSec),
    );
    dispatch({
      type: 'addClip',
      range: {startSec: safeStart, endSec: safeEnd},
      afterIndex: clipIndex,
    });
  };

  return (
    <div className="space-y-4">
      {youtubeVideoId && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-surface px-4 py-3 text-xs">
          <span className="font-medium text-on-surface">
            연결된 YouTube 영상 ID: <code>{youtubeVideoId}</code>
          </span>
          <a
            href={`https://www.youtube.com/watch?v=${youtubeVideoId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            YouTube에서 열기
            <Icon name="open_in_new" size={14} />
          </a>
        </div>
      )}

      {/* Audience Retention Curve */}
      <div className="space-y-2 rounded-2xl bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-on-surface">
            YouTube Analytics 시청자 유지율 곡선
          </span>
          <span className="text-[11px] text-on-surface-variant">
            파란 영역: 많이 본 피크 · 빨간 영역: 이탈 주의
          </span>
        </div>
        {retentionPoints.length > 1 ? (
          <RetentionSparkline
            points={retentionPoints}
            peaks={retentionPeaks}
            lows={retentionLows}
            durationSec={sourceDurationSec}
          />
        ) : (
          <p className="text-xs text-on-surface-variant">
            시청자 유지율 곡선 집계 데이터가 아직 없습니다.
          </p>
        )}
      </div>

      {/* High-retention peaks */}
      <div className="space-y-2 rounded-2xl bg-surface p-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-on-surface">
          <Icon name="insights" size={16} className="text-primary" />
          🔥 시청자가 많이 본 피크 구간 ({retentionPeaks.length}곳)
        </p>
        {retentionPeaks.length === 0 ? (
          <p className="text-xs text-on-surface-variant">
            감지된 시청 집중 피크 구간이 없습니다.
          </p>
        ) : (
          <div className="space-y-2">
            {retentionPeaks.map((peak, idx) => (
              <div
                key={idx}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-secondary-container/60 p-3 text-xs text-on-secondary-container"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold tabular-nums">
                    {formatClock(peak.startSec)} – {formatClock(peak.endSec)} ·
                    유지율 {Math.round(peak.watchRatio * 100)}% (상위{' '}
                    {Math.round(peak.relativePerformance * 100)}%)
                  </p>
                  <p className="mt-0.5 text-[11px] opacity-85">{peak.label}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="text"
                    size="sm"
                    icon="play_arrow"
                    onClick={() => onSeekSource(peak.startSec)}
                  >
                    미리보기
                  </Button>
                  <Button
                    variant="tonal"
                    size="sm"
                    icon="add"
                    onClick={() => addSpanAsClip(peak.startSec, peak.endSec)}
                  >
                    클립 추가
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Low-retention / drop-off intervals */}
      <div className="space-y-2 rounded-2xl bg-surface p-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-on-surface">
          <Icon name="warning" size={16} className="text-error" />
          ⚠️ 시청자가 적게 본 · 이탈 구간 ({retentionLows.length}곳)
        </p>
        {retentionLows.length === 0 ? (
          <p className="text-xs text-on-surface-variant">
            뚜렷한 시청자 이탈 구간이 감지되지 않았습니다.
          </p>
        ) : (
          <div className="space-y-2">
            {retentionLows.map((low, idx) => (
              <div
                key={idx}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-error-container/55 p-3 text-xs text-on-error-container"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold tabular-nums">
                    {formatClock(low.startSec)} – {formatClock(low.endSec)} ·
                    유지율 {Math.round(low.watchRatio * 100)}% (상대{' '}
                    {Math.round(low.relativePerformance * 100)}%)
                  </p>
                  <p className="mt-0.5 text-[11px] opacity-85">{low.label}</p>
                </div>
                <Button
                  variant="text"
                  size="sm"
                  icon="play_arrow"
                  onClick={() => onSeekSource(low.startSec)}
                >
                  위치 확인
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Viewer comments */}
      <div className="space-y-2 rounded-2xl bg-surface p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-on-surface">
            💬 실제 시청자 댓글 반응 ({comments.length}개)
          </p>
          {comments.some((c) => c.timestampSec !== null) && (
            <span className="text-[11px] text-primary">
              타임스탬프 클릭 시 해당 위치로 이동
            </span>
          )}
        </div>
        {comments.length === 0 ? (
          <p className="text-xs text-on-surface-variant">
            표시할 공개 댓글이 없습니다.
          </p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {comments.map((comment) => (
              <div
                key={comment.commentId}
                className="rounded-xl bg-surface-container-low p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
                    <span className="font-semibold text-on-surface">
                      {comment.author}
                    </span>
                    {comment.likeCount > 0 && (
                      <span>👍 {comment.likeCount.toLocaleString()}</span>
                    )}
                    {comment.timestampSec !== null && (
                      <button
                        type="button"
                        onClick={() =>
                          comment.timestampSec !== null &&
                          onSeekSource(comment.timestampSec)
                        }
                        className="inline-flex items-center gap-0.5 rounded-full bg-secondary-container px-2 py-0.5 font-medium text-on-secondary-container tabular-nums hover:ring-1 hover:ring-primary"
                      >
                        <Icon name="play_arrow" size={12} />
                        {formatClock(comment.timestampSec)}
                      </button>
                    )}
                  </div>
                  {comment.timestampSec !== null && (
                    <button
                      type="button"
                      onClick={() =>
                        comment.timestampSec !== null &&
                        addSpanAsClip(
                          Math.max(0, comment.timestampSec - 2),
                          comment.timestampSec + 12,
                        )
                      }
                      className="rounded-lg bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/25"
                    >
                      +클립 추가
                    </button>
                  )}
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-on-surface">
                  {comment.text}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** "약 $0.21 · 3분 12초": the list-price cost and the length of the analysis. */
function CostChip(props: {report: AnalysisReport}) {
  const {costUsd, elapsedSec} = props.report;
  const time = formatDuration(elapsedSec);
  return (
    <span
      title={
        costUsd === null
          ? '이번 분석에 걸린 시간이에요. 비용은 계산할 수 없어서 빠졌어요.'
          : '이번 분석의 예상 비용과 걸린 시간이에요. 비용은 공개된 Gemini 정가로 ' +
            '계산해서 실제 청구액과 다를 수 있어요.'
      }
      className="inline-flex h-8 shrink-0 items-center rounded-lg border border-outline-variant px-3 text-[13px] text-on-surface-variant tabular-nums max-sm:hidden"
    >
      {costUsd === null ? time : `${formatCost(costUsd)} · ${time}`}
    </span>
  );
}

/** A labeled button on wide screens and an icon button below 1024px. */
function HeaderAction(props: {
  label: string;
  icon: IconName;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <>
      <Button
        variant="text"
        icon={props.icon}
        disabled={props.disabled}
        onClick={props.onClick}
        className="max-lg:hidden"
      >
        {props.label}
      </Button>
      <IconButton
        label={props.label}
        icon={props.icon}
        disabled={props.disabled}
        onClick={props.onClick}
        className="lg:hidden"
      />
    </>
  );
}

type ToolTab = 'captions' | 'style' | 'sound' | 'insights';

const TOOL_TABS: readonly {value: ToolTab; label: string; icon: IconName}[] = [
  {value: 'captions', label: '자막', icon: 'subtitles'},
  {value: 'style', label: '스타일', icon: 'palette'},
  {value: 'sound', label: '소리', icon: 'music_note'},
  {value: 'insights', label: '반응·댓글', icon: 'insights'},
];

/**
 * The 자막 · 스타일 · 소리 · 반응·댓글 tabs. Hidden panels stay mounted and keep state.
 * The parent owns the selection, as a click on the preview can change it.
 */
function ToolTabs(props: {
  tab: ToolTab;
  onSelect: (tab: ToolTab) => void;
  panels: Record<ToolTab, ReactNode>;
}) {
  const {tab, onSelect: setTab} = props;
  const id = useId();
  const select = (index: number) => setTab(TOOL_TABS[index].value);
  return (
    <section className="rounded-[28px] bg-surface-container">
      <div
        role="tablist"
        aria-label="편집 도구"
        className="flex overflow-hidden rounded-t-[28px] border-b border-outline-variant/70"
      >
        {TOOL_TABS.map((item, index) => {
          const selected = item.value === tab;
          return (
            <button
              key={item.value}
              id={`${id}-tab-${item.value}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel-${item.value}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(item.value)}
              onKeyDown={(event) => onTabListKey(event, index, TOOL_TABS.length, select)}
              className={`flex h-14 flex-1 items-center justify-center gap-1.5 text-sm font-medium ${STATE_LAYER} ${
                selected ? 'text-primary' : 'text-on-surface-variant'
              }`}
            >
              <Icon name={item.icon} filled={selected} />
              {item.label}
              {selected && (
                <span className="absolute inset-x-6 bottom-0 h-[3px] rounded-t-full bg-primary" />
              )}
            </button>
          );
        })}
      </div>
      {TOOL_TABS.map((item) => (
        <div
          key={item.value}
          id={`${id}-panel-${item.value}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${item.value}`}
          hidden={item.value !== tab}
          className="p-4"
        >
          {props.panels[item.value]}
        </div>
      ))}
    </section>
  );
}

export function EditorScreen(props: {
  config: StudioConfig;
  result: AnalysisResult;
  /** Object URL of the Source Video file. */
  videoUrl: string;
  source: UploadedSource;
  assets: AssetStore;
  /** A re-analysis of the same video, shown in the header while it runs. */
  analysis: AnalysisState;
  onReanalyze: () => void;
  onCancelAnalysis: () => void;
  onNewVideo: () => void;
  onLogout: () => void;
}) {
  const {config, result, source, assets} = props;
  const [state, dispatch] = useReducer(editorReducer, undefined, () =>
    createEditorState(result, config.composition),
  );
  // An image stays selected only in the Clip where it was picked.
  const [imageSelection, setImageSelection] = useState<{
    scope: string;
    overlayId: string;
  } | null>(null);
  const [tab, setTab] = useState<ToolTab>('captions');
  // The latest click-to-focus request; the panels act on it once.
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    playing: false,
    sourceSec: null,
  });
  const [seekRequest, setSeekRequest] = useState<SourceSeekRequest | null>(
    null,
  );
  const [warningsOpen, setWarningsOpen] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [renderQuality, setRenderQuality] = useState<RenderQuality>('1440p');
  const [jobs, setJobs] = useState<Readonly<Record<string, RenderJob>>>({});

  const handleSeekSource = useCallback((sourceSec: number) => {
    setSeekRequest((prev) => ({seq: (prev?.seq ?? 0) + 1, sourceSec}));
  }, []);

  const transcript = useMemo<Transcript>(
    () => ({
      words: [...result.transcriptWords].sort((a, b) => a.startSec - b.startSec),
      lineStarts: new Set(result.lineStartIndices),
    }),
    [result],
  );
  const pauses = result.silences;
  const fps = source.media.fps > 0 ? source.media.fps : result.sourceVideo.fps;
  const minCueSec = fps > 0 ? 1 / fps : 0;
  const edits = useMemo<TranscriptEdits>(
    () => ({cutWords: state.cutWords, wordText: state.wordText}),
    [state.cutWords, state.wordText],
  );
  const resolvedAll = useMemo(
    () =>
      state.scenarios.map((scenario) =>
        resolveScenario({
          scenario,
          transcript,
          edits,
          pauses,
          settings: state.settings,
          minCueSec,
        }),
      ),
    [state.scenarios, transcript, edits, pauses, state.settings, minCueSec],
  );
  const subcutsFor = useCallback(
    (range: TimeRange) =>
      clipSubcuts({
        range,
        words: wordsStartingIn(transcript.words, range),
        edits,
        pauses,
        settings: state.settings,
      }),
    [transcript, edits, pauses, state.settings],
  );

  const scenario: Scenario | undefined = state.scenarios[state.scenarioIndex];
  const resolved: ResolvedScenario | undefined = resolvedAll[state.scenarioIndex];
  const plan = resolved?.plan ?? null;
  const planKey = useMemo(
    () => JSON.stringify({plan, quality: renderQuality}),
    [plan, renderQuality],
  );
  const edited = scenario !== undefined && scenario !== state.original[state.scenarioIndex];
  const scope = `${state.scenarioIndex}:${state.clipIndex}`;
  const selectedImageId =
    imageSelection?.scope === scope ? imageSelection.overlayId : null;
  const selectImage = (overlayId: string | null) =>
    setImageSelection(overlayId === null ? null : {scope, overlayId});
  const running = props.analysis.status === 'running' ? props.analysis.progress : null;
  const warnings = result.analysis.warnings.join('\n');

  const render = () => {
    if (!scenario || !plan) {
      return;
    }
    const {scenarioId} = scenario;
    const key = planKey;
    const update = (job: RenderJob) =>
      setJobs((current) => ({...current, [scenarioId]: job}));
    update({status: 'running', planKey: key});
    renderPlan({sourceId: source.sourceId, plan, quality: renderQuality}).then(
      (output) => update({status: 'done', planKey: key, output}),
      (error: unknown) =>
        update({status: 'failed', planKey: key, error: errorMessage(error)}),
    );
  };

  const onLookEdit = (index: number, look: Look) => {
    if (!scenario) {
      return;
    }
    dispatch({type: 'selectClip', index});
    dispatch({type: 'setLook', clipId: lookTarget(scenario, index), look});
  };

  const requestFocus = (target: FocusTarget) => {
    setTab(tabOf(target));
    setFocus((current) => ({seq: (current?.seq ?? 0) + 1, target}));
  };
  // A click on the stage edits the Clip on screen, so select it first.
  const onStageFocus = (index: number, target: FocusTarget) => {
    if (index !== state.clipIndex) {
      dispatch({type: 'selectClip', index});
    }
    if (target.kind === 'image') {
      setImageSelection({
        scope: `${state.scenarioIndex}:${index}`,
        overlayId: target.overlayId,
      });
    }
    requestFocus(target);
  };

  const runningText = running ? running.thought || statusLine(running.stage) : '';

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-30 bg-surface">
        <div className="relative mx-auto flex h-16 w-full max-w-[1960px] items-center justify-between gap-4 px-4 sm:px-6">
          <div className="shrink-0">
            <Brand titleClassName="max-sm:hidden" />
          </div>
          <div className="flex min-w-0 items-center justify-end gap-1">
            {running ? (
              <div className="flex h-10 max-w-80 min-w-0 items-center gap-1 rounded-full bg-surface-container ps-4 pe-1 max-sm:ps-1">
                <span
                  title={runningText}
                  className="min-w-0 flex-1 truncate text-sm text-on-surface-variant max-sm:hidden"
                >
                  {runningText}
                </span>
                <Button variant="text" size="sm" onClick={props.onCancelAnalysis}>
                  중단
                </Button>
              </div>
            ) : (
              <CostChip report={result.analysis} />
            )}
            <HeaderAction
              label="다시 분석"
              icon="refresh"
              disabled={running !== null}
              onClick={props.onReanalyze}
            />
            <HeaderAction label="새 영상" icon="add" onClick={props.onNewVideo} />
            <CreatorBadge user={config.auth.user} onLogout={props.onLogout} />
            <ThemeMenu />
            <Button
              variant="danger"
              icon="download"
              disabled={!scenario}
              onClick={() => setExportOpen(true)}
              className="ms-1"
            >
              내보내기
            </Button>
          </div>
          {running && (
            <div className="absolute inset-x-0 bottom-0">
              <ProgressBar gradient label="다시 분석 중" />
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1960px] flex-1 px-4 pt-2 pb-4 sm:px-6">
        {warningsOpen && warnings !== '' && (
          <Notice tone="warning" onClose={() => setWarningsOpen(false)} className="mb-4">
            {warnings}
          </Notice>
        )}
        {scenario && resolved ? (
          <>
          <div className="mb-3">
            <ScenarioList
              scenarios={state.scenarios}
              original={state.original}
              durations={resolvedAll.map((item) => item.durationSec)}
              index={state.scenarioIndex}
              onSelect={(index) => dispatch({type: 'selectScenario', index})}
            />
          </div>
          <div className="editor-grid">
            <div className="editor-clips space-y-4">
              <ClipEditor
                clips={resolved.clips}
                clipIndex={state.clipIndex}
                transcript={transcript}
                settings={state.settings}
                sourceDurationSec={state.sourceDurationSec}
                retentionPoints={result.retentionPoints}
                retentionPeaks={result.retentionPeaks}
                retentionLows={result.retentionLows}
                subcutsFor={subcutsFor}
                assets={assets}
                edited={edited}
                dispatch={dispatch}
              />
            </div>
            <div className="editor-preview">
              <Card>
                <PreviewStage
                  config={config}
                  resolved={resolved}
                  scenario={scenario}
                  clipIndex={state.clipIndex}
                  videoUrl={props.videoUrl}
                  fps={fps}
                  assetUrls={assets.urls}
                  selectedImageId={selectedImageId}
                  seekRequest={seekRequest}
                  onPlaybackChange={setPlaybackState}
                  onSelectClip={(index) => dispatch({type: 'selectClip', index})}
                  onSelectImage={selectImage}
                  onLookEdit={onLookEdit}
                  onFocus={onStageFocus}
                />
              </Card>
            </div>
            <div className="editor-tabs">
              <ToolTabs
                tab={tab}
                onSelect={setTab}
                panels={{
                  captions: (
                    <TranscriptPanel
                      transcript={transcript}
                      clips={resolved.clips}
                      clipIndex={state.clipIndex}
                      edits={edits}
                      minSubcutSec={state.settings.minSubcutSec}
                      config={config}
                      scenario={scenario}
                      captionMaxChars={state.settings.captionMaxChars}
                      playbackState={playbackState}
                      onSeekSource={handleSeekSource}
                      focus={focus}
                      onStyleCaption={() => requestFocus({kind: 'captionStyle'})}
                      dispatch={dispatch}
                    />
                  ),
                  style: (
                    <LookControls
                      config={config}
                      scenario={scenario}
                      clipIndex={state.clipIndex}
                      assets={assets}
                      selectedImageId={selectedImageId}
                      focus={focus}
                      onSelectImage={selectImage}
                      dispatch={dispatch}
                    />
                  ),
                  sound: (
                    <ScenarioAudioControls
                      config={config}
                      scenario={scenario}
                      assets={assets}
                      dispatch={dispatch}
                    />
                  ),
                  insights: (
                    <YouTubeInsightsPanel
                      youtubeVideoId={result.youtubeVideoId}
                      sourceDurationSec={state.sourceDurationSec}
                      clipIndex={state.clipIndex}
                      retentionPoints={result.retentionPoints}
                      retentionPeaks={result.retentionPeaks}
                      retentionLows={result.retentionLows}
                      comments={result.youtubeComments}
                      onSeekSource={handleSeekSource}
                      dispatch={dispatch}
                    />
                  ),
                }}
              />
            </div>
          </div>
          </>
        ) : (
          <p className="mx-auto mt-[12vh] max-w-xl text-center text-lg text-on-surface-variant">
            Shorts가 없어요. 편집 요청을 바꿔 다시 분석해 보세요.
          </p>
        )}
      </main>
      {scenario && (
        <ExportDialog
          open={exportOpen}
          title={scenario.title}
          rationale={scenario.rationale}
          sourceTitle={result.sourceVideo.title}
          plan={plan}
          planKey={planKey}
          quality={renderQuality}
          job={jobs[scenario.scenarioId]}
          fontWarning={config.fontWarning}
          onQualityChange={setRenderQuality}
          onRender={render}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}
