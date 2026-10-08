/**
 * Runs the agentic analysis and keeps what the screens show while it runs:
 * the server's current stage, the latest thought line and the start time.
 */

import {useCallback, useEffect, useRef, useState} from 'react';

import {analyze, errorMessage} from '../lib/api';
import type {AnalysisResult, AnalyzeEvent, AnalyzeRequest} from '../types';

export interface AnalysisProgress {
  /** Stage of the latest progress event; '' before the first one. */
  stage: string;
  /** First line of the latest thought summary, without Markdown marks. */
  thought: string;
  /** Date.now() when the run started; the elapsed time counts from here. */
  startedAt: number;
}

export type AnalysisState =
  | {status: 'idle'}
  | {status: 'running'; progress: AnalysisProgress}
  | {status: 'failed'; error: string};

/** The first non-empty line of a thought summary, without `**` and `#`. */
function thoughtLine(text: string): string {
  for (const line of text.split('\n')) {
    const plain = line.replaceAll('**', '').replaceAll('#', '').trim();
    if (plain) {
      return plain;
    }
  }
  return '';
}

function withProgress(
  progress: AnalysisProgress,
  event: Extract<AnalyzeEvent, {type: 'progress'}>,
): AnalysisProgress {
  if (event.stage === 'thought') {
    const thought = thoughtLine(event.message);
    return thought ? {...progress, thought} : progress;
  }
  // A new Gemini attempt starts thinking from scratch.
  const fresh = event.stage === 'gemini' || event.stage === 'retry';
  return {...progress, stage: event.stage, thought: fresh ? '' : progress.thought};
}

export function useAnalysis(onResult: (result: AnalysisResult) => void) {
  const [state, setState] = useState<AnalysisState>({status: 'idle'});
  // The running request; a run whose controller was replaced or cleared
  // no longer touches the state.
  const controller = useRef<AbortController | null>(null);

  const start = useCallback(
    async (request: AnalyzeRequest) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const isCurrent = () => controller.current === abort;
      const finish = (next: AnalysisState) => {
        controller.current = null;
        setState(next);
      };
      let progress: AnalysisProgress = {stage: '', thought: '', startedAt: Date.now()};
      setState({status: 'running', progress});
      const onEvent = (event: AnalyzeEvent) => {
        if (!isCurrent()) {
          return;
        }
        switch (event.type) {
          case 'progress':
            progress = withProgress(progress, event);
            setState({status: 'running', progress});
            break;
          case 'heartbeat':
            break;
          case 'result':
            finish({status: 'idle'});
            onResult(event.result);
            break;
          case 'error':
            finish({status: 'failed', error: event.error});
            break;
          default: {
            const unhandled: never = event;
            throw new Error(`Unhandled event ${JSON.stringify(unhandled)}`);
          }
        }
      };
      try {
        await analyze(request, onEvent, abort.signal);
        if (isCurrent()) {
          finish({
            status: 'failed',
            error: '분석 스트림이 결과 없이 끝났습니다. 서버 로그를 확인하세요.',
          });
        }
      } catch (error) {
        if (isCurrent()) {
          finish({status: 'failed', error: errorMessage(error)});
        }
      }
    },
    [onResult],
  );

  /** Stops the running analysis; the state is idle at once. */
  const cancel = useCallback(() => {
    const running = controller.current;
    controller.current = null;
    running?.abort();
    setState({status: 'idle'});
  }, []);

  /** Clears a failure after its message was shown. */
  const dismiss = useCallback(() => {
    setState((current) => (current.status === 'failed' ? {status: 'idle'} : current));
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  return {state, start, cancel, dismiss};
}
