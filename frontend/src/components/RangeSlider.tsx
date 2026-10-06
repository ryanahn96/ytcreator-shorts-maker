/**
 * A two-handle range slider over a time window. Dragging reports drafts and
 * releasing commits. Pointer events live on the track, so a press anywhere
 * grabs the nearest handle. Handles are keyboard sliders that commit on
 * every arrow press.
 */

import {
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';

import {formatClock} from '../lib/format';
import type {TimeRange} from '../types';

export type RangeHandle = 'start' | 'end';

interface Drag {
  handle: RangeHandle;
  origin: TimeRange;
  range: TimeRange;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function isHandle(value: string | undefined): value is RangeHandle {
  return value === 'start' || value === 'end';
}

function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function keyDelta(event: KeyboardEvent, step: number): number {
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return -step;
    case 'ArrowRight':
    case 'ArrowUp':
      return step;
    default:
      return 0;
  }
}

function Thumb(props: {
  handle: RangeHandle;
  value: number;
  bounds: TimeRange;
  left: string;
  thumbRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const label = props.handle === 'start' ? '시작점' : '끝점';
  return (
    <div
      ref={props.thumbRef}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={props.bounds.startSec}
      aria-valuemax={props.bounds.endSec}
      aria-valuenow={props.value}
      aria-valuetext={formatClock(props.value)}
      data-handle={props.handle}
      onKeyDown={props.onKeyDown}
      className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-indigo-400 outline-offset-2 focus-visible:outline-2 focus-visible:outline-white"
      style={{left: props.left}}
    />
  );
}

export function RangeSlider(props: {
  /** The visible window; keep it fixed while a drag is in progress. */
  bounds: TimeRange;
  range: TimeRange;
  minGapSec: number;
  /** Word starts, drawn as ticks. */
  ticks: readonly number[];
  /** Pieces of `range` that are played. */
  kept: readonly TimeRange[];
  stepSec: number;
  largeStepSec: number;
  /** A drag in progress, or null when it ends without a commit. */
  onDraft: (range: TimeRange | null) => void;
  /** `snap` names the dragged handle, or is null for exact values. */
  onCommit: (range: TimeRange, snap: RangeHandle | null) => void;
}) {
  const {bounds, range, minGapSec} = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const span = Math.max(bounds.endSec - bounds.startSec, Number.EPSILON);
  const percent = (seconds: number) =>
    `${(clamp((seconds - bounds.startSec) / span, 0, 1)) * 100}%`;
  const widthPercent = (piece: TimeRange) =>
    `${(clamp((piece.endSec - piece.startSec) / span, 0, 1)) * 100}%`;

  const moved = (
    current: TimeRange,
    handle: RangeHandle,
    seconds: number,
  ): TimeRange =>
    handle === 'start'
      ? {
          startSec: clamp(seconds, bounds.startSec, current.endSec - minGapSec),
          endSec: current.endSec,
        }
      : {
          startSec: current.startSec,
          endSec: clamp(seconds, current.startSec + minGapSec, bounds.endSec),
        };

  const secondsAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      return bounds.startSec;
    }
    return bounds.startSec + clamp((clientX - rect.left) / rect.width, 0, 1) * span;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const seconds = secondsAt(event.clientX);
    const target =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-handle]')
        : null;
    const named = target?.dataset['handle'];
    const nearest: RangeHandle =
      Math.abs(seconds - range.startSec) <= Math.abs(seconds - range.endSec)
        ? 'start'
        : 'end';
    const handle = isHandle(named) ? named : nearest;
    event.currentTarget.setPointerCapture(event.pointerId);
    (handle === 'start' ? startRef : endRef).current?.focus();
    const next = isHandle(named) ? range : moved(range, handle, seconds);
    drag.current = {handle, origin: range, range: next};
    if (next !== range) {
      props.onDraft(next);
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) {
      return;
    }
    current.range = moved(current.range, current.handle, secondsAt(event.clientX));
    props.onDraft(current.range);
  };

  const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = drag.current;
    if (!current) {
      return;
    }
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const changed =
      current.range.startSec !== current.origin.startSec ||
      current.range.endSec !== current.origin.endSec;
    if (commit && changed) {
      // Alt keeps the exact position instead of snapping to a word.
      props.onCommit(current.range, event.altKey ? null : current.handle);
    } else {
      props.onDraft(null);
    }
  };

  const onKeyDown =
    (handle: RangeHandle) => (event: KeyboardEvent<HTMLDivElement>) => {
      const delta = keyDelta(
        event,
        event.shiftKey ? props.largeStepSec : props.stepSec,
      );
      if (delta === 0) {
        return;
      }
      event.preventDefault();
      const value = handle === 'start' ? range.startSec : range.endSec;
      props.onCommit(moved(range, handle, roundMs(value + delta)), null);
    };

  return (
    <div className="select-none">
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)}
        className="relative h-11 cursor-pointer touch-none rounded-md bg-zinc-800"
      >
        {props.ticks.map((seconds, index) => (
          <span
            key={index}
            className="pointer-events-none absolute top-0 h-2 w-px bg-zinc-600"
            style={{left: percent(seconds)}}
          />
        ))}
        <div
          className="pointer-events-none absolute inset-y-2 border-y border-indigo-400/60 bg-indigo-500/20"
          style={{left: percent(range.startSec), width: widthPercent(range)}}
        />
        {props.kept.map((piece, index) => (
          <div
            key={index}
            className="pointer-events-none absolute bottom-2 h-1.5 bg-emerald-400"
            style={{left: percent(piece.startSec), width: widthPercent(piece)}}
          />
        ))}
        <Thumb
          handle="start"
          value={range.startSec}
          bounds={bounds}
          left={percent(range.startSec)}
          thumbRef={startRef}
          onKeyDown={onKeyDown('start')}
        />
        <Thumb
          handle="end"
          value={range.endSec}
          bounds={bounds}
          left={percent(range.endSec)}
          thumbRef={endRef}
          onKeyDown={onKeyDown('end')}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-500">
        <span>{formatClock(bounds.startSec)}</span>
        <span>{formatClock(bounds.endSec)}</span>
      </div>
    </div>
  );
}
