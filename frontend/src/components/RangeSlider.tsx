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
import type {
  TimeRange,
  YouTubeRetentionPeak,
  YouTubeRetentionPoint,
} from '../types';

export type RangeHandle = 'start' | 'end' | 'move';

interface Drag {
  handle: RangeHandle;
  origin: TimeRange;
  grabSec: number;
  range: TimeRange;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function isHandle(value: string | undefined): value is RangeHandle {
  return value === 'start' || value === 'end' || value === 'move';
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

function RetentionOverlay(props: {
  points: readonly YouTubeRetentionPoint[];
  peaks?: readonly YouTubeRetentionPeak[];
  lows?: readonly YouTubeRetentionPeak[];
  bounds: TimeRange;
  sourceDurationSec: number;
}) {
  const {points, peaks = [], lows = [], bounds, sourceDurationSec} = props;
  if (points.length < 2 || sourceDurationSec <= 0) {
    return null;
  }
  const span = Math.max(bounds.endSec - bounds.startSec, Number.EPSILON);
  const maxWatch = Math.max(1, ...points.map((p) => p.watchRatio));
  const coords = points.map((p) => {
    const sec = p.elapsedRatio * sourceDurationSec;
    const x = ((sec - bounds.startSec) / span) * 100;
    const y = (1 - clamp(p.watchRatio / maxWatch, 0, 1)) * 36 + 4;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const linePath = `M ${coords.join(' L ')}`;
  return (
    <svg
      viewBox="0 0 100 44"
      preserveAspectRatio="none"
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full overflow-hidden rounded-xl"
    >
      {peaks.map((peak, idx) => {
        const x1 = clamp(((peak.startSec - bounds.startSec) / span) * 100, 0, 100);
        const x2 = clamp(((peak.endSec - bounds.startSec) / span) * 100, 0, 100);
        if (x2 <= x1) {
          return null;
        }
        return (
          <rect
            key={`peak-${idx}`}
            x={x1}
            y={0}
            width={x2 - x1}
            height={44}
            className="fill-primary/15"
          />
        );
      })}
      {lows.map((low, idx) => {
        const x1 = clamp(((low.startSec - bounds.startSec) / span) * 100, 0, 100);
        const x2 = clamp(((low.endSec - bounds.startSec) / span) * 100, 0, 100);
        if (x2 <= x1) {
          return null;
        }
        return (
          <rect
            key={`low-${idx}`}
            x={x1}
            y={0}
            width={x2 - x1}
            height={44}
            className="fill-error/15"
          />
        );
      })}
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        className="text-primary/50"
      />
    </svg>
  );
}

function Thumb(props: {
  handle: 'start' | 'end';
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
      className="absolute inset-y-0 z-10 w-2.5 -translate-x-1/2 cursor-ew-resize rounded-full bg-primary outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
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
  /** Optional YouTube Audience Retention points (0..1) to overlay on the track. */
  retentionPoints?: readonly YouTubeRetentionPoint[];
  retentionPeaks?: readonly YouTubeRetentionPeak[];
  retentionLows?: readonly YouTubeRetentionPeak[];
  sourceDurationSec?: number;
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
    `${clamp((seconds - bounds.startSec) / span, 0, 1) * 100}%`;
  const widthPercent = (piece: TimeRange) =>
    `${clamp((piece.endSec - piece.startSec) / span, 0, 1) * 100}%`;

  const moved = (
    origin: TimeRange,
    handle: RangeHandle,
    seconds: number,
    grabSec = seconds,
  ): TimeRange => {
    if (handle === 'move') {
      const duration = Math.max(minGapSec, origin.endSec - origin.startSec);
      const maxStart = Math.max(bounds.startSec, bounds.endSec - duration);
      const startSec = clamp(origin.startSec + (seconds - grabSec), bounds.startSec, maxStart);
      return {
        startSec: roundMs(startSec),
        endSec: roundMs(Math.min(bounds.endSec, startSec + duration)),
      };
    }
    return handle === 'start'
      ? {
          startSec: clamp(seconds, bounds.startSec, origin.endSec - minGapSec),
          endSec: origin.endSec,
        }
      : {
          startSec: origin.startSec,
          endSec: clamp(seconds, origin.startSec + minGapSec, bounds.endSec),
        };
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
    const nearest: 'start' | 'end' =
      Math.abs(seconds - range.startSec) <= Math.abs(seconds - range.endSec)
        ? 'start'
        : 'end';
    const handle: RangeHandle = isHandle(named) ? named : nearest;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (handle !== 'move') {
      (handle === 'start' ? startRef : endRef).current?.focus();
    }
    const next = isHandle(named) ? range : moved(range, handle, seconds, seconds);
    drag.current = {handle, origin: range, grabSec: seconds, range: next};
    if (next !== range) {
      props.onDraft(next);
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) {
      return;
    }
    current.range = moved(
      current.origin,
      current.handle,
      secondsAt(event.clientX),
      current.grabSec,
    );
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
    (handle: 'start' | 'end') => (event: KeyboardEvent<HTMLDivElement>) => {
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
        className="relative h-11 cursor-pointer touch-none rounded-xl bg-surface-container-highest"
      >
        {props.retentionPoints && props.sourceDurationSec !== undefined && (
          <RetentionOverlay
            points={props.retentionPoints}
            peaks={props.retentionPeaks}
            lows={props.retentionLows}
            bounds={bounds}
            sourceDurationSec={props.sourceDurationSec}
          />
        )}
        {props.ticks.map((seconds, index) => (
          <span
            key={index}
            className="pointer-events-none absolute top-0 h-2 w-px bg-outline"
            style={{left: percent(seconds)}}
          />
        ))}
        <div
          data-handle="move"
          title="드래그해서 클립 구간 통째로 앞뒤 이동"
          className=" absolute inset-y-2 cursor-grab border-y border-primary/50 bg-primary/15 hover:bg-primary/25 active:cursor-grabbing"
          style={{left: percent(range.startSec), width: widthPercent(range)}}
        />
        {props.kept.map((piece, index) => (
          <div
            key={index}
            className="pointer-events-none absolute bottom-2 h-1.5 rounded-full bg-primary"
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
      <div className="mt-1 flex justify-between text-[11px] text-on-surface-variant tabular-nums">
        <span>{formatClock(bounds.startSec)}</span>
        <span>{formatClock(bounds.endSec)}</span>
      </div>
    </div>
  );
}
