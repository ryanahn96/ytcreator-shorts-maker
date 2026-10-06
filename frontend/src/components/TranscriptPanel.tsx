/**
 * The whole transcript as clickable Transcript Words. The pick mode decides
 * what a click does: move the selected Clip's start or end, split it, cut
 * the word from audio and captions, or edit its caption text.
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
import {formatClock, formatSeconds} from '../lib/format';
import type {ResolvedClip, Transcript, TranscriptEdits} from '../lib/timeline';
import type {TranscriptWord} from '../types';
import {Panel} from './ui';

type PickMode = 'start' | 'end' | 'split' | 'cut' | 'text';
type Tone = 'selected' | 'scenario' | 'none';

const MODES: readonly {mode: PickMode; label: string; hint: string}[] = [
  {
    mode: 'start',
    label: '시작점',
    hint: '단어를 누르면 선택한 Clip이 그 단어에서 시작합니다.',
  },
  {
    mode: 'end',
    label: '끝점',
    hint: '단어를 누르면 선택한 Clip이 그 단어까지 이어집니다.',
  },
  {
    mode: 'split',
    label: '나누기',
    hint: '선택한 Clip 안의 단어를 누르면 그 단어 앞에서 Clip을 둘로 나눕니다.',
  },
  {
    mode: 'cut',
    label: '단어 삭제',
    hint:
      '단어를 누르면 음성과 자막에서 빠지고, 다시 누르면 돌아옵니다. ' +
      'Gemini가 군말로 표시한 단어는 처음부터 삭제되어 있습니다.',
  },
  {
    mode: 'text',
    label: '자막 수정',
    hint:
      '단어를 누르면 자막 글자를 고칠 수 있습니다. 비우면 자막에서만 ' +
      '숨기고 음성은 그대로 둡니다. 모든 시나리오에 함께 적용됩니다.',
  },
];

const TONE_CLASS: Record<Tone, string> = {
  selected: 'bg-indigo-500/30 text-white',
  scenario: 'bg-zinc-700/60 text-zinc-100',
  none: 'text-zinc-400 hover:text-zinc-100',
};

interface Line {
  startSec: number;
  words: TranscriptWord[];
}

function transcriptLines(transcript: Transcript): Line[] {
  const lines: Line[] = [];
  for (const word of transcript.words) {
    const last = lines.at(-1);
    if (!last || transcript.lineStarts.has(word.index)) {
      lines.push({startSec: word.startSec, words: [word]});
    } else {
      last.words.push(word);
    }
  }
  return lines;
}

function WordInput(props: {
  word: TranscriptWord;
  initial: string;
  onDone: (word: TranscriptWord, text: string | undefined) => void;
}) {
  const [text, setText] = useState(props.initial);
  const done = useRef(false);
  // `undefined` cancels the edit.
  const finish = (value: string | undefined) => {
    if (!done.current) {
      done.current = true;
      props.onDone(props.word, value);
    }
  };
  return (
    <input
      autoFocus
      value={text}
      size={Math.max(2, text.length + 1)}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(text)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          finish(text);
        } else if (event.key === 'Escape') {
          finish(undefined);
        }
      }}
      className="mx-0.5 rounded border border-amber-300 bg-zinc-950 px-1 text-zinc-100"
    />
  );
}

const WordItem = memo(function WordItem(props: {
  word: TranscriptWord;
  override: string | undefined;
  tone: Tone;
  cut: boolean;
  editing: boolean;
  onPick: (word: TranscriptWord) => void;
  onEditDone: (word: TranscriptWord, text: string | undefined) => void;
}) {
  const {word, override} = props;
  if (props.editing) {
    return (
      <WordInput word={word} initial={override ?? word.text} onDone={props.onEditDone} />
    );
  }
  const hidden = override === '';
  const edited = override !== undefined && !hidden;
  const styles = [
    'rounded px-0.5',
    TONE_CLASS[props.tone],
    word.isSoundTag ? 'italic text-zinc-500' : '',
    props.cut ? 'line-through decoration-red-400 text-red-300/80' : '',
    edited ? 'underline decoration-amber-300 decoration-dotted' : '',
    hidden ? 'line-through decoration-zinc-500 opacity-50' : '',
  ];
  const notes = [
    formatClock(word.startSec),
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

export function TranscriptPanel(props: {
  transcript: Transcript;
  clips: readonly ResolvedClip[];
  clipIndex: number;
  edits: TranscriptEdits;
  minSubcutSec: number;
  dispatch: Dispatch<EditorAction>;
}) {
  const {transcript, clips, clipIndex, edits, dispatch} = props;
  const [mode, setMode] = useState<PickMode>('start');
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => transcriptLines(transcript), [transcript]);

  const tones = useMemo(() => {
    const map = new Map<number, Tone>();
    clips.forEach((resolved, position) => {
      for (const word of resolved.words) {
        if (position === clipIndex) {
          map.set(word.index, 'selected');
        } else if (map.get(word.index) !== 'selected') {
          map.set(word.index, 'scenario');
        }
      }
    });
    return map;
  }, [clips, clipIndex]);

  const pick = (word: TranscriptWord) => {
    const min = props.minSubcutSec;
    const clip = clips[clipIndex]?.clip;
    setNotice('');
    if (mode === 'cut') {
      dispatch({type: 'toggleCutWord', index: word.index});
      return;
    }
    if (mode === 'text') {
      setEditing(word.index);
      return;
    }
    if (!clip) {
      setNotice('먼저 Clip을 선택하거나 추가하세요.');
      return;
    }
    if (mode === 'split') {
      const fits =
        word.startSec - clip.startSec >= min && clip.endSec - word.startSec >= min;
      if (fits) {
        dispatch({type: 'splitClip', index: clipIndex, atSec: word.startSec});
      } else {
        setNotice(
          `선택한 Clip 안쪽의 단어를 고르세요. 나눈 두 조각이 각각 ${formatSeconds(
            min,
          )} 이상이어야 합니다.`,
        );
      }
      return;
    }
    const range =
      mode === 'start'
        ? {startSec: word.startSec, endSec: clip.endSec}
        : {startSec: clip.startSec, endSec: word.endSec};
    if (range.endSec - range.startSec < min) {
      setNotice(
        mode === 'start'
          ? '시작점은 선택한 Clip의 끝점보다 앞에 있어야 합니다.'
          : '끝점은 선택한 Clip의 시작점보다 뒤에 있어야 합니다.',
      );
      return;
    }
    dispatch({type: 'setClipRange', index: clipIndex, range});
  };

  // WordItems are memoized, so they get one stable callback that always
  // runs the latest `pick`.
  const latest = useRef({pick, clips, clipIndex});
  useLayoutEffect(() => {
    latest.current = {pick, clips, clipIndex};
  });
  const onPick = useCallback((word: TranscriptWord) => latest.current.pick(word), []);
  const onEditDone = useCallback(
    (word: TranscriptWord, text: string | undefined) => {
      setEditing(null);
      if (text !== undefined) {
        const trimmed = text.trim();
        dispatch({
          type: 'setWordText',
          index: word.index,
          text: trimmed === word.text ? null : trimmed,
        });
      }
    },
    [dispatch],
  );

  // Bring the selected Clip into view when the selection changes.
  const selectedId = clips[clipIndex]?.clip.clipId;
  useEffect(() => {
    const container = scrollRef.current;
    const first = latest.current.clips[latest.current.clipIndex]?.words[0];
    if (!container || !first) {
      return;
    }
    const element = container.querySelector<HTMLElement>(
      `[data-word="${first.index}"]`,
    );
    if (element) {
      container.scrollTo({
        top: element.offsetTop - container.clientHeight / 3,
        behavior: 'smooth',
      });
    }
  }, [selectedId]);

  const active = MODES.find((item) => item.mode === mode);
  return (
    <Panel title={`자막 단어 ${transcript.words.length}개`}>
      <div className="mb-2 flex flex-wrap gap-1" role="radiogroup" aria-label="클릭 동작">
        {MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            role="radio"
            aria-checked={item.mode === mode}
            onClick={() => {
              setMode(item.mode);
              setNotice('');
            }}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
              item.mode === mode
                ? 'bg-indigo-600 text-white'
                : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="mb-1 text-[11px] text-zinc-400">{active?.hint}</p>
      <p className="mb-2 flex flex-wrap gap-3 text-[11px] text-zinc-500">
        <span className="rounded bg-indigo-500/30 px-1 text-white">선택한 Clip</span>
        <span className="rounded bg-zinc-700/60 px-1 text-zinc-100">다른 Clip</span>
        <span className="text-red-300/80 line-through decoration-red-400">삭제</span>
        <span className="underline decoration-amber-300 decoration-dotted">수정</span>
      </p>
      {notice && <p className="mb-2 text-xs text-amber-300">{notice}</p>}
      <div
        ref={scrollRef}
        className="relative max-h-[60vh] space-y-1 overflow-y-auto pr-1 text-sm leading-7"
      >
        {lines.map((line) => (
          <p key={line.words[0].index} className="flex gap-2">
            <span className="w-14 shrink-0 pt-0.5 font-mono text-[10px] text-zinc-600">
              {formatClock(line.startSec)}
            </span>
            <span className="min-w-0">
              {line.words.map((word) => (
                <WordItem
                  key={word.index}
                  word={word}
                  override={edits.wordText.get(word.index)}
                  tone={tones.get(word.index) ?? 'none'}
                  cut={edits.cutWords.has(word.index)}
                  editing={editing === word.index}
                  onPick={onPick}
                  onEditDone={onEditDone}
                />
              ))}
            </span>
          </p>
        ))}
      </div>
    </Panel>
  );
}
