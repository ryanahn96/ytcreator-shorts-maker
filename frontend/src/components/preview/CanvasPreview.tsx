/**
 * 9:16 preview of the Source Video file and any inserted image/video B-roll
 * clips. Hidden <video> elements provide the video frames and audio clock,
 * and every frame is drawn onto a canvas the way the Look on screen frames it.
 */

import {useEffect, useRef, type ReactNode} from 'react';

import {drawFrame, type Size} from '../../lib/framing';
import type {OutputSegment} from '../../lib/timeline';
import type {FramingLayout, LookStyle, TemplateStyle} from '../../types';

export function CanvasPreview(props: {
  videoUrl: string;
  activeSegment: OutputSegment | null;
  assetUrls: ReadonlyMap<string, string>;
  framing: FramingLayout;
  lookStyle: LookStyle;
  style: TemplateStyle;
  output: Size;
  /** Receives the Source Video <video>. */
  onVideo: (video: HTMLVideoElement | null) => void;
  /** Receives the external B-roll <video>. */
  onExtVideo: (video: HTMLVideoElement | null) => void;
  onToggle: () => void;
  children: ReactNode;
}) {
  const {
    videoUrl,
    activeSegment,
    assetUrls,
    framing,
    lookStyle,
    style,
    output,
    onVideo,
    onExtVideo,
  } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const extVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());

  useEffect(() => {
    onVideo(videoRef.current);
    onExtVideo(extVideoRef.current);
    return () => {
      onVideo(null);
      onExtVideo(null);
    };
  }, [onVideo, onExtVideo, videoUrl]);

  const {width, height} = output;
  const mediaKind = activeSegment?.mediaKind ?? 'source';
  const assetId = activeSegment?.assetId ?? null;
  const assetUrl = assetId ? (assetUrls.get(assetId) ?? '') : '';

  useEffect(() => {
    const video = videoRef.current;
    const extVideo = extVideoRef.current;
    const context = canvasRef.current?.getContext('2d');
    if (!video || !context) {
      return;
    }
    const size = {width, height};
    let frame = 0;
    let drawn = -1;

    let cachedImg: HTMLImageElement | null = null;
    if (mediaKind === 'image' && assetUrl) {
      let existing = imageCacheRef.current.get(assetUrl);
      if (!existing) {
        existing = new Image();
        existing.src = assetUrl;
        imageCacheRef.current.set(assetUrl, existing);
      }
      cachedImg = existing;
    }
    // A video Clip without the B-roll element falls back to the Source Video.
    const media =
      mediaKind === 'image' ? cachedImg : mediaKind === 'video' && extVideo ? extVideo : video;

    const draw = () => {
      if (media) {
        const still = media instanceof HTMLImageElement;
        const source = still
          ? {width: media.naturalWidth, height: media.naturalHeight}
          : {width: media.videoWidth, height: media.videoHeight};
        const ready = still
          ? media.complete
          : media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        // A still image is drawn once; a video again whenever it plays or seeks.
        const time = still ? 1 : media.currentTime;
        const playing = !still && !media.paused;
        if (ready && source.width > 0 && (playing || time !== drawn)) {
          drawFrame({context, image: media, framing, lookStyle, style, source, output: size});
          drawn = time;
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [framing, lookStyle, style, width, height, mediaKind, assetUrl]);

  return (
    // The frame sits on the Look's background (black by default), so its
    // handles and placeholders use the dark theme colors.
    <div
      data-theme="dark"
      className="studio-frame relative mx-auto overflow-hidden rounded-2xl"
      style={{aspectRatio: `${width} / ${height}`, background: lookStyle.backgroundColor}}
    >
      <canvas ref={canvasRef} width={width} height={height} className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-0 cursor-pointer" onClick={props.onToggle} />
      {props.children}
      <video
        ref={videoRef}
        src={videoUrl}
        preload="auto"
        playsInline
        className="pointer-events-none absolute h-px w-px opacity-0"
      />
      <video
        ref={extVideoRef}
        preload="auto"
        playsInline
        className="pointer-events-none absolute h-px w-px opacity-0"
      />
    </div>
  );
}
