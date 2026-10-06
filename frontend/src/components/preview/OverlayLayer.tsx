/**
 * HTML twin of everything burned in above the video for one Look: the
 * Headline and the caption in the Look's fonts, colors, outlines and
 * background boxes (as the ASS file draws them, see composer.build_ass)
 * and the Image Overlays (as ffmpeg composites them).
 * Text blocks and images can be dragged here; images also get resize and
 * rotate handles when selected. Drags stay local until the pointer is
 * released, then commit the edited Look once.
 */

import {Fragment, useRef, useState, type CSSProperties, type PointerEvent} from 'react';

import {cssFontSize, fontStack, rgba} from '../../lib/fonts';
import {videoBox} from '../../lib/framing';
import type {
  FontEntry,
  ImageOverlay,
  Look,
  TemplateStyle,
  TextLayout,
  TextPlacement,
  TextStyle,
} from '../../types';

interface Point {
  x: number;
  y: number;
}

interface TextLine {
  text: string;
  color: string;
}

type Draft = {textLayout: TextLayout} | {image: ImageOverlay};

// A dragged text block snaps to the canvas center line within this many
// canvas units.
const SNAP_UNITS = 12;
// Images never shrink below this width in canvas units.
const MIN_IMAGE_UNITS = 24;

function normalizeDegrees(value: number): number {
  const turned = ((((value + 180) % 360) + 360) % 360) - 180;
  return Math.round(turned * 10) / 10;
}

export function OverlayLayer(props: {
  style: TemplateStyle;
  fonts: ReadonlyMap<string, FontEntry>;
  /** The Look of the Clip on screen. */
  look: Look;
  /** Active caption text; empty between cues. */
  caption: string;
  assetUrls: ReadonlyMap<string, string>;
  /** Shows a placeholder where the caption goes while no cue is active. */
  showPlaceholders: boolean;
  selectedImageId: string | null;
  onSelectImage: (overlayId: string | null) => void;
  onLook: (look: Look) => void;
}) {
  const {style, look} = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const textLayout = draft && 'textLayout' in draft ? draft.textLayout : look.textLayout;
  const images = look.images.map((image) =>
    draft && 'image' in draft && draft.image.overlayId === image.overlayId ? draft.image : image,
  );

  // The root is a size container, so cqw maps canvas units to pixels.
  const unit = (value: number) => `${(value / style.canvasWidth) * 100}cqw`;
  const toCanvas = (clientX: number, clientY: number): Point => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      return {x: 0, y: 0};
    }
    const scale = style.canvasWidth / rect.width;
    return {x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale};
  };

  const drag = (
    event: PointerEvent<HTMLElement>,
    move: (from: Point, to: Point) => Draft,
    commit: (value: Draft) => void,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const from = toCanvas(event.clientX, event.clientY);
    let last: Draft | null = null;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      last = move(from, toCanvas(moveEvent.clientX, moveEvent.clientY));
      setDraft(last);
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      setDraft(null);
      if (last) {
        commit(last);
      }
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const commitDraft = (value: Draft) => {
    if ('textLayout' in value) {
      props.onLook({...look, textLayout: value.textLayout});
    } else {
      props.onLook({
        ...look,
        images: look.images.map((item) =>
          item.overlayId === value.image.overlayId ? value.image : item,
        ),
      });
    }
  };

  const dragText = (event: PointerEvent<HTMLElement>, key: keyof TextLayout) => {
    const start = look.textLayout[key];
    const center = style.canvasWidth / 2;
    drag(
      event,
      (from, to) => {
        let x = start.x + to.x - from.x;
        if (Math.abs(x - center) < SNAP_UNITS) {
          x = center;
        }
        const placement: TextPlacement = {
          x: Math.round(x),
          y: Math.round(start.y + to.y - from.y),
        };
        return {textLayout: {...look.textLayout, [key]: placement}};
      },
      commitDraft,
    );
  };

  const dragImage = (
    event: PointerEvent<HTMLElement>,
    start: ImageOverlay,
    mode: 'move' | 'resize' | 'rotate',
  ) => {
    props.onSelectImage(start.overlayId);
    const center = {x: start.x, y: start.y};
    drag(
      event,
      (from, to) => {
        if (mode === 'move') {
          return {
            image: {
              ...start,
              x: Math.round(start.x + to.x - from.x),
              y: Math.round(start.y + to.y - from.y),
            },
          };
        }
        if (mode === 'resize') {
          const before = Math.hypot(from.x - center.x, from.y - center.y);
          const after = Math.hypot(to.x - center.x, to.y - center.y);
          const width = Math.max(MIN_IMAGE_UNITS, before > 0 ? (start.width * after) / before : start.width);
          return {
            image: {
              ...start,
              width: Math.round(width),
              height: Math.round((width * start.height) / start.width),
            },
          };
        }
        const turn =
          Math.atan2(to.y - center.y, to.x - center.x) -
          Math.atan2(from.y - center.y, from.x - center.x);
        return {
          image: {...start, rotationDeg: normalizeDegrees(start.rotationDeg + (turn * 180) / Math.PI)},
        };
      },
      commitDraft,
    );
  };

  // Mirrors the ASS events: bottom center anchored at the placement,
  // wrapped within `width`, one line box per ASS size. A background is its
  // own layer below the text, like the Box event under the Text event.
  const textBlock = (
    key: keyof TextLayout,
    width: number,
    textStyle: TextStyle,
    label: string,
    lines: readonly TextLine[],
    dim: boolean,
  ) => {
    const placement = textLayout[key];
    const pad = unit(style.textBoxPadding);
    const frame: CSSProperties = {
      left: unit(placement.x - width / 2),
      width: unit(width),
      bottom: unit(style.canvasHeight - placement.y),
      fontFamily: fontStack(textStyle.fontId),
      fontSize: unit(cssFontSize(props.fonts.get(textStyle.fontId), textStyle.size)),
      lineHeight: unit(textStyle.size),
      textWrap: 'balance',
      // libass breaks lines at spaces only; CSS would also break between
      // Hangul syllables.
      wordBreak: 'keep-all',
      opacity: dim ? 0.45 : 1,
    } as CSSProperties;
    // Padding with an equal negative margin draws the box without moving
    // the text, as libass's box does not take part in line breaking.
    const piece: CSSProperties = {
      padding: `0 ${pad}`,
      margin: `0 calc(-1 * ${pad})`,
      boxDecorationBreak: 'clone',
      WebkitBoxDecorationBreak: 'clone',
    };
    const body = (paint: (line: TextLine) => CSSProperties) =>
      lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 && <div style={{height: unit(style.headlineLineGap)}} />}
          <div>
            <span style={{...piece, ...paint(line)}}>{line.text}</span>
          </div>
        </Fragment>
      ));
    return (
      <Fragment key={key}>
        {textStyle.background && (
          <div aria-hidden className="absolute" style={{...frame, color: 'transparent'}}>
            {body(() => ({
              background: rgba(textStyle.backgroundColor, textStyle.backgroundOpacity),
              paddingTop: pad,
              paddingBottom: pad,
            }))}
          </div>
        )}
        <div
          role="button"
          aria-label={`${label} 위치 이동`}
          title={`${label}: 드래그해서 옮기기`}
          onPointerDown={(event) => dragText(event, key)}
          className="pointer-events-auto absolute cursor-move touch-none select-none rounded-sm outline-1 outline-dashed outline-transparent hover:outline-white/60"
          style={frame}
        >
          {body((line) => ({
            color: line.color,
            WebkitTextStroke:
              textStyle.outlineWidth > 0
                ? `${unit(textStyle.outlineWidth * 2)} ${textStyle.outlineColor}`
                : undefined,
            paintOrder: 'stroke fill',
          }))}
        </div>
      </Fragment>
    );
  };

  const accent = look.headline.accent.trim();
  const main = look.headline.main.trim();
  const box = videoBox(style, style.canvasWidth, look.framingLayout.fit);
  const headlineWidth = style.canvasWidth - 2 * style.boxSideMargin;
  const captionWidth = style.canvasWidth - 2 * (box.x + style.captionSidePadding);
  const caption = props.caption || (props.showPlaceholders ? '자막 위치' : '');
  const {headline: headlineStyle, caption: captionStyle} = look.style;
  const headlineLines: TextLine[] = [
    {text: accent, color: headlineStyle.accentColor},
    {text: main, color: headlineStyle.color},
  ].filter((line) => line.text);

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 overflow-hidden text-center font-normal"
      style={{containerType: 'inline-size'}}
    >
      {headlineLines.length > 0 &&
        textBlock('headline', headlineWidth, headlineStyle, '헤드라인', headlineLines, false)}
      {caption &&
        textBlock(
          'caption',
          captionWidth,
          captionStyle,
          '자막',
          [{text: caption, color: captionStyle.color}],
          !props.caption,
        )}
      {images.map((image) => {
        const url = props.assetUrls.get(image.assetId);
        const selected = image.overlayId === props.selectedImageId;
        return (
          <div
            key={image.overlayId}
            role="button"
            aria-label="이미지 이동"
            onPointerDown={(event) => dragImage(event, image, 'move')}
            className={`pointer-events-auto absolute cursor-move touch-none select-none ${
              selected ? 'outline-2 outline-dashed outline-sky-400' : 'hover:outline-1 hover:outline-dashed hover:outline-white/60'
            }`}
            style={{
              left: unit(image.x - image.width / 2),
              top: unit(image.y - image.height / 2),
              width: unit(image.width),
              height: unit(image.height),
              transform: `rotate(${image.rotationDeg}deg)`,
            }}
          >
            {url ? (
              <img src={url} alt="" draggable={false} className="h-full w-full" />
            ) : (
              <div className="grid h-full w-full place-items-center bg-zinc-800/80 text-[10px] font-normal text-zinc-300">
                이미지 없음
              </div>
            )}
            {selected && (
              <>
                <span
                  role="button"
                  aria-label="이미지 크기 조절"
                  title="드래그해서 크기 조절"
                  onPointerDown={(event) => dragImage(event, image, 'resize')}
                  className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-sky-500"
                />
                <span
                  role="button"
                  aria-label="이미지 회전"
                  title="드래그해서 회전"
                  onPointerDown={(event) => dragImage(event, image, 'rotate')}
                  className="absolute -top-5 left-1/2 h-3 w-3 -translate-x-1/2 cursor-grab rounded-full border border-white bg-sky-500"
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
