/**
 * Preview before an upload: the YouTube player plays inside the area the
 * current Look fills (box or whole canvas), sized and offset so the crop
 * region fills it, on the Look's background color and inside its border.
 */

import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';

import {errorMessage} from '../../lib/api';
import {cornerRadius, cropRect, fitAspect, videoBox, type Size} from '../../lib/framing';
import {
  loadYouTubeApi,
  youTubeAdapter,
  type PlayerAdapter,
  type YouTubePlayer,
} from '../../lib/players';
import type {FramingLayout, LookStyle, SourceVideo, TemplateStyle} from '../../types';

// The studio's transport drives playback; YouTube's own controls would
// seek behind the jump-cut sequencer's back.
const PLAYER_VARS = {controls: 0, disablekb: 1, playsinline: 1, rel: 0};

export function YouTubePreview(props: {
  sourceVideo: SourceVideo;
  framing: FramingLayout;
  lookStyle: LookStyle;
  style: TemplateStyle;
  output: Size;
  onAdapter: (adapter: PlayerAdapter | null) => void;
  onToggle: () => void;
  children: ReactNode;
}) {
  const {sourceVideo, onAdapter} = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    let cancelled = false;
    let player: YouTubePlayer | null = null;
    // The API replaces this node with an iframe, so React never owns it.
    const mount = document.createElement('div');
    host.replaceChildren(mount);
    loadYouTubeApi()
      .then((api) => {
        if (cancelled) {
          return;
        }
        const created = new api.Player(mount, {
          videoId: sourceVideo.videoId,
          width: '100%',
          height: '100%',
          playerVars: PLAYER_VARS,
          events: {
            onReady: () => {
              if (!cancelled) {
                onAdapter(youTubeAdapter(created));
              }
            },
          },
        });
        player = created;
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(errorMessage(reason));
        }
      });
    return () => {
      cancelled = true;
      onAdapter(null);
      player?.destroy();
      host.replaceChildren();
    };
  }, [sourceVideo.videoId, onAdapter]);

  const known = sourceVideo.width > 0 && sourceVideo.height > 0;
  const {style, output, framing, lookStyle} = props;
  const box = videoBox(style, output.width, framing.fit);
  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  // Size and offset the player so the crop region exactly fills the box.
  let playerPlacement: CSSProperties = {inset: 0};
  if (known) {
    const source = {width: sourceVideo.width, height: sourceVideo.height};
    const rect = cropRect(framing.crop, fitAspect(style, framing.fit), source);
    playerPlacement = {
      left: percent(-rect.x, rect.width),
      top: percent(-rect.y, rect.height),
      width: percent(source.width, rect.width),
      height: percent(source.height, rect.height),
    };
  }
  const canvasBox = videoBox(style, style.canvasWidth, framing.fit);
  const corner = cornerRadius(style, framing, style.canvasWidth);
  const radius = `${percent(corner, canvasBox.width)} / ${percent(corner, canvasBox.height)}`;
  // The frame is a size container, so cqw turns canvas units into pixels.
  const cqw = (value: number) => `${(value / style.canvasWidth) * 100}cqw`;
  const ring = framing.fit === 'box' && lookStyle.border ? lookStyle.borderWidth : 0;
  return (
    <div className="space-y-2">
      <div
        className="studio-frame relative mx-auto overflow-hidden rounded-xl"
        style={{
          aspectRatio: `${output.width} / ${output.height}`,
          background: lookStyle.backgroundColor,
          containerType: 'inline-size',
        }}
      >
        {ring > 0 && (
          <div
            className="pointer-events-none absolute"
            style={{
              left: cqw(canvasBox.x - ring),
              top: cqw(canvasBox.y - ring),
              width: cqw(canvasBox.width + 2 * ring),
              height: cqw(canvasBox.height + 2 * ring),
              border: `${cqw(ring)} solid ${lookStyle.borderColor}`,
              borderRadius: corner > 0 ? cqw(corner + ring) : 0,
            }}
          />
        )}
        <div
          className="absolute overflow-hidden"
          style={{
            left: percent(box.x, output.width),
            top: percent(box.y, output.height),
            width: percent(box.width, output.width),
            height: percent(box.height, output.height),
            borderRadius: radius,
          }}
        >
          <div
            ref={hostRef}
            className="absolute [&>iframe]:h-full [&>iframe]:w-full"
            style={playerPlacement}
          />
        </div>
        <div className="absolute inset-0 cursor-pointer" onClick={props.onToggle} />
        {props.children}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!known && (
        <p className="text-xs text-amber-300">
          원본 해상도를 알 수 없어 확대와 위치를 적용하지 못하고 원본 화면 전체를 보여줍니다.
        </p>
      )}
    </div>
  );
}
