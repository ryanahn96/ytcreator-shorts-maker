/**
 * Where the Source Video comes from (a YouTube URL or a video file) and the
 * live progress of the agentic analysis. Pressing analyze again after a
 * result re-runs Gemini with the current Editorial Prompt.
 */

import {FileVideo, Link, Loader2, RefreshCw, Sparkles, Square, Upload} from 'lucide-react';

import type {AnalysisState} from '../hooks/useAnalysis';
import type {UploadState} from '../hooks/useSourceUpload';
import {formatMegabytes, formatSeconds} from '../lib/format';
import {Panel, TextButton} from './ui';

export type SourceMode = 'youtube' | 'file';

const MODES: {mode: SourceMode; label: string; icon: typeof Link}[] = [
  {mode: 'youtube', label: 'YouTube URL', icon: Link},
  {mode: 'file', label: '영상 파일', icon: FileVideo},
];

function FileStatus(props: {upload: UploadState}) {
  const {upload} = props;
  switch (upload.status) {
    case 'empty':
      return <span className="text-zinc-500">선택한 파일 없음</span>;
    case 'uploading':
      return (
        <span className="text-zinc-400">
          {upload.loadedBytes >= upload.file.size
            ? '서버에서 길이와 무음 구간을 측정하는 중…'
            : `올리는 중 ${formatMegabytes(upload.loadedBytes)} / ${formatMegabytes(upload.file.size)}`}
        </span>
      );
    case 'failed':
      return <span className="text-red-400">업로드 실패: {upload.error}</span>;
    case 'ready':
      return (
        <span className="text-zinc-300">
          {upload.source.filename} · {formatSeconds(upload.source.media.durationSec)} ·{' '}
          {upload.source.media.width}×{upload.source.media.height}
        </span>
      );
    default: {
      const unhandled: never = upload;
      return unhandled;
    }
  }
}

function ProgressView(props: {state: Exclude<AnalysisState, {status: 'idle'}>}) {
  const {state} = props;
  const {progress} = state;
  const facts = [
    `경과 ${formatSeconds(progress.elapsedSec)}`,
    progress.model && `모델 ${progress.model}`,
    progress.agenticSteps > 0 && `에이전틱 단계 ${progress.agenticSteps}`,
  ].filter(Boolean);
  return (
    <div className="mt-3 space-y-2">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-300">
        {state.status === 'running' && (
          <Loader2 size={14} className="animate-spin text-indigo-400" />
        )}
        <span className="font-semibold">
          {state.status === 'running'
            ? '분석 중'
            : state.status === 'succeeded'
              ? '분석 완료'
              : '분석 실패'}
        </span>
        {facts.map((fact) => (
          <span key={String(fact)} className="text-zinc-400">
            {fact}
          </span>
        ))}
      </p>
      {state.status === 'failed' && (
        <p className="whitespace-pre-wrap rounded-md border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">
          {state.error}
        </p>
      )}
      {progress.thought && state.status === 'running' && (
        <p className="line-clamp-3 text-[11px] italic text-zinc-400">
          Gemini 생각 요약: {progress.thought}
        </p>
      )}
      {progress.lines.length > 0 && (
        <ol className="max-h-40 space-y-0.5 overflow-y-auto font-mono text-[11px] text-zinc-400">
          {progress.lines.map((line) => (
            <li key={line.id}>
              <span className="text-zinc-600">{line.elapsedSec.toFixed(0).padStart(3)}s</span>{' '}
              {line.message}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function SourceInput(props: {
  mode: SourceMode;
  onModeChange: (mode: SourceMode) => void;
  url: string;
  onUrlChange: (url: string) => void;
  /** The video file chosen for analysis (also the render source). */
  fileUpload: UploadState;
  onPickFile: (file: File) => void;
  /** True once an analysis result is on screen. */
  hasResult: boolean;
  onAnalyze: () => void;
  onCancel: () => void;
  analysis: AnalysisState;
  /** Non-empty when the server cannot call Gemini. */
  geminiSetupError: string;
}) {
  const {analysis, mode} = props;
  const running = analysis.status === 'running';
  const hasSource =
    mode === 'youtube' ? props.url.trim() !== '' : props.fileUpload.status === 'ready';
  const ready = hasSource && props.geminiSetupError === '' && !running;
  return (
    <Panel title="원본 영상">
      <div role="tablist" aria-label="원본 영상 종류" className="mb-3 flex gap-1">
        {MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            role="tab"
            aria-selected={mode === item.mode}
            disabled={running}
            onClick={() => props.onModeChange(item.mode)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40 ${
              mode === item.mode
                ? 'bg-zinc-100 text-zinc-900'
                : 'text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            <item.icon size={14} />
            {item.label}
          </button>
        ))}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            props.onAnalyze();
          }
        }}
      >
        {mode === 'youtube' ? (
          <input
            type="url"
            value={props.url}
            onChange={(event) => props.onUrlChange(event.target.value)}
            placeholder="YouTube 영상 URL"
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
            <label
              className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 font-semibold text-zinc-200 hover:bg-zinc-800 ${
                running ? 'pointer-events-none opacity-40' : ''
              }`}
            >
              <Upload size={14} />
              파일 선택
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/*"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) {
                    props.onPickFile(file);
                  }
                }}
              />
            </label>
            <span className="min-w-0 truncate">
              <FileStatus upload={props.fileUpload} />
            </span>
          </div>
        )}
        {running ? (
          <TextButton onClick={props.onCancel}>
            <Square size={14} />
            중단
          </TextButton>
        ) : (
          <button
            type="submit"
            disabled={!ready}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {props.hasResult ? <RefreshCw size={14} /> : <Sparkles size={14} />}
            {props.hasResult ? '다시 분석' : '분석'}
          </button>
        )}
      </form>
      {props.geminiSetupError && (
        <p className="mt-2 text-xs text-amber-300">
          분석할 수 없습니다: {props.geminiSetupError}
        </p>
      )}
      <p className="mt-2 text-[11px] text-zinc-500">
        Gemini가 영상을 에이전틱 모드(MediaProcessing.AGENTIC)로 직접 보고 자막과 함께
        시나리오와 Clip 구간을 정합니다. 10~20분 영상 기준 1~3분 정도 걸립니다.
        {mode === 'file' &&
          ' 영상 파일은 자막이 없으므로 Gemini가 고른 구간을 받아쓰고, 올린 파일은 그대로 렌더 원본으로 씁니다.'}
      </p>
      {props.hasResult && (
        <p className="mt-1 text-[11px] text-zinc-400">
          결과가 마음에 들지 않으면 오른쪽 Editorial Prompt를 고친 뒤 다시 분석하세요. 새 결과가
          올 때까지 지금 편집 화면은 그대로 남습니다.
        </p>
      )}
      {analysis.status !== 'idle' && <ProgressView state={analysis} />}
    </Panel>
  );
}
