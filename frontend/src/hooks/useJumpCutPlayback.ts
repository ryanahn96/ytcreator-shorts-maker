/**
 * Plays the audio's OutputSegments back to back on a PlayerAdapter; the
 * player's audio is the preview's clock. With an uploaded MP4 the canvas
 * draws the J/L-cut video track against this clock (CanvasPreview).
 */

import {useCallback, useEffect, useRef, useState} from 'react';

import type {PlayerAdapter} from '../lib/players';
import {locateOutput, totalSec, type OutputSegment} from '../lib/timeline';

// A seek that still reads past its segment after this long is sent again
// (the YouTube player can report the old time for a while after seekTo).
const SEEK_RETRY_MS = 1500;

interface LoopState {
  index: number;
  seekTarget: number | null;
  seekIssuedAt: number;
  frame: number;
  outputSec: number;
}

export interface JumpCutPlayback {
  playing: boolean;
  outputSec: number;
  segmentIndex: number;
  /** Output time right now, readable every animation frame. */
  clock: () => number;
  play: () => void;
  pause: () => void;
  seekOutput: (outputSec: number) => void;
}

function sameSegments(
  a: readonly OutputSegment[],
  b: readonly OutputSegment[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (segment, index) =>
        segment.startSec === b[index].startSec &&
        segment.endSec === b[index].endSec &&
        segment.planIndex === b[index].planIndex,
    )
  );
}

/**
 * Returns the previous array while its content is unchanged, so caption
 * and headline edits (which rebuild the segments) keep the preview playing.
 */
function useStableSegments(
  segments: readonly OutputSegment[],
): readonly OutputSegment[] {
  const [stable, setStable] = useState(segments);
  if (stable !== segments && !sameSegments(stable, segments)) {
    setStable(segments);
    return segments;
  }
  return stable;
}

export function useJumpCutPlayback(
  adapter: PlayerAdapter | null,
  latestSegments: readonly OutputSegment[],
  toleranceSec: number,
): JumpCutPlayback {
  const segments = useStableSegments(latestSegments);
  const [playing, setPlaying] = useState(false);
  const [outputSec, setOutputSec] = useState(0);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const loop = useRef<LoopState>({
    index: 0,
    seekTarget: null,
    seekIssuedAt: 0,
    frame: 0,
    outputSec: 0,
  });

  const stopLoop = useCallback(() => {
    cancelAnimationFrame(loop.current.frame);
    loop.current.frame = 0;
  }, []);

  const seekSegment = useCallback(
    (player: PlayerAdapter, index: number, sourceSec: number) => {
      const state = loop.current;
      state.index = index;
      state.seekTarget = sourceSec;
      state.seekIssuedAt = performance.now();
      player.seek(sourceSec);
      setSegmentIndex(index);
    },
    [],
  );

  // An edit or a player switch invalidates the running sequence. The
  // paused player then shows the frame at the playhead.
  useEffect(() => {
    stopLoop();
    setPlaying(false);
    adapter?.pause();
    const state = loop.current;
    state.outputSec = Math.min(state.outputSec, totalSec(segments));
    state.index = Math.min(state.index, Math.max(0, segments.length - 1));
    setOutputSec(state.outputSec);
    setSegmentIndex(state.index);
    const located = locateOutput(segments, state.outputSec);
    if (adapter && located) {
      adapter.seek(located.sourceSec);
    }
  }, [adapter, segments, stopLoop]);

  useEffect(() => stopLoop, [stopLoop]);

  const pause = useCallback(() => {
    stopLoop();
    adapter?.pause();
    setPlaying(false);
  }, [adapter, stopLoop]);

  const play = useCallback(() => {
    const total = totalSec(segments);
    const resumeAt =
      loop.current.outputSec >= total - toleranceSec ? 0 : loop.current.outputSec;
    const located = locateOutput(segments, resumeAt);
    if (!adapter || !located) {
      return;
    }
    stopLoop();
    seekSegment(adapter, located.index, located.sourceSec);
    adapter.play();
    setPlaying(true);

    const tick = () => {
      const state = loop.current;
      const segment = segments[state.index];
      const now = adapter.currentTime();
      if (state.seekTarget !== null) {
        const landed =
          now >= segment.startSec - toleranceSec && now < segment.endSec;
        if (!landed) {
          const stale = performance.now() - state.seekIssuedAt > SEEK_RETRY_MS;
          if (now >= segment.endSec && stale) {
            seekSegment(adapter, state.index, state.seekTarget);
          }
          state.frame = requestAnimationFrame(tick);
          return;
        }
        state.seekTarget = null;
      }
      if (now >= segment.endSec - toleranceSec) {
        const next = state.index + 1;
        if (next >= segments.length) {
          adapter.pause();
          state.outputSec = total;
          state.frame = 0;
          setOutputSec(total);
          setPlaying(false);
          return;
        }
        seekSegment(adapter, next, segments[next].startSec);
      } else {
        state.outputSec =
          segment.outputStartSec + Math.max(0, now - segment.startSec);
        setOutputSec(state.outputSec);
      }
      state.frame = requestAnimationFrame(tick);
    };
    loop.current.frame = requestAnimationFrame(tick);
  }, [adapter, segments, toleranceSec, seekSegment, stopLoop]);

  const seekOutput = useCallback(
    (target: number) => {
      const clamped = Math.min(Math.max(0, target), totalSec(segments));
      loop.current.outputSec = clamped;
      setOutputSec(clamped);
      const located = locateOutput(segments, clamped);
      if (adapter && located) {
        seekSegment(adapter, located.index, located.sourceSec);
      }
    },
    [adapter, segments, seekSegment],
  );

  const clock = useCallback(() => loop.current.outputSec, []);

  return {playing, outputSec, segmentIndex, clock, play, pause, seekOutput};
}
