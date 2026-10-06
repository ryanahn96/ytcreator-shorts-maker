/**
 * The Clips of the selected Scenario. The selected Clip opens a range
 * editor: drag handles, nudge buttons and exact numbers.
 */

import {ArrowDown, ArrowUp, Plus, Scissors, Trash2} from 'lucide-react';
import {useMemo, useState, type Dispatch, type ReactNode} from 'react';

import type {EditorAction} from '../lib/editor';
import {formatClock, formatSeconds} from '../lib/format';
import {
  firstWordAtOrAfter,
  snapToWord,
  totalSec,
  wordsStartingIn,
  type ResolvedClip,
  type Transcript,
} from '../lib/timeline';
import type {Clip, CompositionSettings, TimeRange} from '../types';
import {RangeSlider, type RangeHandle} from './RangeSlider';
import {IconButton, NumberField, Panel, TextButton} from './ui';

function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** The word start nearest the Clip's middle that leaves both halves valid. */
function splitPoint(resolved: ResolvedClip, minSec: number): number | null {
  const {clip, words} = resolved;
  const middle = (clip.startSec + clip.endSec) / 2;
  const fits = (seconds: number) =>
    seconds - clip.startSec >= minSec && clip.endSec - seconds >= minSec;
  let best: number | null = null;
  for (const word of words) {
    const closer =
      best === null ||
      Math.abs(word.startSec - middle) < Math.abs(best - middle);
    if (fits(word.startSec) && closer) {
      best = word.startSec;
    }
  }
  return best ?? (fits(middle) ? middle : null);
}

/** A newClipSec-long range starting at the first word after `after`. */
function proposeNewClip(
  transcript: Transcript,
  after: Clip | undefined,
  settings: CompositionSettings,
  durationSec: number,
): TimeRange | null {
  const words = transcript.words;
  const fromSec = after?.endSec ?? 0;
  const next = words[firstWordAtOrAfter(words, fromSec)];
  const startSec = next ? next.startSec : fromSec;
  const targetSec = startSec + settings.newClipSec;
  const nearby = wordsStartingIn(words, {
    startSec,
    endSec: targetSec + settings.editWindowPadSec,
  });
  const snapped = snapToWord(nearby, targetSec, 'end');
  const endSec = Math.min(
    durationSec,
    snapped - startSec >= settings.minSubcutSec ? snapped : targetSec,
  );
  return endSec - startSec >= settings.minSubcutSec
    ? {startSec: roundMs(startSec), endSec: roundMs(endSec)}
    : null;
}

function EdgeControl(props: {
  label: string;
  value: number;
  steps: readonly number[];
  onCommit: (value: number) => void;
}) {
  const deltas = [...props.steps.map((step) => -step).reverse(), ...props.steps];
  return (
    <div className="space-y-1">
      <NumberField
        label={`${props.label} ${formatClock(props.value)}`}
        value={props.value}
        step={props.steps[0] ?? 0.1}
        min={0}
        digits={2}
        suffix="초"
        onCommit={(value) => props.onCommit(roundMs(value))}
      />
      <div className="flex gap-1">
        {deltas.map((delta) => (
          <button
            key={delta}
            type="button"
            onClick={() => props.onCommit(roundMs(props.value + delta))}
            className="flex-1 rounded border border-zinc-700 px-1 py-0.5 font-mono text-[11px] text-zinc-300 hover:bg-zinc-800"
          >
            {delta > 0 ? '+' : '−'}
            {Math.abs(delta)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ClipRangeEditor(props: {
  resolved: ResolvedClip;
  index: number;
  transcript: Transcript;
  settings: CompositionSettings;
  sourceDurationSec: number;
  subcutsFor: (range: TimeRange) => TimeRange[];
  dispatch: Dispatch<EditorAction>;
}) {
  const {resolved, index, settings, dispatch} = props;
  const {clip} = resolved;
  const [draft, setDraft] = useState<TimeRange | null>(null);
  const shown = draft ?? clip;
  // The window follows the committed range only, so it holds still while a
  // handle is being dragged.
  const windowStart = Math.max(0, clip.startSec - settings.editWindowPadSec);
  const windowEnd = Math.min(
    props.sourceDurationSec,
    clip.endSec + settings.editWindowPadSec,
  );
  const windowWords = useMemo(
    () =>
      wordsStartingIn(props.transcript.words, {
        startSec: windowStart,
        endSec: windowEnd,
      }),
    [props.transcript, windowStart, windowEnd],
  );
  const kept = draft ? props.subcutsFor(draft) : resolved.subcuts;
  const steps = settings.nudgeStepsSec;

  const commit = (range: TimeRange, snap: RangeHandle | null) => {
    setDraft(null);
    let snapped = range;
    if (snap === 'start') {
      snapped = {...range, startSec: snapToWord(windowWords, range.startSec, 'start')};
    } else if (snap === 'end') {
      snapped = {...range, endSec: snapToWord(windowWords, range.endSec, 'end')};
    }
    const valid =
      snapped.endSec - snapped.startSec >= settings.minSubcutSec ? snapped : range;
    dispatch({
      type: 'setClipRange',
      index,
      range: {startSec: roundMs(valid.startSec), endSec: roundMs(valid.endSec)},
    });
  };

  return (
    <div className="space-y-3 border-t border-zinc-800 px-3 pb-3 pt-3">
      <RangeSlider
        bounds={{startSec: windowStart, endSec: windowEnd}}
        range={shown}
        minGapSec={settings.minSubcutSec}
        ticks={windowWords.map((word) => word.startSec)}
        kept={kept}
        stepSec={steps[0] ?? 0.1}
        largeStepSec={steps.at(-1) ?? 0.5}
        onDraft={setDraft}
        onCommit={commit}
      />
      <p className="text-[11px] text-zinc-400">
        원본 {formatSeconds(shown.endSec - shown.startSec)} → 재생{' '}
        {formatSeconds(totalSec(kept))} (초록색이 실제로 재생되는 Subcut). 핸들을
        놓으면 가장 가까운 단어 경계에 맞춰지고, Alt를 누른 채 놓으면 그 자리에
        둡니다. 핸들을 선택한 뒤 방향키로 {steps[0]}초, Shift+방향키로{' '}
        {steps.at(-1)}초씩 움직입니다.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <EdgeControl
          label="시작"
          value={clip.startSec}
          steps={steps}
          onCommit={(startSec) => commit({startSec, endSec: clip.endSec}, null)}
        />
        <EdgeControl
          label="끝"
          value={clip.endSec}
          steps={steps}
          onCommit={(endSec) => commit({startSec: clip.startSec, endSec}, null)}
        />
      </div>
    </div>
  );
}

function ClipCard(props: {
  resolved: ResolvedClip;
  position: number;
  count: number;
  selected: boolean;
  minSubcutSec: number;
  dispatch: Dispatch<EditorAction>;
  children?: ReactNode;
}) {
  const {resolved, position, dispatch} = props;
  const {clip, subcuts, keptSec, planIndex, words} = resolved;
  const splitAt = splitPoint(resolved, props.minSubcutSec);
  const details = [clip.speaker, clip.purpose].filter((text) => text.trim());
  return (
    <li
      className={`rounded-xl border ${
        props.selected ? 'border-indigo-500 bg-indigo-500/5' : 'border-zinc-800'
      }`}
    >
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => dispatch({type: 'selectClip', index: position})}
          className="min-w-0 flex-1 space-y-1 px-3 py-2 text-left"
        >
          <span className="block font-mono text-xs text-zinc-200">
            #{position + 1} {formatClock(clip.startSec)} – {formatClock(clip.endSec)}
            {clip.look && (
              <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 font-sans text-[10px] text-sky-300">
                전용 스타일
              </span>
            )}
          </span>
          <span className="block text-[11px] text-zinc-400">
            원본 {formatSeconds(clip.endSec - clip.startSec)} → 재생{' '}
            {formatSeconds(keptSec)} · Subcut {subcuts.length}개
          </span>
          {details.length > 0 && (
            <span className="block text-[11px] text-zinc-500">
              {details.join(' · ')}
            </span>
          )}
          <span className="line-clamp-2 block text-xs text-zinc-300">
            {words.length > 0
              ? words.map((word) => word.text).join(' ')
              : '(이 구간에 자막 단어가 없습니다)'}
          </span>
          {planIndex === null && (
            <span className="block text-[11px] text-amber-300">
              무음과 삭제한 단어를 빼면 남는 구간이 없어 렌더에서 빠집니다.
            </span>
          )}
        </button>
        <div className="flex flex-col py-1 pr-1">
          <IconButton
            label="위로"
            disabled={position === 0}
            onClick={() => dispatch({type: 'moveClip', index: position, offset: -1})}
          >
            <ArrowUp size={14} />
          </IconButton>
          <IconButton
            label="아래로"
            disabled={position === props.count - 1}
            onClick={() => dispatch({type: 'moveClip', index: position, offset: 1})}
          >
            <ArrowDown size={14} />
          </IconButton>
          <IconButton
            label="가운데 단어에서 나누기"
            disabled={splitAt === null}
            onClick={() =>
              splitAt !== null &&
              dispatch({type: 'splitClip', index: position, atSec: splitAt})
            }
          >
            <Scissors size={14} />
          </IconButton>
          <IconButton
            label="삭제"
            onClick={() => dispatch({type: 'deleteClip', index: position})}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>
      {props.children}
    </li>
  );
}

export function ClipEditor(props: {
  clips: readonly ResolvedClip[];
  clipIndex: number;
  transcript: Transcript;
  settings: CompositionSettings;
  sourceDurationSec: number;
  subcutsFor: (range: TimeRange) => TimeRange[];
  dispatch: Dispatch<EditorAction>;
}) {
  const {clips, clipIndex, settings, dispatch} = props;
  const proposal = proposeNewClip(
    props.transcript,
    clips[clipIndex]?.clip,
    settings,
    props.sourceDurationSec,
  );
  return (
    <Panel
      title={`Clip ${clips.length}개`}
      actions={
        <TextButton
          disabled={proposal === null}
          onClick={() => proposal && dispatch({type: 'addClip', range: proposal})}
        >
          <Plus size={14} />
          Clip 추가
        </TextButton>
      }
    >
      {clips.length === 0 ? (
        <p className="text-xs text-zinc-400">
          Clip이 없습니다. "Clip 추가"를 누르거나 시나리오를 초기화하세요.
        </p>
      ) : (
        <ol className="space-y-2">
          {clips.map((resolved, position) => (
            <ClipCard
              key={resolved.clip.clipId}
              resolved={resolved}
              position={position}
              count={clips.length}
              selected={position === clipIndex}
              minSubcutSec={settings.minSubcutSec}
              dispatch={dispatch}
            >
              {position === clipIndex && (
                <ClipRangeEditor
                  resolved={resolved}
                  index={position}
                  transcript={props.transcript}
                  settings={settings}
                  sourceDurationSec={props.sourceDurationSec}
                  subcutsFor={props.subcutsFor}
                  dispatch={dispatch}
                />
              )}
            </ClipCard>
          ))}
        </ol>
      )}
    </Panel>
  );
}
