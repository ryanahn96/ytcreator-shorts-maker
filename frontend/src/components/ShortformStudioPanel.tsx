/**
 * The studio: Source Video (YouTube URL or file) and Editorial Prompt on
 * top, then the workspace of the latest analysis. A re-analysis keeps the
 * previous workspace on screen until its result arrives.
 */

import {useCallback, useState} from 'react';

import {useAnalysis} from '../hooks/useAnalysis';
import {useAssets} from '../hooks/useAssets';
import {useSourceUpload} from '../hooks/useSourceUpload';
import type {AnalysisResult, StudioConfig} from '../types';
import {PromptEditor} from './PromptEditor';
import {ScenarioWorkspace} from './ScenarioWorkspace';
import {SourceInput, type SourceMode} from './SourceInput';
import {Panel} from './ui';

interface Session {
  /** Remounts the workspace, which resets its editor state. */
  id: number;
  result: AnalysisResult;
}

function EmptyGuide() {
  const steps = [
    '10~20분 길이의 정보성 YouTube 영상 URL을 넣거나 영상 파일을 올리고 분석을 누릅니다.',
    '필요하면 Editorial Prompt로 어떤 장면을 고를지 기준을 바꾸고 다시 분석합니다.',
    'Gemini가 제안한 시나리오별로 Clip 구간, 삭제할 단어, 자막, 레이아웃을 다듬습니다.',
    '글 위치, 이미지, 배경음악을 더하고 미리보기에서 드래그로 배치합니다.',
    'YouTube로 분석했다면 같은 영상의 MP4를 올려 9:16으로 미리 보고 서버에서 렌더합니다.',
  ];
  return (
    <Panel title="사용 순서">
      <ol className="list-decimal space-y-1 pl-5 text-xs text-zinc-300">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </Panel>
  );
}

export function ShortformStudioPanel(props: {config: StudioConfig}) {
  const {config} = props;
  const [mode, setMode] = useState<SourceMode>('youtube');
  const [url, setUrl] = useState('');
  const [prompt, setPrompt] = useState(config.defaultEditorialPrompt);
  const [session, setSession] = useState<Session | null>(null);
  const onResult = useCallback(
    (result: AnalysisResult) =>
      setSession((current) => ({id: (current?.id ?? 0) + 1, result})),
    [],
  );
  const analysis = useAnalysis(onResult);
  const upload = useSourceUpload();
  const assets = useAssets();
  const running = analysis.state.status === 'running';
  const analyzedFile = mode === 'file' && upload.state.status === 'ready' ? upload.state.source : null;

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <SourceInput
          mode={mode}
          onModeChange={setMode}
          url={url}
          onUrlChange={setUrl}
          fileUpload={mode === 'file' ? upload.state : {status: 'empty'}}
          // The upload id becomes the video id of a file analysis.
          onPickFile={(file) => upload.upload(file, '')}
          hasResult={session !== null}
          onAnalyze={() =>
            analysis.start(
              analyzedFile
                ? {youtubeUrl: '', sourceId: analyzedFile.sourceId, editorialPrompt: prompt}
                : {youtubeUrl: url.trim(), sourceId: '', editorialPrompt: prompt},
            )
          }
          onCancel={analysis.cancel}
          analysis={analysis.state}
          geminiSetupError={config.geminiSetupError}
        />
        <PromptEditor
          value={prompt}
          defaultValue={config.defaultEditorialPrompt}
          disabled={running}
          onChange={setPrompt}
        />
      </div>
      {session ? (
        <ScenarioWorkspace
          key={session.id}
          config={config}
          result={session.result}
          upload={upload.state}
          assets={assets}
          onUpload={(file) => upload.upload(file, session.result.sourceVideo.videoId)}
          onClearUpload={upload.clear}
        />
      ) : (
        <EmptyGuide />
      )}
    </div>
  );
}
