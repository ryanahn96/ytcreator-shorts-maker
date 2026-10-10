/**
 * The screen shown while Gemini analyzes the Source Video: an animated orb,
 * one plain status line, the elapsed time and a stop button.
 */

import {useEffect, useState} from 'react';

import type {AnalysisProgress} from '../hooks/useAnalysis';
import {formatLength} from '../lib/format';
import {BrandMark} from './Icon';
import {Button} from './ui';

/** A plain status line for a server progress stage (src/gemini/director.py). */
export function statusLine(stage: string): string {
  switch (stage) {
    case 'gemini':
      return 'Gemini가 영상을 보고 있어요';
    case 'validate':
      return 'Shorts를 정리하고 있어요';
    case 'retry':
      return '다시 시도하고 있어요';
    default:
      // '' before the first event, 'proxy', 'captions' and any new stage.
      return '영상을 준비하고 있어요';
  }
}

/** Seconds since `startedAt` (a Date.now() value), updated every second. */
export function useElapsedSec(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, (now - startedAt) / 1000);
}

export function AnalyzingScreen(props: {
  progress: AnalysisProgress;
  onCancel: () => void;
}) {
  const {progress} = props;
  const elapsedSec = useElapsedSec(progress.startedAt);
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 px-6 pb-[10vh] text-center">
      <div className="analysis-orb" aria-hidden>
        <span className="analysis-orb-glow" />
        <span className="analysis-orb-ring" />
        {/* Positioned so it paints above the positioned glow and ring. */}
        <span className="relative">
          <BrandMark size={56} />
        </span>
      </div>
      <div className="flex w-full max-w-xl flex-col items-center gap-2">
        <p aria-live="polite" className="text-2xl text-on-surface">
          {statusLine(progress.stage)}
        </p>
        <p className="text-sm text-on-surface-variant tabular-nums">
          {formatLength(elapsedSec)}
        </p>
      </div>
      <Button variant="outlined" onClick={props.onCancel}>
        중단
      </Button>
    </main>
  );
}
