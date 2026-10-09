/** Display formatting helpers. */

import type {YouTubePrivacy} from '../types';

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

/** Formats a length as m:ss, or h:mm:ss from one hour, e.g. "14:09". */
export function formatLength(seconds: number): string {
  const total = Math.round(Math.max(0, seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(secs)}`
    : `${minutes}:${pad2(secs)}`;
}

/** Formats a duration in words: "45초", "3분 12초", "1시간 2분". */
export function formatDuration(seconds: number): string {
  const total = Math.round(Math.max(0, seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  }
  if (minutes > 0) {
    return secs > 0 ? `${minutes}분 ${secs}초` : `${minutes}분`;
  }
  return `${secs}초`;
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formats an estimated cost in USD: "약 $0.21", or "$0.01 미만". */
export function formatCost(usd: number): string {
  return usd < 0.01 ? `${USD.format(0.01)} 미만` : `약 ${USD.format(usd)}`;
}

/** On-screen names of the YouTube privacy settings. */
export const PRIVACY_LABELS: Readonly<Record<YouTubePrivacy, string>> = {
  private: '비공개',
  unlisted: '일부 공개',
  public: '공개',
};
