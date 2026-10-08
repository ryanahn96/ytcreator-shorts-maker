/**
 * The whole transcript as clickable Transcript Words and lines, plus quick
 * caption controls right inside the 자막 tab:
 * - Full transcript vs current clip filter + search bar + clip membership badges
 * - Default 'direct' (바로 편집) mode: clicking any word opens an inline action
 *   bar with word text editing, word cut/restore, clip start/end, and split
 * - Batch pick modes (시작점, 끝점, 나누기, 단어 삭제, 자막 수정) for rapid one-click edits
 * - Line-level quick actions: [시작], [끝], [+클립], [문장 수정]
 * - Collapsible 자막 빠른 설정 bar (세로 위치, 글자 크기, 한 줄 글자 수, 글자색, 배경 박스)
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
} from 'react';

import type {EditorAction} from '../lib/editor';
import type {FocusRequest} from '../lib/focus';
import {formatClock, formatSeconds} from '../lib/format';
import {lookTarget} from '../lib/look';
import type {ResolvedClip, Transcript, TranscriptEdits} from '../lib/timeline';
import type {
  Look,
  Scenario,
  StudioConfig,
  TextPlacement,
  TextStyle,
  TranscriptWord,
} from '../types';
import {Icon} from './Icon';
import type {PlaybackState} from './preview/PreviewStage';
import {
  Button,
  ColorField,
  IconButton,
  Segmented,
  SliderField,
  STATE_LAYER,
  TEXT_FIELD,
  Toggle,
} from './ui';

type Tone = 'selected' | 'scenario' | 'none';
type FilterScope = 'all' | 'clip';

const TONE_CLASS: Record<Tone, string> = {
  selected: 'bg-primary-container text-on-primary-container font-medium',
  scenario: 'bg-surface-container-highest text-on-surface',
  none: 'text-on-surface-variant hover:text-on-surface',
};

interface Line {
  index: number;
  startSec: number;
  endSec: number;
  words: TranscriptWord[];
}

function transcriptLines(transcript: Transcript): Line[] {
  const lines: Line[] = [];
  for (const word of transcript.words) {
    const last = lines.at(-1);
    if (!last || transcript.lineStarts.has(word.index)) {
      lines.push({
        index: lines.length,
        startSec: word.startSec,
        endSec: word.endSec,
        words: [word],
      });
    } else {
      last.words.push(word);
      last.endSec = Math.max(last.endSec, word.endSec);
    }
  }
  return lines;
}

/**
 * Scrolls `container` so the word with `wordIndex` sits a third of the way
 * down; with `reveal`, the container itself is first scrolled into view.
 */
function scrollToWord(container: HTMLElement, wordIndex: number, reveal = false): void {
  const element = container.querySelector<HTMLElement>(`[data-word="${wordIndex}"]`);
  if (!element) {
    return;
  }
  if (reveal) {
    container.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  }
  container.scrollTo({
    top: element.offsetTop - container.clientHeight / 3,
    behavior: 'smooth',
  });
}

const WordItem = memo(function WordItem(props: {
  word: TranscriptWord;
  override: string | undefined;
  tone: Tone;
  cut: boolean;
  active: boolean;
  playing: boolean;
  onPick: (word: TranscriptWord) => void;
}) {
  const {word, override} = props;
  const hidden = override === '';
  const edited = override !== undefined && !hidden;
  const styles = [
    'rounded px-1 py-0.5 transition-colors',
    props.playing
      ? 'bg-primary text-on-primary font-semibold shadow-xs ring-2 ring-primary/40'
      : TONE_CLASS[props.tone],
    props.active ? 'ring-2 ring-primary' : '',
    word.isSoundTag ? 'italic opacity-70' : '',
    props.cut ? 'text-error line-through decoration-error' : '',
    edited ? 'underline decoration-warning decoration-dotted decoration-2' : '',
    hidden ? 'line-through opacity-50' : '',
  ];
  const notes = [
    formatClock(word.startSec),
    props.playing ? '▶ 현재 재생 중' : '',
    props.cut ? '삭제됨' : '',
    edited ? `원문: ${word.text}` : '',
    hidden ? '자막에서 숨김' : '',
  ];
  return (
    <button
      type="button"
      data-word={word.index}
      title={notes.filter(Boolean).join(' · ')}
      onClick={() => props.onPick(word)}
      className={styles.filter(Boolean).join(' ')}
    >
      {edited ? override : word.text}
    </button>
  );
});

/** Inline action bar shown when a word is clicked. */
function DirectWordBar(props: {
  word: TranscriptWord;
  override: string | undefined;
  cut: boolean;
  canSetRange: boolean;
  onSaveText: (text: string | null) => void;
  onToggleCut: () => void;
  onSetStart: () => void;
  onSetEnd: () => void;
  onSplit: () => void;
  onClose: () => void;
}) {
  const {word, override, cut} = props;
  const [text, setText] = useState(override ?? word.text);
  useEffect(() => {
    setText(override ?? word.text);
  }, [word.index, override, word.text]);

  const applyText = () => {
    const trimmed = text.trim();
    props.onSaveText(trimmed === word.text ? null : trimmed);
  };

  return (
    <div className="mt-1.5 mb-2 space-y-2 rounded-2xl border border-primary/40 bg-surface p-3 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-on-surface-variant">
          <span className="rounded bg-primary-container px-1.5 py-0.5 font-medium text-on-primary-container tabular-nums">
            {formatClock(word.startSec)}
          </span>
          <strong className="text-on-surface">{word.text}</strong>
        </div>
        <IconButton label="닫기" icon="close" size="sm" onClick={props.onClose} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              applyText();
            } else if (event.key === 'Escape') {
              props.onClose();
            }
          }}
          className={`${TEXT_FIELD} h-8 min-w-[140px] flex-1 text-xs`}
        />
        <Button variant="tonal" size="sm" onClick={applyText}>
          글자 적용
        </Button>
        {override !== undefined && (
          <Button variant="text" size="sm" onClick={() => props.onSaveText(null)}>
            원래대로
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={props.onToggleCut}
          className={`inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium ${STATE_LAYER} ${
            cut
              ? 'bg-error-container text-on-error-container'
              : 'border border-outline-variant text-on-surface'
          }`}
        >
          <Icon name={cut ? 'undo' : 'delete'} size={15} />
          {cut ? '복구' : '삭제'}
        </button>
        {props.canSetRange && (
          <>
            <button
              type="button"
              onClick={props.onSetStart}
              className={`inline-flex h-7 items-center gap-1 rounded-lg border border-outline-variant px-2.5 text-xs font-medium text-on-surface ${STATE_LAYER}`}
            >
              클립 시작
            </button>
            <button
              type="button"
              onClick={props.onSetEnd}
              className={`inline-flex h-7 items-center gap-1 rounded-lg border border-outline-variant px-2.5 text-xs font-medium text-on-surface ${STATE_LAYER}`}
            >
              클립 끝
            </button>
            <button
              type="button"
              onClick={props.onSplit}
              className={`inline-flex h-7 items-center gap-1 rounded-lg border border-outline-variant px-2.5 text-xs font-medium text-on-surface ${STATE_LAYER}`}
            >
              <Icon name="content_cut" size={14} />
              나누기
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Quick caption style & placement drawer right inside the 자막 tab. */
function QuickCaptionControls(props: {
  config: StudioConfig;
  scenario: Scenario;
  clipIndex: number;
  captionMaxChars: number;
  onOpenFullStyle: () => void;
  dispatch: Dispatch<EditorAction>;
}) {
  const {config, scenario, clipIndex, captionMaxChars, dispatch} = props;
  const clip = scenario.clips[clipIndex];
  const target = lookTarget(scenario, clipIndex);
  const look: Look = clip?.look ?? scenario.look;
  const captionStyle: TextStyle = look.style.caption;
  const captionPlacement: TextPlacement = look.textLayout.caption;
  const defaultPlacement = config.defaultTextLayouts[look.framingLayout.fit].caption;

  const setLook = (next: Look) => dispatch({type: 'setLook', clipId: target, look: next});
  const updateCaptionStyle = (patch: Partial<TextStyle>) =>
    setLook({
      ...look,
      style: {...look.style, caption: {...captionStyle, ...patch}},
    });
  const updatePlacement = (patch: Partial<TextPlacement>) =>
    setLook({
      ...look,
      textLayout: {
        ...look.textLayout,
        caption: {...captionPlacement, ...patch},
      },
    });

  return (
    <div className="space-y-3 rounded-2xl bg-surface p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-on-surface">
          자막 위치·스타일 빠른 설정
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="text"
            size="sm"
            onClick={() => updatePlacement(defaultPlacement)}
          >
            기본 위치로
          </Button>
          <Button
            variant="tonal"
            size="sm"
            icon="palette"
            onClick={props.onOpenFullStyle}
          >
            상세 스타일
          </Button>
        </div>
      </div>
      <SliderField
        label="자막 세로 위치 (Y)"
        value={captionPlacement.y}
        min={100}
        max={config.templateStyle.canvasHeight - 80}
        step={4}
        format={(val) => `${Math.round(val)}px`}
        onChange={(y) => updatePlacement({y})}
      />
      <SliderField
        label="글자 크기"
        value={captionStyle.size}
        min={24}
        max={120}
        step={2}
        format={(val) => `${Math.round(val)}px`}
        onChange={(size) => updateCaptionStyle({size})}
      />
      <SliderField
        label="한 줄 최대 글자 수"
        value={captionMaxChars}
        min={6}
        max={24}
        step={1}
        format={(val) => `${Math.round(val)}자`}
        onChange={(maxChars) =>
          dispatch({type: 'setCaptionMaxChars', maxChars})
        }
      />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ColorField
          label="글자 색"
          value={captionStyle.color}
          onChange={(color) => updateCaptionStyle({color})}
        />
        <Toggle
          label="자막 배경 박스"
          checked={captionStyle.background}
          onChange={(background) => updateCaptionStyle({background})}
        />
      </div>
    </div>
  );
}

export function TranscriptPanel(props: {
  transcript: Transcript;
  clips: readonly ResolvedClip[];
  clipIndex: number;
  edits: TranscriptEdits;
  minSubcutSec: number;
  config: StudioConfig;
  scenario: Scenario;
  captionMaxChars: number;
  /** Live playhead state from PreviewStage. */
  playbackState?: PlaybackState;
  /** Seeks the preview player to a specific Source Video timestamp. */
  onSeekSource?: (sourceSec: number) => void;
  /** A click on the preview's caption asked to edit a word's text. */
  focus: FocusRequest | null;
  /** "자막 글꼴·색상": opens the caption style fields. */
  onStyleCaption: () => void;
  dispatch: Dispatch<EditorAction>;
}) {
  const {transcript, clips, clipIndex, edits, playbackState, dispatch} = props;
  const [filterScope, setFilterScope] = useState<FilterScope>('all');
  const [query, setQuery] = useState('');
  const [quickStyleOpen, setQuickStyleOpen] = useState(false);
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const [editingLineIndex, setEditingLineIndex] = useState<number | null>(null);
  const [lineDraft, setLineDraft] = useState('');
  const [notice, setNotice] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => transcriptLines(transcript), [transcript]);

  const selectedClip = clips[clipIndex]?.clip;
  const isSourceClip = (selectedClip?.mediaKind ?? 'source') === 'source';

  // Map word.index -> tone ('selected' | 'scenario' | 'none') and clip number (0-based).
  const {tones, wordClips} = useMemo(() => {
    const toneMap = new Map<number, Tone>();
    const clipMap = new Map<number, number[]>();
    clips.forEach((resolved, position) => {
      for (const word of resolved.words) {
        const list = clipMap.get(word.index) ?? [];
        if (!list.includes(position)) {
          list.push(position);
          clipMap.set(word.index, list);
        }
        if (position === clipIndex) {
          toneMap.set(word.index, 'selected');
        } else if (toneMap.get(word.index) !== 'selected') {
          toneMap.set(word.index, 'scenario');
        }
      }
    });
    return {tones: toneMap, wordClips: clipMap};
  }, [clips, clipIndex]);

  // Identify the word and line currently under the live preview playhead.
  const {playingWordIndex, playingLineIndex} = useMemo(() => {
    const sourceSec = playbackState?.sourceSec ?? null;
    if (sourceSec === null || lines.length === 0) {
      return {playingWordIndex: null, playingLineIndex: null};
    }
    let matchedLineIdx: number | null = null;
    let matchedWordIdx: number | null = null;
    for (const line of lines) {
      if (sourceSec >= line.startSec - 0.08 && sourceSec <= line.endSec + 0.15) {
        matchedLineIdx = line.index;
        const exactWord = line.words.find(
          (w) => !w.isSoundTag && sourceSec >= w.startSec - 0.04 && sourceSec <= w.endSec + 0.06,
        );
        if (exactWord) {
          matchedWordIdx = exactWord.index;
        } else {
          const prevWord = line.words
            .filter((w) => !w.isSoundTag && w.startSec <= sourceSec)
            .at(-1);
          matchedWordIdx = (prevWord ?? line.words[0])?.index ?? null;
        }
        break;
      }
    }
    return {playingWordIndex: matchedWordIdx, playingLineIndex: matchedLineIdx};
  }, [playbackState?.sourceSec, lines]);

  const scrollToPlayingLine = () => {
    if (playingLineIndex === null) {
      return;
    }
    const container = scrollRef.current;
    const lineEl = container?.querySelector<HTMLElement>(
      `[data-line="${playingLineIndex}"]`,
    );
    if (container && lineEl) {
      container.scrollTo({
        top: Math.max(
          0,
          lineEl.offsetTop - container.clientHeight / 2 + lineEl.clientHeight / 2,
        ),
        behavior: 'smooth',
      });
    }
  };

  // Smoothly auto-scroll the active transcript line into view during playback,
  // unless the user is actively editing a word or line.
  const userIsEditing = activeWordIndex !== null || editingLineIndex !== null;
  useEffect(() => {
    if (playbackState?.playing && !userIsEditing) {
      scrollToPlayingLine();
    }
  }, [playbackState?.playing, playingLineIndex, userIsEditing]);

  const applyClipStart = (startSec: number) => {
    const min = props.minSubcutSec;
    if (!selectedClip || !isSourceClip) {
      setNotice('먼저 원본 영상 클립을 고르거나 추가해 주세요.');
      return;
    }
    const endSec = Math.max(selectedClip.endSec, startSec + min);
    dispatch({
      type: 'setClipRange',
      index: clipIndex,
      range: {startSec, endSec},
    });
  };

  const applyClipEnd = (endSec: number) => {
    const min = props.minSubcutSec;
    if (!selectedClip || !isSourceClip) {
      setNotice('먼저 원본 영상 클립을 고르거나 추가해 주세요.');
      return;
    }
    const startSec = Math.min(selectedClip.startSec, endSec - min);
    dispatch({
      type: 'setClipRange',
      index: clipIndex,
      range: {startSec: Math.max(0, startSec), endSec},
    });
  };

  const applySplitAt = (atSec: number) => {
    const min = props.minSubcutSec;
    if (!selectedClip || !isSourceClip) {
      setNotice('먼저 원본 영상 클립을 골라 주세요.');
      return;
    }
    const fits =
      atSec - selectedClip.startSec >= min && selectedClip.endSec - atSec >= min;
    if (fits) {
      dispatch({type: 'splitClip', index: clipIndex, atSec});
    } else {
      setNotice(
        `고른 클립 안쪽의 단어를 골라 주세요. 나눈 두 조각이 각각 ${formatSeconds(
          min,
        )} 이상이어야 해요.`,
      );
    }
  };

  const pick = (word: TranscriptWord) => {
    setNotice('');
    setActiveWordIndex((prev) => (prev === word.index ? null : word.index));
  };

  const latest = useRef({pick, clips, clipIndex});
  useLayoutEffect(() => {
    latest.current = {pick, clips, clipIndex};
  });
  const onPick = useCallback((word: TranscriptWord) => latest.current.pick(word), []);

  // Bring the selected Clip into view when the selection changes.
  const selectedId = clips[clipIndex]?.clip.clipId;
  useEffect(() => {
    const container = scrollRef.current;
    const first = latest.current.clips[latest.current.clipIndex]?.words[0];
    if (container && first) {
      scrollToWord(container, first.index);
    }
  }, [selectedId]);

  // A click on the preview's caption: show the word being spoken and open its edit.
  const {focus} = props;
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || focus?.target.kind !== 'caption') {
      return;
    }
    setNotice('');
    const {wordIndex} = focus.target;
    if (wordIndex === null) {
      setQuickStyleOpen(true);
      return;
    }
    setFilterScope('all');
    scrollToWord(container, wordIndex, true);
    setActiveWordIndex(wordIndex);
  }, [focus]);

  const filteredLines = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((line) => {
      if (filterScope === 'clip') {
        const inSelected = line.words.some((w) => tones.get(w.index) === 'selected');
        if (!inSelected) {
          return false;
        }
      }
      if (q) {
        return line.words.some((w) => {
          const shown = edits.wordText.get(w.index) ?? w.text;
          return (
            shown.toLowerCase().includes(q) || w.text.toLowerCase().includes(q)
          );
        });
      }
      return true;
    });
  }, [lines, filterScope, query, tones, edits.wordText]);

  const startLineEdit = (line: Line) => {
    const currentText = line.words
      .map((w) => edits.wordText.get(w.index) ?? w.text)
      .filter(Boolean)
      .join(' ');
    setEditingLineIndex(line.index);
    setLineDraft(currentText);
  };

  const saveLineEdit = (line: Line) => {
    dispatch({
      type: 'setLineWordsText',
      wordIndices: line.words.map((w) => w.index),
      text: lineDraft,
    });
    setEditingLineIndex(null);
  };

  const addLineAsClip = (line: Line) => {
    const min = props.minSubcutSec;
    const endSec = Math.max(line.endSec, line.startSec + Math.max(min, 1.5));
    dispatch({
      type: 'addClip',
      range: {startSec: line.startSec, endSec},
    });
  };

  return (
    <div className="space-y-3">
      {/* Scope filter + Search + Quick Caption Settings toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<FilterScope>
          label="대본 표시 범위"
          value={filterScope}
          options={[
            {value: 'all', label: `전체 대본 (${lines.length}줄)`},
            {value: 'clip', label: '현재 클립만'},
          ]}
          onChange={setFilterScope}
        />
        <div className="relative min-w-[140px] flex-1">
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="대사 검색..."
            aria-label="대사 검색"
            className={`${TEXT_FIELD} h-9 w-full ps-8 pe-2 text-xs`}
          />
        </div>
        <Button
          variant={quickStyleOpen ? 'tonal' : 'text'}
          size="sm"
          icon="tune"
          onClick={() => setQuickStyleOpen((open) => !open)}
        >
          자막 설정
        </Button>
      </div>

      {/* Live playhead status bar */}
      {playbackState && playbackState.sourceSec !== null && (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-primary-container/35 px-3 py-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium text-on-surface tabular-nums">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                playbackState.playing ? 'animate-pulse bg-primary' : 'bg-outline'
              }`}
            />
            {playbackState.playing ? '미리보기 재생 중' : '미리보기 위치'} · 원본{' '}
            <strong>{formatClock(playbackState.sourceSec)}</strong>
          </span>
          {playingLineIndex !== null && (
            <button
              type="button"
              onClick={scrollToPlayingLine}
              className="font-medium text-primary hover:underline"
            >
              현재 재생 줄로 이동
            </button>
          )}
        </div>
      )}

      {quickStyleOpen && (
        <QuickCaptionControls
          config={props.config}
          scenario={props.scenario}
          clipIndex={clipIndex}
          captionMaxChars={props.captionMaxChars}
          onOpenFullStyle={props.onStyleCaption}
          dispatch={dispatch}
        />
      )}

      {notice && <p className="text-xs text-error">{notice}</p>}

      {lines.length === 0 ? (
        <p className="rounded-2xl bg-surface p-4 text-center text-xs text-on-surface-variant">
          추출된 대본이 없어요.
        </p>
      ) : filteredLines.length === 0 ? (
        <p className="rounded-2xl bg-surface p-4 text-center text-xs text-on-surface-variant">
          조건에 맞는 대사가 없어요.{' '}
          {filterScope === 'clip' && (
            <button
              type="button"
              onClick={() => setFilterScope('all')}
              className="font-medium text-primary underline"
            >
              전체 대본 보기
            </button>
          )}
        </p>
      ) : (
        <div
          ref={scrollRef}
          className="relative max-h-[62vh] space-y-1.5 overflow-y-auto pe-1 text-sm leading-7"
        >
          {filteredLines.map((line) => {
            const firstWord = line.words[0];
            const lastWord = line.words[line.words.length - 1];
            const lineClipIndices = Array.from(
              new Set(line.words.flatMap((w) => wordClips.get(w.index) ?? [])),
            ).sort((a, b) => a - b);
            const activeWordInLine =
              activeWordIndex !== null
                ? line.words.find((w) => w.index === activeWordIndex)
                : undefined;
            const isEditingLine = editingLineIndex === line.index;
            const isPlayingLine = playingLineIndex === line.index;

            return (
              <div
                key={firstWord.index}
                data-line={line.index}
                className={`group rounded-xl px-2 py-1.5 transition-colors ${
                  isPlayingLine
                    ? 'border-s-4 border-primary bg-primary-container/25 shadow-2xs'
                    : 'hover:bg-surface-container-low'
                }`}
              >
                <div className="flex items-start gap-2">
                  {/* Timestamp + Playing Badge + Clip Badges */}
                  <div className="flex w-18 shrink-0 flex-col items-start gap-0.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => props.onSeekSource?.(line.startSec)}
                      title="이 위치로 미리보기 이동"
                      className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] tabular-nums transition-colors ${
                        isPlayingLine
                          ? 'bg-primary font-semibold text-on-primary'
                          : 'text-on-surface-variant/80 hover:bg-surface-container-highest hover:text-primary'
                      }`}
                    >
                      <Icon name="play_arrow" size={12} filled={isPlayingLine} />
                      {formatClock(line.startSec)}
                    </button>
                    {isPlayingLine && (
                      <span className="rounded bg-primary/15 px-1 text-[10px] leading-4 font-semibold text-primary">
                        재생 중
                      </span>
                    )}
                    {lineClipIndices.length > 0 && (
                      <div className="flex flex-wrap gap-0.5">
                        {lineClipIndices.map((idx) => {
                          const isCurrent = idx === clipIndex;
                          return (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => dispatch({type: 'selectClip', index: idx})}
                              className={`rounded px-1 py-0 text-[10px] leading-4 font-semibold ${
                                isCurrent
                                  ? 'bg-primary text-on-primary'
                                  : 'bg-surface-container-highest text-on-surface-variant'
                              }`}
                              title={`클립 ${idx + 1} 선택`}
                            >
                              클립 {idx + 1}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Words or Line-Edit Input */}
                  <div className="min-w-0 flex-1">
                    {isEditingLine ? (
                      <div className="flex flex-wrap items-center gap-1.5 py-0.5">
                        <input
                          value={lineDraft}
                          onChange={(event) => setLineDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              saveLineEdit(line);
                            } else if (event.key === 'Escape') {
                              setEditingLineIndex(null);
                            }
                          }}
                          className={`${TEXT_FIELD} h-8 min-w-[180px] flex-1 text-xs`}
                        />
                        <Button
                          variant="tonal"
                          size="sm"
                          onClick={() => saveLineEdit(line)}
                        >
                          저장
                        </Button>
                        <Button
                          variant="text"
                          size="sm"
                          onClick={() => setEditingLineIndex(null)}
                        >
                          취소
                        </Button>
                      </div>
                    ) : (
                      <span className="inline">
                        {line.words.map((word) => (
                          <WordItem
                            key={word.index}
                            word={word}
                            override={edits.wordText.get(word.index)}
                            tone={tones.get(word.index) ?? 'none'}
                            cut={edits.cutWords.has(word.index)}
                            active={activeWordInLine?.index === word.index}
                            playing={playingWordIndex === word.index}
                            onPick={onPick}
                          />
                        ))}
                      </span>
                    )}
                  </div>

                  {/* Line-level Quick Actions */}
                  {!isEditingLine && (
                    <div className="flex shrink-0 items-center gap-0.5 pt-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                      {isSourceClip && (
                        <>
                          <button
                            type="button"
                            onClick={() => applyClipStart(firstWord.startSec)}
                            title="이 줄부터 클립 시작"
                            className="rounded px-1.5 py-0.5 text-[11px] text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
                          >
                            시작
                          </button>
                          <button
                            type="button"
                            onClick={() => applyClipEnd(lastWord.endSec)}
                            title="이 줄까지 클립 끝"
                            className="rounded px-1.5 py-0.5 text-[11px] text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
                          >
                            끝
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => addLineAsClip(line)}
                        title="이 줄을 새 클립으로 추가"
                        className="rounded px-1.5 py-0.5 text-[11px] text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
                      >
                        +클립
                      </button>
                      <button
                        type="button"
                        onClick={() => startLineEdit(line)}
                        title="한 줄 통째로 자막 수정"
                        className="rounded px-1.5 py-0.5 text-[11px] text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
                      >
                        줄 수정
                      </button>
                    </div>
                  )}
                </div>

                {/* Direct Word Action Bar */}
                {activeWordInLine && (
                  <DirectWordBar
                    word={activeWordInLine}
                    override={edits.wordText.get(activeWordInLine.index)}
                    cut={edits.cutWords.has(activeWordInLine.index)}
                    canSetRange={isSourceClip}
                    onSaveText={(text) => {
                      dispatch({
                        type: 'setWordText',
                        index: activeWordInLine.index,
                        text,
                      });
                    }}
                    onToggleCut={() =>
                      dispatch({type: 'toggleCutWord', index: activeWordInLine.index})
                    }
                    onSetStart={() => applyClipStart(activeWordInLine.startSec)}
                    onSetEnd={() => applyClipEnd(activeWordInLine.endSec)}
                    onSplit={() => applySplitAt(activeWordInLine.startSec)}
                    onClose={() => setActiveWordIndex(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
