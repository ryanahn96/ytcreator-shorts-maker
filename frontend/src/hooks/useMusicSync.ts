/**
 * Plays the Background Music of the preview on an <audio> element that
 * follows the jump-cut transport: it loops, starts and stops with playback,
 * jumps with seeks and fades out at the end like the render.
 */

import {useEffect, useRef, type RefObject} from 'react';

// The music is re-seeked when it drifts further than this from the
// transport (seeks and segment switches show up as larger jumps).
const DRIFT_SEC = 0.3;

export function useMusicSync(input: {
  audio: RefObject<HTMLAudioElement | null>;
  url: string | null;
  playing: boolean;
  outputSec: number;
  durationSec: number;
  volume: number;
  fadeOutSec: number;
}): void {
  const {audio, url, playing, outputSec, durationSec, volume, fadeOutSec} = input;
  const lastOutput = useRef(outputSec);

  useEffect(() => {
    const element = audio.current;
    if (!element || !url) {
      return;
    }
    const remaining = durationSec - outputSec;
    const fade = fadeOutSec > 0 ? Math.min(1, Math.max(0, remaining / fadeOutSec)) : 1;
    element.volume = Math.min(1, Math.max(0, volume * fade));
    const length = element.duration;
    if (Number.isFinite(length) && length > 0) {
      const expected = outputSec % length;
      const jumped = Math.abs(outputSec - lastOutput.current) > DRIFT_SEC;
      if (jumped || Math.abs(element.currentTime - expected) > DRIFT_SEC) {
        element.currentTime = expected;
      }
    }
    lastOutput.current = outputSec;
  }, [audio, url, outputSec, durationSec, volume, fadeOutSec]);

  useEffect(() => {
    const element = audio.current;
    if (!element || !url) {
      return;
    }
    if (playing) {
      // Autoplay rules can reject play(); the next user click retries.
      element.play().catch(() => undefined);
    } else {
      element.pause();
    }
  }, [audio, url, playing]);
}
