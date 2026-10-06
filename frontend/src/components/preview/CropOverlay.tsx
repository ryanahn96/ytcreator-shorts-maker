/**
 * Outlines the source region the video box keeps, drawn over anything that
 * shows the full source frame (the source thumbnail).
 */

import {cropRect, type Size} from '../../lib/framing';
import type {CropRegion} from '../../types';

export function CropOverlay(props: {crop: CropRegion; aspect: number; source: Size}) {
  const rect = cropRect(props.crop, props.aspect, props.source);
  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  return (
    <div className="pointer-events-none absolute inset-0">
      <div
        className="absolute border-2 border-amber-300 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
        style={{
          left: percent(rect.x, props.source.width),
          top: percent(rect.y, props.source.height),
          width: percent(rect.width, props.source.width),
          height: percent(rect.height, props.source.height),
        }}
      />
    </div>
  );
}
