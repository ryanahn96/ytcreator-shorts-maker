/**
 * 9:16 preview of the uploaded MP4. A hidden <video> plays the audio track
 * and is the clock; every frame is drawn onto a canvas the way the Look on
 * screen frames it. With a J/L-cut, the frames a transition borrows from
 * outside the playing audio segment come from a second, muted <video> that
 * is parked at the next borrowed frame ahead of time, so the preview shows
 * the same picture/sound offset the render has.
 */

import {useEffect, useRef, type ReactNode} from 'react';

import {drawFrame, type Size} from '../../lib/framing';
import {videoElementAdapter, type PlayerAdapter} from '../../lib/players';
import {locateOutput, type VideoSegment} from '../../lib/timeline';
import type {FramingLayout, LookStyle, TemplateStyle} from '../../types';

// The borrowed-frames player is re-seeked when it drifts this far.
const DRIFT_SEC = 0.12;
// It is parked at the next borrowed frames this long before they show.
const PARK_AHEAD_SEC = 1.0;

/** Keeps `helper` on the borrowed frames; true when it should be drawn. */
function steerHelper(
  helper: HTMLVideoElement,
  segments: readonly VideoSegment[],
  outputSec: number,
  playing: boolean,
): boolean {
  const located = locateOutput(segments, outputSec);
  if (!located) {
    return false;
  }
  const segment = segments[located.index];
  if (segment.window) {
    if (Math.abs(helper.currentTime - located.sourceSec) > DRIFT_SEC && !helper.seeking) {
      helper.currentTime = located.sourceSec;
    }
    if (playing && helper.paused) {
      helper.play().catch(() => undefined);
    } else if (!playing && !helper.paused) {
      helper.pause();
    }
    return helper.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }
  if (!helper.paused) {
    helper.pause();
  }
  const next = segments
    .slice(located.index + 1)
    .find((item) => item.window && item.outputStartSec - outputSec < PARK_AHEAD_SEC);
  if (next && Math.abs(helper.currentTime - next.startSec) > 0.01 && !helper.seeking) {
    helper.currentTime = next.startSec;
  }
  return false;
}

export function CanvasPreview(props: {
  objectUrl: string;
  framing: FramingLayout;
  lookStyle: LookStyle;
  style: TemplateStyle;
  output: Size;
  /** The video track (see timeline.videoSegments). */
  videoSegments: readonly VideoSegment[];
  /** Current output time. */
  clock: () => number;
  onAdapter: (adapter: PlayerAdapter | null) => void;
  onToggle: () => void;
  children: ReactNode;
}) {
  const {objectUrl, framing, lookStyle, style, output, onAdapter, videoSegments, clock} = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const helperRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const borrows = videoSegments.some((segment) => segment.window);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    onAdapter(videoElementAdapter(video));
    return () => onAdapter(null);
  }, [onAdapter, objectUrl]);

  const {width, height} = output;
  useEffect(() => {
    const video = videoRef.current;
    const helper = helperRef.current;
    const context = canvasRef.current?.getContext('2d');
    if (!video || !context) {
      return;
    }
    const size = {width, height};
    let frame = 0;
    let drawn = '';
    const draw = () => {
      const useHelper =
        borrows && helper !== null && steerHelper(helper, videoSegments, clock(), !video.paused);
      const image = useHelper && helper ? helper : video;
      const ready = image.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && image.videoWidth > 0;
      const key = `${useHelper}:${image.currentTime}`;
      if (ready && (!image.paused || key !== drawn)) {
        drawFrame({
          context,
          image,
          framing,
          lookStyle,
          style,
          source: {width: image.videoWidth, height: image.videoHeight},
          output: size,
        });
        drawn = key;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      helper?.pause();
    };
  }, [framing, lookStyle, style, width, height, borrows, videoSegments, clock]);

  return (
    <div
      className="studio-frame relative mx-auto overflow-hidden rounded-xl"
      style={{aspectRatio: `${width} / ${height}`, background: lookStyle.backgroundColor}}
    >
      <canvas ref={canvasRef} width={width} height={height} className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-0 cursor-pointer" onClick={props.onToggle} />
      {props.children}
      <video
        ref={videoRef}
        src={objectUrl}
        preload="auto"
        playsInline
        className="pointer-events-none absolute h-px w-px opacity-0"
      />
      {borrows && (
        <video
          ref={helperRef}
          src={objectUrl}
          preload="auto"
          playsInline
          muted
          className="pointer-events-none absolute h-px w-px opacity-0"
        />
      )}
    </div>
  );
}
