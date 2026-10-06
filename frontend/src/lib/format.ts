/** Display formatting helpers. */

import type {GeminiBackend} from '../types';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Formats seconds as mm:ss.s, or h:mm:ss.s from one hour. */
export function formatClock(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const secs = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${secs}`
    : `${pad2(minutes)}:${secs}`;
}

/** Formats a duration in seconds with one decimal, e.g. "12.3초". */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}초`;
}

/** Formats a byte count in MB. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Names the Gemini backend the server calls. */
export function geminiBackendLabel(backend: GeminiBackend): string {
  switch (backend) {
    case 'ai_studio':
      return 'Gemini API';
    case 'vertex':
      return 'Vertex AI';
  }
}
