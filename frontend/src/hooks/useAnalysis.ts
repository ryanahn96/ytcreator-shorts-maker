/** Runs the agentic analysis and tracks its streamed progress. */

import {useCallback, useEffect, useRef, useState} from 'react';

import {analyze, errorMessage} from '../lib/api';
import type {AnalysisResult, AnalyzeEvent, AnalyzeRequest} from '../types';

// Progress lines kept on screen; older ones scroll away.
const MAX_PROGRESS_LINES = 40;

export interface ProgressLine {
  id: number;
  stage: string;
  message: string;
  elapsedSec: number;
}

export interface AnalysisProgress {
  lines: ProgressLine[];
  agenticSteps: number;
  elapsedSec: number;
  model: string;
  /** Latest thought summary Gemini streamed, if any. */
  thought: string;
}

export type AnalysisState =
  | {status: 'idle'}
  | {status: 'running'; progress: AnalysisProgress}
  | {status: 'succeeded'; progress: AnalysisProgress}
  | {status: 'failed'; progress: AnalysisProgress; error: string};

const EMPTY_PROGRESS: AnalysisProgress = {
  lines: [],
  agenticSteps: 0,
  elapsedSec: 0,
  model: '',
  thought: '',
};

function withProgress(
  progress: AnalysisProgress,
  event: Extract<AnalyzeEvent, {type: 'progress'}>,
): AnalysisProgress {
  const next = {
    ...progress,
    elapsedSec: event.elapsedSec,
    model: event.model ?? progress.model,
    agenticSteps: event.agenticSteps ?? progress.agenticSteps,
  };
  if (event.stage === 'thought') {
    return {...next, thought: event.message};
  }
  const line: ProgressLine = {
    id: (progress.lines.at(-1)?.id ?? 0) + 1,
    stage: event.stage,
    message: event.message,
    elapsedSec: event.elapsedSec,
  };
  return {...next, lines: [...progress.lines, line].slice(-MAX_PROGRESS_LINES)};
}

export function useAnalysis(onResult: (result: AnalysisResult) => void) {
  const [state, setState] = useState<AnalysisState>({status: 'idle'});
  const controller = useRef<AbortController | null>(null);

  const start = useCallback(
    async (request: AnalyzeRequest) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      let progress = EMPTY_PROGRESS;
      let finished = false;
      setState({status: 'running', progress});
      const onEvent = (event: AnalyzeEvent) => {
        switch (event.type) {
          case 'progress':
            progress = withProgress(progress, event);
            setState({status: 'running', progress});
            break;
          case 'heartbeat':
            progress = {...progress, elapsedSec: event.elapsedSec};
            setState({status: 'running', progress});
            break;
          case 'result':
            finished = true;
            onResult(event.result);
            setState({status: 'succeeded', progress});
            break;
          case 'error':
            finished = true;
            setState({status: 'failed', progress, error: event.error});
            break;
          default: {
            const unhandled: never = event;
            throw new Error(`Unhandled event ${JSON.stringify(unhandled)}`);
          }
        }
      };
      try {
        await analyze(request, onEvent, abort.signal);
        if (!finished) {
          setState({
            status: 'failed',
            progress,
            error: '분석 스트림이 결과 없이 끝났습니다. 서버 로그를 확인하세요.',
          });
        }
      } catch (error) {
        if (abort.signal.aborted) {
          setState({status: 'idle'});
        } else {
          setState({status: 'failed', progress, error: errorMessage(error)});
        }
      }
    },
    [onResult],
  );

  const cancel = useCallback(() => controller.current?.abort(), []);

  useEffect(() => () => controller.current?.abort(), []);

  return {state, start, cancel};
}
