/**
 * The bundled fonts in the browser. Each font file the render uses
 * (src/core/fonts.py) is registered as a FontFace under its own family
 * name, so the preview draws with the same file ffmpeg burns in.
 *
 * libass sizes a font so that one line box equals the ASS font size, while
 * CSS sizes the em; FontEntry.emPerLineBox (read from the font file by the
 * server) converts one into the other.
 */

import {useEffect} from 'react';

import type {FontEntry} from '../types';

const registered = new Map<string, FontFace>();

/** CSS family name the preview uses for a font id. */
export function cssFamily(fontId: string): string {
  return `ytf-${fontId}`;
}

/** CSS font-family value for a font id, with a fallback while it loads. */
export function fontStack(fontId: string): string {
  return `"${cssFamily(fontId)}", sans-serif`;
}

/** CSS font-size, in canvas units, of an ASS font size in this font. */
export function cssFontSize(entry: FontEntry | undefined, assSize: number): number {
  return assSize * (entry?.emPerLineBox ?? 1);
}

function register(entry: FontEntry): FontFace {
  const known = registered.get(entry.fontId);
  if (known) {
    return known;
  }
  // The file's own weight is the face; CSS never synthesizes bold on it.
  const face = new FontFace(cssFamily(entry.fontId), `url(${entry.url})`);
  document.fonts.add(face);
  registered.set(entry.fontId, face);
  return face;
}

/** Registers every font (lazily) and starts loading the ones in use. */
export function useFonts(fonts: readonly FontEntry[], inUse: readonly string[]): void {
  const key = inUse.join('|');
  useEffect(() => {
    const wanted = new Set(key.split('|'));
    for (const entry of fonts) {
      const face = register(entry);
      if (wanted.has(entry.fontId) && face.status === 'unloaded') {
        // A failed load leaves the fallback font; the text stays readable.
        face.load().catch(() => undefined);
      }
    }
  }, [fonts, key]);
}

/** Looks up fonts by id. */
export function fontMap(fonts: readonly FontEntry[]): ReadonlyMap<string, FontEntry> {
  return new Map(fonts.map((entry) => [entry.fontId, entry]));
}

/** #RRGGBB plus opacity as a CSS rgba() color. */
export function rgba(hex: string, opacity: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}
