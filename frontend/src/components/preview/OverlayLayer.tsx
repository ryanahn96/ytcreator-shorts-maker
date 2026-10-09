/**
 * HTML twin of everything burned in above the video for one Look: the
 * Headline and the caption in the Look's fonts, colors, outlines and
 * background boxes (as the ASS file draws them, see composer.build_ass)
 * and the Image Overlays (as ffmpeg composites them).
 * Text blocks and images can be dragged here; images also get resize and
 * rotate handles when selected. Drags stay local until the pointer is
 * released, then commit what was dragged once, as an edit of the Look as it
 * is by then, so a change that landed during the drag (an Edit Request's
 * answer) stays. A press that does not move is a click, which reports what
 * was hit so the editor can focus it.
 */

import {Fragment, useRef, useState, type CSSProperties, type PointerEvent} from 'react';

import {type StageHit} from '../../lib/focus';
import {cssFontSize, fontStack, rgba} from '../../lib/fonts';
import {clampVideoBox, MIN_VIDEO_BOX, videoBox} from '../../lib/framing';
import {type LookEdit} from '../../lib/look';
import type {
  FontEntry,
  ImageOverlay,
  Look,
  TemplateStyle,
  TextLayout,
  TextPlacement,
  TextStyle,
  VideoBoxSpec,
} from '../../types';

interface Point {
  x: number;
  y: number;
}

interface TextLine {
  text: string;
  color: string;
}

type BoxHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
type Draft = {textLayout: TextLayout} | {image: ImageOverlay} | {box: VideoBoxSpec};

// A dragged text block snaps to the canvas center line within this many
// canvas units.
const SNAP_UNITS = 12;
// Images never shrink below this width in canvas units.
const MIN_IMAGE_UNITS = 24;
// A press that moves less than this many canvas units is a click.
const CLICK_UNITS = 3;

// Handles on the video box: its edges move it, its corners resize it.
const BOX_EDGES = [
  {
    at: '-top-2 inset-x-3 h-4',
    label: '영상 화면 위치 이동',
    title: '드래그해서 영상 위치 이동, 클릭해서 영상 배치 설정 열기',
  },
  {at: '-bottom-2 inset-x-3 h-4', label: '영상 화면 아래쪽 테두리 이동', title: '드래그해서 영상 위치 이동'},
  {at: 'inset-y-3 -left-2 w-4', label: '영상 화면 왼쪽 테두리 이동', title: '드래그해서 영상 위치 이동'},
  {at: 'inset-y-3 -right-2 w-4', label: '영상 화면 오른쪽 테두리 이동', title: '드래그해서 영상 위치 이동'},
];
const BOX_CORNERS = [
  {handle: 'nw', at: '-top-1.5 -left-1.5', cursor: 'cursor-nwse-resize', label: '왼쪽 위'},
  {handle: 'ne', at: '-top-1.5 -right-1.5', cursor: 'cursor-nesw-resize', label: '오른쪽 위'},
  {handle: 'sw', at: '-bottom-1.5 -left-1.5', cursor: 'cursor-nesw-resize', label: '왼쪽 아래'},
  {handle: 'se', at: '-right-1.5 -bottom-1.5', cursor: 'cursor-nwse-resize', label: '오른쪽 아래'},
] as const;

function normalizeDegrees(value: number): number {
  const turned = ((((value + 180) % 360) + 360) % 360) - 180;
  return Math.round(turned * 10) / 10;
}

/** Index of the text line under `target`, or 0 outside every line. */
function lineAt(target: EventTarget | null): number {
  const line =
    target instanceof Element ? target.closest<HTMLElement>('[data-line]') : null;
  return Number(line?.dataset.line ?? 0);
}

export function OverlayLayer(props: {
  style: TemplateStyle;
  fonts: ReadonlyMap<string, FontEntry>;
  /** The Look of the Clip on screen. */
  look: Look;
  /** Active caption text; empty between cues. */
  caption: string;
  assetUrls: ReadonlyMap<string, string>;
  /** Shows where the Headline and caption go while they are empty. */
  showPlaceholders: boolean;
  selectedImageId: string | null;
  onSelectImage: (overlayId: string | null) => void;
  /**
   * A drag ended: `edit` applies only what was dragged, to the Look of the
   * Clip that was on screen when the drag started.
   */
  onLook: (edit: LookEdit) => void;
  /** A click (not a drag) landed on this element. */
  onHit: (hit: StageHit) => void;
}) {
  const {style, look} = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const textLayout = draft && 'textLayout' in draft ? draft.textLayout : look.textLayout;
  const effectiveFraming =
    draft && 'box' in draft
      ? {...look.framingLayout, box: draft.box}
      : look.framingLayout;
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

  // Tracks a press: a move past CLICK_UNITS drags (drafts on every move,
  // commits the last draft on release); a release before that is a click.
  const drag = <T extends Draft>(
    event: PointerEvent<HTMLElement>,
    move: (from: Point, to: Point) => T,
    commit: (value: T) => void,
    click: () => void,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const from = toCanvas(event.clientX, event.clientY);
    let last: T | null = null;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const to = toCanvas(moveEvent.clientX, moveEvent.clientY);
      if (last === null && Math.hypot(to.x - from.x, to.y - from.y) < CLICK_UNITS) {
        return;
      }
      last = move(from, to);
      setDraft(last);
    };
    const finish = (released: boolean) => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onCancel);
      setDraft(null);
      if (last) {
        commit(last);
      } else if (released) {
        click();
      }
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onCancel);
  };

  const dragVideoBox = (
    event: PointerEvent<HTMLElement>,
    handle: BoxHandle,
  ) => {
    const startBox = look.framingLayout.box
      ? clampVideoBox(style, look.framingLayout.box)
      : videoBox(style, style.canvasWidth);
    const right = startBox.x + startBox.width;
    const bottom = startBox.y + startBox.height;
    drag(
      event,
      (from, to): {box: VideoBoxSpec} => {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        if (handle === 'move') {
          let nextX = startBox.x + dx;
          const centerX = (style.canvasWidth - startBox.width) / 2;
          if (Math.abs(nextX - centerX) < SNAP_UNITS) {
            nextX = centerX;
          }
          return {
            box: clampVideoBox(style, {
              x: nextX,
              y: startBox.y + dy,
              width: startBox.width,
              height: startBox.height,
            }),
          };
        }
        const nextLeft =
          handle === 'nw' || handle === 'sw'
            ? Math.max(0, Math.min(right - MIN_VIDEO_BOX, startBox.x + dx))
            : startBox.x;
        const nextRight =
          handle === 'ne' || handle === 'se'
            ? Math.min(style.canvasWidth, Math.max(startBox.x + MIN_VIDEO_BOX, right + dx))
            : right;
        const nextTop =
          handle === 'nw' || handle === 'ne'
            ? Math.max(0, Math.min(bottom - MIN_VIDEO_BOX, startBox.y + dy))
            : startBox.y;
        const nextBottom =
          handle === 'sw' || handle === 'se'
            ? Math.min(style.canvasHeight, Math.max(startBox.y + MIN_VIDEO_BOX, bottom + dy))
            : bottom;
        return {
          box: clampVideoBox(style, {
            x: nextLeft,
            y: nextTop,
            width: nextRight - nextLeft,
            height: nextBottom - nextTop,
          }),
        };
      },
      ({box}) =>
        props.onLook((current) => ({
          ...current,
          framingLayout: {...current.framingLayout, fit: 'box', box},
        })),
      () => props.onHit({kind: 'videoBox'}),
    );
  };

  const dragText = (
    event: PointerEvent<HTMLElement>,
    key: keyof TextLayout,
    click: () => void,
  ) => {
    const start = look.textLayout[key];
    const center = style.canvasWidth / 2;
    drag(
      event,
      (from, to): {textLayout: TextLayout} => {
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
      ({textLayout: moved}) =>
        props.onLook((current) => ({
          ...current,
          textLayout: {...current.textLayout, [key]: moved[key]},
        })),
      click,
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
      (from, to): {image: ImageOverlay} => {
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
      // Only the dragged fields: the rest of the image may have changed, and
      // nothing changes once the image is gone.
      ({image}) => {
        const fields =
          mode === 'move'
            ? {x: image.x, y: image.y}
            : mode === 'resize'
              ? {width: image.width, height: image.height}
              : {rotationDeg: image.rotationDeg};
        props.onLook((current) =>
          current.images.some((item) => item.overlayId === image.overlayId)
            ? {
                ...current,
                images: current.images.map((item) =>
                  item.overlayId === image.overlayId ? {...item, ...fields} : item,
                ),
              }
            : current,
        );
      },
      () => props.onHit({kind: 'image', overlayId: start.overlayId}),
    );
  };

  // Mirrors the ASS events: bottom center anchored at the placement,
  // wrapped within `width`, one line box per ASS size. A background is its
  // own layer below the text, like the Box event under the Text event.
  // A click reports the index (into `lines`) of the line it landed on.
  const textBlock = (
    key: keyof TextLayout,
    width: number,
    textStyle: TextStyle,
    label: string,
    lines: readonly TextLine[],
    dim: boolean,
    onClick: (line: number) => void,
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
          <div data-line={index}>
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
          title={`${label}: 드래그해서 옮기기, 눌러서 수정`}
          onPointerDown={(event) => {
            const line = lineAt(event.target);
            dragText(event, key, () => onClick(line));
          }}
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

  const box = videoBox(style, style.canvasWidth, effectiveFraming);
  const headlineWidth = style.canvasWidth - 2 * style.boxSideMargin;
  const captionWidth = style.canvasWidth - 2 * (box.x + style.captionSidePadding);
  const caption = props.caption || (props.showPlaceholders ? '자막 위치' : '');
  const {headline: headlineStyle, caption: captionStyle} = look.style;
  // The drawn Headline lines with their index in Headline.lines; the first
  // drawn line takes the accent color.
  const shownLines = look.headline.lines
    .map((text, index) => ({text: text.trim(), index}))
    .filter((line) => line.text);
  const headlineLines: TextLine[] = shownLines.map((line, shown) => ({
    text: line.text,
    color: shown === 0 ? headlineStyle.accentColor : headlineStyle.color,
  }));
  const headlineEmpty = headlineLines.length === 0;
  if (headlineEmpty && props.showPlaceholders) {
    headlineLines.push({text: '헤드라인 위치', color: headlineStyle.accentColor});
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 overflow-hidden text-center font-normal"
      style={{containerType: 'inline-size'}}
    >
      {effectiveFraming.fit === 'box' && props.showPlaceholders && (
        <div
          className="group/vbox pointer-events-none absolute"
          style={{
            left: unit(box.x),
            top: unit(box.y),
            width: unit(box.width),
            height: unit(box.height),
          }}
        >
          <div
            className={`pointer-events-none absolute inset-0 border border-dashed transition-colors ${
              draft && 'box' in draft
                ? 'border-primary bg-primary/10'
                : 'border-white/25 group-hover/vbox:border-primary/80'
            }`}
          />
          {BOX_EDGES.map((edge) => (
            <div
              key={edge.at}
              role="button"
              aria-label={edge.label}
              title={edge.title}
              onPointerDown={(event) => dragVideoBox(event, 'move')}
              className={`pointer-events-auto absolute ${edge.at} cursor-move touch-none`}
            />
          ))}
          {BOX_CORNERS.map((corner) => (
            <span
              key={corner.handle}
              role="button"
              aria-label={`영상 화면 ${corner.label} 크기 조절`}
              title="드래그해서 영상 크기 조절"
              onPointerDown={(event) => dragVideoBox(event, corner.handle)}
              className={`pointer-events-auto absolute ${corner.at} h-3 w-3 ${corner.cursor} touch-none border border-white bg-primary opacity-75 hover:opacity-100`}
            />
          ))}
        </div>
      )}
      {headlineLines.length > 0 &&
        textBlock(
          'headline',
          headlineWidth,
          headlineStyle,
          '헤드라인',
          headlineLines,
          headlineEmpty,
          (line) =>
            props.onHit({kind: 'headline', line: shownLines[line]?.index ?? 0}),
        )}
      {caption &&
        textBlock(
          'caption',
          captionWidth,
          captionStyle,
          '자막',
          [{text: caption, color: captionStyle.color}],
          !props.caption,
          () => props.onHit({kind: 'caption'}),
        )}
      {images.map((image) => {
        const url = props.assetUrls.get(image.assetId);
        const selected = image.overlayId === props.selectedImageId;
        return (
          <div
            key={image.overlayId}
            role="button"
            aria-label="이미지 이동"
            title="드래그해서 옮기기, 눌러서 수정"
            onPointerDown={(event) => dragImage(event, image, 'move')}
            className={`pointer-events-auto absolute cursor-move touch-none select-none ${
              selected ? 'outline-2 outline-dashed outline-primary' : 'hover:outline-1 hover:outline-dashed hover:outline-white/60'
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
              <div className="grid h-full w-full place-items-center bg-surface-container-highest/80 text-[10px] font-normal text-on-surface-variant">
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
                  className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-primary"
                />
                <span
                  role="button"
                  aria-label="이미지 회전"
                  title="드래그해서 회전"
                  onPointerDown={(event) => dragImage(event, image, 'rotate')}
                  className="absolute -top-5 left-1/2 h-3 w-3 -translate-x-1/2 cursor-grab rounded-full border border-white bg-primary"
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
