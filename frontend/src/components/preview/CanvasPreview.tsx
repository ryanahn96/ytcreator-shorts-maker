/**
 * 9:16 preview of the Source Video file and any inserted image/video B-roll
 * clips. Hidden <video> elements provide the video frames and audio clock,
 * and every frame is drawn onto a canvas the way the Look on screen frames it.
 */

import {useEffect, useRef, useState, type ReactNode} from 'react';

import {drawFrame} from '../../lib/framing';
import type {OutputSegment} from '../../lib/timeline';
import type {FramingLayout, LookStyle, TemplateStyle} from '../../types';
import {Notice} from '../ui';

export function CanvasPreview(props: {
  videoUrl: string;
  activeSegment: OutputSegment | null;
  assetUrls: ReadonlyMap<string, string>;
  framing: FramingLayout;
  lookStyle: LookStyle;
  style: TemplateStyle;
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
    onVideo,
    onExtVideo,
  } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const extVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [undecodable, setUndecodable] = useState(false);

  useEffect(() => {
    onVideo(videoRef.current);
    onExtVideo(extVideoRef.current);
    return () => {
      onVideo(null);
      onExtVideo(null);
    };
  }, [onVideo, onExtVideo, videoUrl]);

  // Half the render size keeps drawing cheap; the frame scales it anyway.
  const width = style.canvasWidth / 2;
  const height = style.canvasHeight / 2;
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
    // null until the first frame reports, so a new clip clears an old notice.
    let shownBlank: boolean | null = null;

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
      let blank = false;
      if (media) {
        const still = media instanceof HTMLImageElement;
        const source = still
          ? {width: media.naturalWidth, height: media.naturalHeight}
          : {width: media.videoWidth, height: media.videoHeight};
        const ready = still
          ? media.complete
          : media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        // Loaded or failed without a picture size: the browser cannot
        // decode this picture (e.g. HEVC).
        blank = still
          ? media.complete && source.width === 0
          : media.error !== null ||
            (media.readyState >= HTMLMediaElement.HAVE_METADATA && source.width === 0);
        // A still image is drawn once; a video again whenever it plays or seeks.
        const time = still ? 1 : media.currentTime;
        const playing = !still && !media.paused;
        if (ready && source.width > 0 && (playing || time !== drawn)) {
          drawFrame({context, image: media, framing, lookStyle, style, source, output: size});
          drawn = time;
        }
      }
      if (blank !== shownBlank) {
        shownBlank = blank;
        setUndecodable(blank);
        if (blank) {
          // Drop the last clip's frame instead of leaving it on screen.
          context.clearRect(0, 0, width, height);
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
      className="studio-frame relative mx-auto w-full overflow-hidden rounded-2xl"
      style={{aspectRatio: `${width} / ${height}`, background: lookStyle.backgroundColor}}
    >
      <canvas ref={canvasRef} width={width} height={height} className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-0 cursor-pointer" onClick={props.onToggle} />
      {props.children}
      {undecodable && (
        <div className="pointer-events-none absolute inset-x-3 top-1/2 -translate-y-1/2">
          <Notice tone="warning">
            이 브라우저에서는 이 영상의 화면을 미리 볼 수 없어요(HEVC 등). MP4에는
            화면이 그대로 들어가요.
          </Notice>
        </div>
      )}
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
