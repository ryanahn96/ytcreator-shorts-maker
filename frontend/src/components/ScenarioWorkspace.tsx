/**
 * Editing one analysis. On wide screens: Scenario tabs, Clip and transcript
 * editors on the left; the selected Clip's Look, Scenario audio and export
 * in the middle; the preview on the right, pinned while the rest scrolls
 * (layout in index.css). All edits resolve on the client (lib/timeline.ts)
 * and feed the preview and export at once.
 */

import {useCallback, useEffect, useMemo, useReducer, useState} from 'react';

import type {AssetStore} from '../hooks/useAssets';
import type {UploadState} from '../hooks/useSourceUpload';
import {createEditorState, editorReducer} from '../lib/editor';
import {lookTarget} from '../lib/look';
import {
  clipSubcuts,
  resolveScenario,
  wordGapPauses,
  wordsStartingIn,
  type Transcript,
  type TranscriptEdits,
} from '../lib/timeline';
import type {AnalysisResult, StudioConfig, TimeRange} from '../types';
import {AnalysisSummary} from './AnalysisSummary';
import {ClipEditor} from './ClipEditor';
import {ExportPanel} from './ExportPanel';
import {LookControls} from './LookControls';
import {PreviewStage} from './preview/PreviewStage';
import {ScenarioAudioControls} from './ScenarioAudioControls';
import {ScenarioTabs} from './ScenarioTabs';
import {TranscriptPanel} from './TranscriptPanel';
import {Panel} from './ui';

const NO_UPLOAD: UploadState = {status: 'empty'};

/** Whether an upload is the MP4 of this Source Video. */
function uploadMatches(upload: UploadState, videoId: string): boolean {
  if (upload.status === 'empty') {
    return false;
  }
  // A file analyzed directly uses its upload id as the video id.
  return (
    upload.videoId === videoId ||
    (upload.status === 'ready' && upload.source.sourceId === videoId)
  );
}

export function ScenarioWorkspace(props: {
  config: StudioConfig;
  result: AnalysisResult;
  upload: UploadState;
  assets: AssetStore;
  onUpload: (file: File) => void;
  onClearUpload: () => void;
}) {
  const {config, result} = props;
  const sourceVideo = result.sourceVideo;
  const [state, dispatch] = useReducer(editorReducer, undefined, () =>
    createEditorState(result, config.composition),
  );
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);

  const transcript = useMemo<Transcript>(
    () => ({
      words: [...result.transcriptWords].sort((a, b) => a.startSec - b.startSec),
      lineStarts: new Set(result.lineStartIndices),
    }),
    [result],
  );
  // An upload made for another video must not drive this one.
  const upload = uploadMatches(props.upload, sourceVideo.videoId) ? props.upload : NO_UPLOAD;
  const measured = upload.status === 'ready' ? upload.source : null;
  const pauses = useMemo(
    () => measured?.silences ?? wordGapPauses(transcript.words),
    [measured, transcript],
  );
  const fps = measured && measured.media.fps > 0 ? measured.media.fps : sourceVideo.fps;
  const minCueSec = fps > 0 ? 1 / fps : 0;
  const edits = useMemo<TranscriptEdits>(
    () => ({cutWords: state.cutWords, wordText: state.wordText}),
    [state.cutWords, state.wordText],
  );
  const resolvedAll = useMemo(
    () =>
      state.scenarios.map((scenario) =>
        resolveScenario({
          scenario,
          transcript,
          edits,
          pauses,
          settings: state.settings,
          minCueSec,
        }),
      ),
    [state.scenarios, transcript, edits, pauses, state.settings, minCueSec],
  );
  const subcutsFor = useCallback(
    (range: TimeRange) =>
      clipSubcuts({
        range,
        words: wordsStartingIn(transcript.words, range),
        edits,
        pauses,
        settings: state.settings,
      }),
    [transcript, edits, pauses, state.settings],
  );

  const scenario = state.scenarios[state.scenarioIndex];
  const resolved = resolvedAll[state.scenarioIndex];
  const recommended = state.original[state.scenarioIndex] ?? scenario;
  // An image selected in another Clip's Look is not editable here.
  useEffect(() => setSelectedImageId(null), [state.scenarioIndex, state.clipIndex]);

  if (!scenario || !resolved) {
    return (
      <div className="space-y-4">
        <AnalysisSummary result={result} captionSources={config.captionSources} />
        <Panel title="시나리오 없음">
          <p className="text-xs text-zinc-400">
            Gemini가 시나리오를 돌려주지 않았습니다. Editorial Prompt를 조정해 다시
            분석하세요.
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="studio-grid">
      <div className="studio-editors space-y-4">
        <AnalysisSummary result={result} captionSources={config.captionSources} />
        <ScenarioTabs
          scenarios={state.scenarios}
          original={state.original}
          durations={resolvedAll.map((item) => item.durationSec)}
          index={state.scenarioIndex}
          onSelect={(index) => dispatch({type: 'selectScenario', index})}
          onReset={() => dispatch({type: 'resetScenario'})}
        />
        <ClipEditor
          clips={resolved.clips}
          clipIndex={state.clipIndex}
          transcript={transcript}
          settings={state.settings}
          sourceDurationSec={state.sourceDurationSec}
          subcutsFor={subcutsFor}
          dispatch={dispatch}
        />
        <TranscriptPanel
          transcript={transcript}
          clips={resolved.clips}
          clipIndex={state.clipIndex}
          edits={edits}
          minSubcutSec={state.settings.minSubcutSec}
          dispatch={dispatch}
        />
      </div>
      <div className="studio-preview">
        <Panel title={`미리보기 · ${scenario.title}`}>
          <PreviewStage
            config={config}
            sourceVideo={sourceVideo}
            resolved={resolved}
            scenario={scenario}
            localVideoUrl={upload.status === 'empty' ? null : upload.objectUrl}
            fps={fps}
            sourceDurationSec={state.sourceDurationSec}
            assetUrls={props.assets.urls}
            selectedImageId={selectedImageId}
            onSelectImage={setSelectedImageId}
            clipIndex={state.clipIndex}
            onLookEdit={(index, look) => {
              dispatch({type: 'selectClip', index});
              dispatch({type: 'setLook', clipId: lookTarget(scenario, index), look});
            }}
          />
        </Panel>
      </div>
      <div className="studio-controls space-y-4">
        <LookControls
          config={config}
          sourceVideo={sourceVideo}
          scenario={scenario}
          recommended={recommended}
          clipIndex={state.clipIndex}
          assets={props.assets}
          selectedImageId={selectedImageId}
          onSelectImage={setSelectedImageId}
          dispatch={dispatch}
        />
        <ScenarioAudioControls
          config={config}
          scenario={scenario}
          recommended={recommended}
          assets={props.assets}
          dispatch={dispatch}
        />
        <ExportPanel
          config={config}
          sourceVideo={sourceVideo}
          plan={resolved.plan}
          scenarioTitle={scenario.title}
          upload={upload}
          onUpload={props.onUpload}
          onClearUpload={props.onClearUpload}
        />
      </div>
    </div>
  );
}
