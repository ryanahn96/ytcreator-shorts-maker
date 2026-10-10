/**
 * Plays the OutputSegments back to back across the Source Video's <video>
 * element, a secondary <video> element for external video B-roll clips, and
 * a wall-clock timer for still image B-roll clips.
 */

import {useCallback, useEffect, useRef, useState} from 'react';

import {locateOutput, totalSec, type OutputSegment} from '../lib/timeline';

// A seek that still reads past its segment after this long is sent again,
// in case the element dropped it while loading.
const SEEK_RETRY_MS = 1500;

interface LoopState {
  index: number;
  seekTarget: number | null;
  seekIssuedAt: number;
  wallStartMs: number;
  wallBaseSec: number;
  frame: number;
  outputSec: number;
}

export interface JumpCutPlayback {
  playing: boolean;
  outputSec: number;
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
        segment.planIndex === b[index].planIndex &&
        segment.mediaKind === b[index].mediaKind &&
        segment.assetId === b[index].assetId &&
        segment.muteAudio === b[index].muteAudio,
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

function startPlayback(video: HTMLVideoElement): void {
  // play() rejects when a later pause() interrupts it; the sequencer
  // already tracks that state, so the rejection carries no news.
  video.play().catch(() => undefined);
}

export function useJumpCutPlayback(
  video: HTMLVideoElement | null,
  latestSegments: readonly OutputSegment[],
  toleranceSec: number,
  extVideo?: HTMLVideoElement | null,
  assetUrls?: ReadonlyMap<string, string>,
): JumpCutPlayback {
  const segments = useStableSegments(latestSegments);
  const [playing, setPlaying] = useState(false);
  const [outputSec, setOutputSec] = useState(0);
  const loop = useRef<LoopState>({
    index: 0,
    seekTarget: null,
    seekIssuedAt: 0,
    wallStartMs: 0,
    wallBaseSec: 0,
    frame: 0,
    outputSec: 0,
  });

  const stopLoop = useCallback(
    () => cancelAnimationFrame(loop.current.frame),
    [],
  );

  const activateSegment = useCallback(
    (
      index: number,
      sourceSec: number,
      shouldPlay: boolean,
    ) => {
      const state = loop.current;
      const segment = segments[index];
      state.index = index;
      state.wallStartMs = performance.now();
      state.wallBaseSec = sourceSec;
      if (!segment) {
        return;
      }
      if (segment.mediaKind === 'image') {
        state.seekTarget = null;
        video?.pause();
        extVideo?.pause();
        return;
      }
      if (segment.mediaKind === 'video') {
        video?.pause();
        const url = segment.assetId ? (assetUrls?.get(segment.assetId) ?? '') : '';
        if (extVideo && url) {
          if (extVideo.getAttribute('data-asset-id') !== segment.assetId) {
            extVideo.setAttribute('data-asset-id', segment.assetId ?? '');
            extVideo.src = url;
          }
          extVideo.muted = Boolean(segment.muteAudio);
          state.seekTarget = sourceSec;
          state.seekIssuedAt = performance.now();
          extVideo.currentTime = sourceSec;
          if (shouldPlay) {
            startPlayback(extVideo);
          } else {
            extVideo.pause();
          }
        } else {
          state.seekTarget = null;
        }
        return;
      }
      extVideo?.pause();
      if (video) {
        state.seekTarget = sourceSec;
        state.seekIssuedAt = performance.now();
        video.currentTime = sourceSec;
        if (shouldPlay) {
          startPlayback(video);
        } else {
          video.pause();
        }
      }
    },
    [segments, video, extVideo, assetUrls],
  );

  const pause = useCallback(() => {
    stopLoop();
    video?.pause();
    extVideo?.pause();
    setPlaying(false);
  }, [video, extVideo, stopLoop]);

  // An edit or a new element invalidates the running sequence. The paused
  // video then shows the frame at the playhead.
  useEffect(() => {
    pause();
    const state = loop.current;
    state.outputSec = Math.min(state.outputSec, totalSec(segments));
    setOutputSec(state.outputSec);
    const located = locateOutput(segments, state.outputSec);
    if (located) {
      activateSegment(located.index, located.sourceSec, false);
    }
  }, [pause, segments, activateSegment]);

  useEffect(() => stopLoop, [stopLoop]);

  const play = useCallback(() => {
    const total = totalSec(segments);
    const resumeAt =
      loop.current.outputSec >= total - toleranceSec ? 0 : loop.current.outputSec;
    const located = locateOutput(segments, resumeAt);
    if (!video || !located) {
      return;
    }
    stopLoop();
    activateSegment(located.index, located.sourceSec, true);
    setPlaying(true);

    const tick = () => {
      const state = loop.current;
      const segment = segments[state.index];
      if (!segment) {
        setPlaying(false);
        return;
      }
      let now: number;
      if (segment.mediaKind === 'image') {
        now = state.wallBaseSec + (performance.now() - state.wallStartMs) / 1000;
      } else if (segment.mediaKind === 'video') {
        if (extVideo && extVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          now = extVideo.currentTime;
          if (state.seekTarget !== null) {
            const landed =
              !extVideo.seeking &&
              now >= state.seekTarget - toleranceSec &&
              now < segment.endSec;
            if (!landed) {
              state.frame = requestAnimationFrame(tick);
              return;
            }
            state.seekTarget = null;
          }
        } else {
          now = state.wallBaseSec + (performance.now() - state.wallStartMs) / 1000;
        }
      } else {
        now = video.currentTime;
        if (state.seekTarget !== null) {
          const landed =
            !video.seeking &&
            now >= state.seekTarget - toleranceSec &&
            now < segment.endSec;
          if (!landed) {
            const stale = performance.now() - state.seekIssuedAt > SEEK_RETRY_MS;
            if ((now >= segment.endSec || now < segment.startSec - toleranceSec) && stale) {
              activateSegment(state.index, state.seekTarget, true);
            }
            state.frame = requestAnimationFrame(tick);
            return;
          }
          state.seekTarget = null;
        }
      }

      if (now >= segment.endSec - toleranceSec) {
        const next = state.index + 1;
        if (next >= segments.length) {
          video.pause();
          extVideo?.pause();
          state.outputSec = total;
          setOutputSec(total);
          setPlaying(false);
          return;
        }
        state.outputSec = segments[next].outputStartSec;
        setOutputSec(state.outputSec);
        activateSegment(next, segments[next].startSec, true);
      } else {
        state.outputSec =
          segment.outputStartSec + Math.max(0, now - segment.startSec);
        setOutputSec(state.outputSec);
      }
      state.frame = requestAnimationFrame(tick);
    };
    loop.current.frame = requestAnimationFrame(tick);
  }, [video, extVideo, segments, toleranceSec, activateSegment, stopLoop]);

  const seekOutput = useCallback(
    (target: number) => {
      const clamped = Math.min(Math.max(0, target), totalSec(segments));
      loop.current.outputSec = clamped;
      setOutputSec(clamped);
      const located = locateOutput(segments, clamped);
      if (located) {
        activateSegment(located.index, located.sourceSec, playing);
      }
    },
    [segments, activateSegment, playing],
  );

  return {playing, outputSec, play, pause, seekOutput};
}
