/**
 * Template geometry for the canvas preview.
 *
 * cropRect, fitAspect and videoBox mirror crop_rect, fit_aspect and
 * video_box in src/render/layout.py, so the preview frames exactly what
 * ffmpeg renders.
 */

import {clamp} from './timeline';
import type {
  CropRegion,
  FramingLayout,
  LookStyle,
  TemplateStyle,
  VideoBoxSpec,
  VideoFit,
} from '../types';

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

function evenFloor(value: number): number {
  return Math.floor(value / 2) * 2;
}

/**
 * Smallest width and height of a custom video box in canvas units. 말로
 * 편집 checks the same minimum on the server (_MIN_VIDEO_BOX in
 * src/edit_agent.py).
 */
export const MIN_VIDEO_BOX = 120;

/** Clamps a custom VideoBoxSpec to valid even-floored canvas bounds. */
export function clampVideoBox(
  style: TemplateStyle,
  spec: VideoBoxSpec,
): VideoBoxSpec {
  const width = clamp(evenFloor(spec.width), MIN_VIDEO_BOX, evenFloor(style.canvasWidth));
  const height = clamp(evenFloor(spec.height), MIN_VIDEO_BOX, evenFloor(style.canvasHeight));
  const x = clamp(evenFloor(spec.x), 0, evenFloor(style.canvasWidth - width));
  const y = clamp(evenFloor(spec.y), 0, evenFloor(style.canvasHeight - height));
  return {x, y, width, height};
}

/** Width / height of the area the video fills. */
export function fitAspect(
  style: TemplateStyle,
  framing: FramingLayout | VideoFit,
): number {
  const fit = typeof framing === 'string' ? framing : framing.fit;
  if (fit === 'full') {
    return style.canvasWidth / style.canvasHeight;
  }
  if (typeof framing !== 'string' && framing.box) {
    const clamped = clampVideoBox(style, framing.box);
    return clamped.width / clamped.height;
  }
  return style.boxAspectRatio;
}

/**
 * Returns the crop of `source` for a target aspect ratio (width / height).
 * The largest rectangle of that aspect is shrunk by zoom around the center
 * and clamped to the frame.
 */
export function cropRect(region: CropRegion, aspect: number, source: Size): Rect {
  const wide = source.width / source.height > aspect;
  const baseWidth = wide ? source.height * aspect : source.width;
  const baseHeight = wide ? source.height : source.width / aspect;
  const width = Math.max(2, evenFloor(baseWidth / region.zoom));
  const height = Math.max(2, evenFloor(baseHeight / region.zoom));
  const x = Math.min(
    Math.max(region.centerX * source.width - width / 2, 0),
    source.width - width,
  );
  const y = Math.min(
    Math.max(region.centerY * source.height - height / 2, 0),
    source.height - height,
  );
  return {x: evenFloor(x), y: evenFloor(y), width, height};
}

/**
 * Returns the area the video fills in pixels of an output `width` pixels
 * wide: the custom or default box, or the whole output for a 'full' fit.
 */
export function videoBox(
  style: TemplateStyle,
  width: number,
  framing: FramingLayout | VideoFit = 'box',
): Rect {
  const scale = width / style.canvasWidth;
  const outHeight = evenFloor(style.canvasHeight * scale);
  const fit = typeof framing === 'string' ? framing : framing.fit;
  if (fit === 'full') {
    return {x: 0, y: 0, width, height: outHeight};
  }
  if (typeof framing !== 'string' && framing.box) {
    const custom = clampVideoBox(style, framing.box);
    const boxWidth = clamp(evenFloor(custom.width * scale), 2, width);
    const boxHeight = clamp(evenFloor(custom.height * scale), 2, outHeight);
    const boxX = clamp(evenFloor(custom.x * scale), 0, width - boxWidth);
    const boxY = clamp(evenFloor(custom.y * scale), 0, outHeight - boxHeight);
    return {x: boxX, y: boxY, width: boxWidth, height: boxHeight};
  }
  const boxWidth = evenFloor((style.canvasWidth - 2 * style.boxSideMargin) * scale);
  const boxHeight = evenFloor(boxWidth / style.boxAspectRatio);
  return {
    x: evenFloor((width - boxWidth) / 2),
    y: evenFloor(style.boxCenterY * scale - boxHeight / 2),
    width: boxWidth,
    height: boxHeight,
  };
}

/** Border ring width in output pixels; 0 when there is no border. */
export function borderWidth(
  lookStyle: LookStyle,
  framing: FramingLayout,
  style: TemplateStyle,
  width: number,
): number {
  return framing.fit === 'box' && lookStyle.border
    ? (lookStyle.borderWidth * width) / style.canvasWidth
    : 0;
}

/**
 * Draws one video frame into the template on a canvas of `output` size:
 * background color, the cropped video in its square-cornered box, and the
 * border ring (as composer.build_ass draws it: outside the box).
 */
export function drawFrame(input: {
  context: CanvasRenderingContext2D;
  image: CanvasImageSource;
  framing: FramingLayout;
  lookStyle: LookStyle;
  style: TemplateStyle;
  source: Size;
  output: Size;
}): void {
  const {context, image, framing, lookStyle, style, source, output} = input;
  const box = videoBox(style, output.width, framing);
  const from = cropRect(framing.crop, fitAspect(style, framing), source);
  context.fillStyle = lookStyle.backgroundColor;
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(
    image,
    from.x,
    from.y,
    from.width,
    from.height,
    box.x,
    box.y,
    box.width,
    box.height,
  );
  const ring = borderWidth(lookStyle, framing, style, output.width);
  if (ring > 0) {
    context.beginPath();
    context.rect(
      box.x - ring,
      box.y - ring,
      box.width + 2 * ring,
      box.height + 2 * ring,
    );
    context.rect(box.x, box.y, box.width, box.height);
    context.fillStyle = lookStyle.borderColor;
    context.fill('evenodd');
  }
}
