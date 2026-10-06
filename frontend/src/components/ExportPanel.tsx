/**
 * Getting the edit out: upload the Source Video MP4, render the plan on the
 * server, or export an ffmpeg command with ASS/SRT captions to run
 * elsewhere.
 */

import {Check, Copy, Download, Upload, X} from 'lucide-react';
import {useCallback, useRef, useState} from 'react';

import type {UploadState} from '../hooks/useSourceUpload';
import {errorMessage, exportPlan, renderPlan} from '../lib/api';
import {formatMegabytes, formatSeconds} from '../lib/format';
import type {
  ExportOutput,
  MediaInfo,
  RenderOutput,
  RenderPlan,
  RenderQuality,
  SourceVideo,
  StudioConfig,
} from '../types';
import {IconButton, Panel, TextButton} from './ui';

// Measured stream lengths may differ from the plan by container padding;
// more than this many frames is flagged.
const DURATION_FLAG_FRAMES = 2;

type Job<T> =
  | {status: 'idle'}
  | {status: 'running'; planKey: string; label: string}
  | {status: 'done'; planKey: string; label: string; output: T}
  | {status: 'failed'; planKey: string; label: string; error: string};

/** Runs one request at a time; a newer run wins over a late older one. */
function useJob<T>() {
  const [job, setJob] = useState<Job<T>>({status: 'idle'});
  const latest = useRef(0);
  const run = useCallback(
    (planKey: string, label: string, task: () => Promise<T>) => {
      const id = ++latest.current;
      setJob({status: 'running', planKey, label});
      task().then(
        (output) => {
          if (latest.current === id) {
            setJob({status: 'done', planKey, label, output});
          }
        },
        (error: unknown) => {
          if (latest.current === id) {
            setJob({status: 'failed', planKey, label, error: errorMessage(error)});
          }
        },
      );
    },
    [],
  );
  return {job, run};
}

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], {type: 'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function JobHeader(props: {job: Job<unknown>; planKey: string}) {
  const {job} = props;
  if (job.status === 'idle') {
    return null;
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
      <span>시나리오: {job.label}</span>
      {job.planKey !== props.planKey && (
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-300">
          그 뒤로 편집이 바뀌었습니다. 다시 실행하세요.
        </span>
      )}
    </p>
  );
}

function UploadSection(props: {
  upload: UploadState;
  sourceVideo: SourceVideo;
  toleranceSec: number;
  onUpload: (file: File) => void;
  onClear: () => void;
}) {
  const {upload, sourceVideo} = props;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-zinc-200">원본 MP4</h3>
        {upload.status !== 'empty' && (
          <IconButton label="업로드 취소·제거" onClick={props.onClear}>
            <X size={14} />
          </IconButton>
        )}
      </div>
      <p className="text-[11px] text-zinc-400">
        서버는 YouTube에서 영상을 직접 받지 않습니다. 렌더하려면 같은 영상의 MP4를
        올리세요. 올리면 실제 무음 구간을 측정해 점프컷에 반영하고, 미리보기도 9:16
        화면으로 바뀝니다.
      </p>
      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800">
        <Upload size={14} />
        {upload.status === 'empty' ? 'MP4 선택' : '다른 파일 선택'}
        <input
          type="file"
          accept="video/mp4,video/*"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) {
              props.onUpload(file);
            }
          }}
        />
      </label>
      {upload.status === 'uploading' && (
        <div className="space-y-1">
          <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
            <div
              className="h-full bg-indigo-500"
              style={{width: `${(upload.loadedBytes / Math.max(1, upload.file.size)) * 100}%`}}
            />
          </div>
          <p className="text-[11px] text-zinc-400">
            {upload.loadedBytes >= upload.file.size
              ? '업로드 완료. 서버에서 길이와 무음 구간을 측정하고 있습니다.'
              : `${formatMegabytes(upload.loadedBytes)} / ${formatMegabytes(upload.file.size)}`}
          </p>
        </div>
      )}
      {upload.status === 'failed' && (
        <p className="text-xs text-red-400">업로드 실패: {upload.error}</p>
      )}
      {upload.status === 'ready' && (
        <div className="space-y-1 text-[11px] text-zinc-300">
          <p>
            {upload.source.filename} · {formatMegabytes(upload.source.sizeBytes)} ·{' '}
            {formatSeconds(upload.source.media.durationSec)} ·{' '}
            {upload.source.media.width}×{upload.source.media.height} ·{' '}
            {upload.source.media.fps.toFixed(2)}fps · 무음 {upload.source.silences.length}곳
          </p>
          {sourceVideo.durationSec > 0 &&
            Math.abs(upload.source.media.durationSec - sourceVideo.durationSec) >
              props.toleranceSec && (
              <p className="text-amber-300">
                업로드한 파일 길이({formatSeconds(upload.source.media.durationSec)})가 분석한
                영상 길이({formatSeconds(sourceVideo.durationSec)})와 다릅니다. 같은 영상인지
                확인하세요. 다르면 컷 위치가 어긋납니다.
              </p>
            )}
          {!upload.source.hasAudio && (
            <p className="text-amber-300">
              오디오 트랙이 없습니다. 원본 음성이 없으면 숏폼에 소리가 들어가지 않습니다.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function RenderResult(props: {output: RenderOutput; frameSec: number; filename: string}) {
  const {output, frameSec} = props;
  const flagged = (measured: number) =>
    frameSec > 0 &&
    Math.abs(measured - output.plannedDurationSec) > DURATION_FLAG_FRAMES * frameSec;
  const duration = (label: string, value: number, check: boolean) => (
    <span className={check && flagged(value) ? 'text-amber-300' : undefined}>
      {label} {value.toFixed(2)}초
    </span>
  );
  return (
    <div className="space-y-2">
      <video
        src={output.videoUrl}
        controls
        playsInline
        className="mx-auto w-full max-w-[240px] rounded-lg bg-black"
      />
      <p className="flex flex-wrap gap-x-3 text-[11px] text-zinc-400">
        {duration('계획', output.plannedDurationSec, false)}
        {duration('영상', output.measuredVideoSec, true)}
        {duration('음성', output.measuredAudioSec, true)}
        <span>렌더 {formatSeconds(output.elapsedSec)}</span>
      </p>
      <a
        href={output.videoUrl}
        download={props.filename}
        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
      >
        <Download size={14} />
        MP4 받기
      </a>
    </div>
  );
}

function RenderJob(props: {
  quality: RenderQuality;
  config: StudioConfig;
  sourceId: string | null;
  plan: RenderPlan | null;
  planKey: string;
  scenarioTitle: string;
  frameSec: number;
  filename: string;
}) {
  const {quality, plan, sourceId} = props;
  const {job, run} = useJob<RenderOutput>();
  const profile = props.config.renderProfiles[quality];
  const label = quality === 'preview' ? '미리보기 렌더' : '최종 렌더';
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <TextButton
        tone={quality === 'final' ? 'primary' : 'plain'}
        disabled={!plan || !sourceId || job.status === 'running'}
        onClick={() =>
          plan &&
          sourceId &&
          run(props.planKey, props.scenarioTitle, () => renderPlan({sourceId, quality, plan}))
        }
      >
        {label} {profile.width}×{profile.height}
      </TextButton>
      <JobHeader job={job} planKey={props.planKey} />
      {job.status === 'running' && (
        <p className="text-[11px] text-zinc-400">
          ffmpeg로 렌더하고 있습니다. 영상 길이에 따라 수십 초 이상 걸립니다.
        </p>
      )}
      {job.status === 'failed' && <p className="text-xs text-red-400">{job.error}</p>}
      {job.status === 'done' && (
        <RenderResult output={job.output} frameSec={props.frameSec} filename={props.filename} />
      )}
    </div>
  );
}

function ExportJob(props: {
  media: MediaInfo | null;
  sourceFilename: string;
  plan: RenderPlan | null;
  planKey: string;
  scenarioTitle: string;
  baseName: string;
}) {
  const {media, plan, sourceFilename} = props;
  const {job, run} = useJob<ExportOutput>();
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <TextButton
        disabled={!plan || !media || job.status === 'running'}
        onClick={() => {
          setCopied(false);
          if (plan && media) {
            run(props.planKey, props.scenarioTitle, () =>
              exportPlan({media, sourceFilename, quality: 'final', plan}),
            );
          }
        }}
      >
        ffmpeg 명령과 자막 파일 받기
      </TextButton>
      {!media && (
        <p className="text-[11px] text-zinc-400">
          원본 해상도·fps를 알 수 없어 명령을 만들 수 없습니다. MP4를 올리면 가능합니다.
        </p>
      )}
      <JobHeader job={job} planKey={props.planKey} />
      {job.status === 'running' && <p className="text-[11px] text-zinc-400">만드는 중…</p>}
      {job.status === 'failed' && <p className="text-xs text-red-400">{job.error}</p>}
      {job.status === 'done' && (
        <div className="space-y-2">
          <div className="relative">
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-zinc-950 p-2 pr-8 font-mono text-[10px] text-zinc-300">
              {job.output.ffmpegCommand}
            </pre>
            <div className="absolute right-1 top-1">
              <IconButton label="명령 복사" onClick={() => copy(job.output.ffmpegCommand)}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </IconButton>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <TextButton onClick={() => downloadText(job.output.assFilename, job.output.ass)}>
              <Download size={14} />
              {job.output.assFilename}
            </TextButton>
            <TextButton
              onClick={() => downloadText(`${props.baseName}.srt`, job.output.srt)}
            >
              <Download size={14} />
              SRT
            </TextButton>
          </div>
          <p className="text-[11px] text-zinc-400">
            명령은 원본 파일({sourceFilename})과 {job.output.assFilename}이 같은 폴더에 있다고
            가정합니다. 예상 길이 {formatSeconds(job.output.plannedDurationSec)}.
          </p>
        </div>
      )}
    </div>
  );
}

export function ExportPanel(props: {
  config: StudioConfig;
  sourceVideo: SourceVideo;
  plan: RenderPlan | null;
  scenarioTitle: string;
  upload: UploadState;
  onUpload: (file: File) => void;
  onClearUpload: () => void;
}) {
  const {config, sourceVideo, plan, upload} = props;
  const planKey = JSON.stringify(plan);
  const ready = upload.status === 'ready' ? upload.source : null;
  const known =
    sourceVideo.fps > 0 && sourceVideo.width > 0 && sourceVideo.height > 0;
  const media: MediaInfo | null =
    ready?.media ??
    (known
      ? {
          durationSec: sourceVideo.durationSec,
          fps: sourceVideo.fps,
          width: sourceVideo.width,
          height: sourceVideo.height,
        }
      : null);
  const frameSec = media && media.fps > 0 ? 1 / media.fps : 0;
  const baseName = `${sourceVideo.videoId}-${props.scenarioTitle}`;
  return (
    <Panel title="업로드 · 렌더 · 내보내기">
      <div className="space-y-4">
        <UploadSection
          upload={upload}
          sourceVideo={sourceVideo}
          toleranceSec={config.composition.durationToleranceSec}
          onUpload={props.onUpload}
          onClear={props.onClearUpload}
        />
        {!plan && (
          <p className="text-xs text-amber-300">
            재생할 Subcut이 없어 렌더하거나 내보낼 수 없습니다.
          </p>
        )}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-zinc-200">서버 렌더</h3>
          {!ready && (
            <p className="text-[11px] text-zinc-400">MP4 업로드가 끝나면 렌더할 수 있습니다.</p>
          )}
          {config.fontWarning && (
            <p className="text-[11px] text-amber-300">{config.fontWarning}</p>
          )}
          {(['preview', 'final'] as const).map((quality) => (
            <RenderJob
              key={quality}
              quality={quality}
              config={config}
              sourceId={ready?.sourceId ?? null}
              plan={plan}
              planKey={planKey}
              scenarioTitle={props.scenarioTitle}
              frameSec={frameSec}
              filename={`${baseName}-${quality}.mp4`}
            />
          ))}
        </section>
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-zinc-200">다른 곳에서 렌더</h3>
          <ExportJob
            media={media}
            sourceFilename={ready?.filename ?? `${sourceVideo.videoId}.mp4`}
            plan={plan}
            planKey={planKey}
            scenarioTitle={props.scenarioTitle}
            baseName={baseName}
          />
        </section>
      </div>
    </Panel>
  );
}
