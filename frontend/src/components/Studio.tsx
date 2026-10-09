/**
 * The studio's three screens without routing: start (upload the Source
 * Video), analyzing, and the editor. Owns the upload, the added images and
 * music, the Editorial Prompt and the current analysis session.
 */

import {useCallback, useRef, useState} from 'react';

import {useAnalysis} from '../hooks/useAnalysis';
import {useAssets} from '../hooks/useAssets';
import {useSourceUpload} from '../hooks/useSourceUpload';
import type {AnalysisResult, ReanalyzeMode, StudioConfig} from '../types';
import {AnalyzingScreen} from './AnalyzingScreen';
import {AppHeader, CreatorBadge} from './AppHeader';
import {EditorScreen} from './EditorScreen';
import {ReanalyzeDialog} from './ReanalyzeDialog';
import {StartScreen} from './StartScreen';
import {Button, Dialog, Snackbar} from './ui';

/** One analysis result being edited; a new result starts a new session. */
interface Session {
  id: number;
  result: AnalysisResult;
}

export function Studio(props: {config: StudioConfig; onLogout: () => void}) {
  const {config} = props;
  const upload = useSourceUpload();
  const assets = useAssets();
  const [prompt, setPrompt] = useState(config.defaultEditorialPrompt);
  const [youtubeVideoId, setYoutubeVideoId] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [dialog, setDialog] = useState<'reanalyze' | 'newVideo' | null>(null);
  const sessions = useRef(0);
  const onResult = useCallback((result: AnalysisResult) => {
    sessions.current += 1;
    setSession({id: sessions.current, result});
  }, []);
  const analysis = useAnalysis(onResult);

  const ready = upload.state.status === 'ready' ? upload.state : null;
  const failure = analysis.state.status === 'failed' ? analysis.state.error : null;
  const closeDialog = () => setDialog(null);
  // The mode matters for a re-analysis only; the first run always watches
  // and transcribes the video.
  const analyze = (editorialPrompt: string, mode: ReanalyzeMode = 'fast') => {
    if (ready) {
      void analysis.start({
        sourceId: ready.source.sourceId,
        editorialPrompt,
        mode,
        youtubeVideoId: youtubeVideoId.trim(),
      });
    }
  };
  const startNew = () => {
    analysis.cancel();
    upload.clear();
    setYoutubeVideoId('');
    setSession(null);
    setDialog(null);
  };

  if (session && ready) {
    return (
      <>
        <EditorScreen
          key={session.id}
          config={config}
          result={session.result}
          videoUrl={ready.objectUrl}
          source={ready.source}
          assets={assets}
          analysis={analysis.state}
          onReanalyze={() => setDialog('reanalyze')}
          onCancelAnalysis={analysis.cancel}
          onNewVideo={() => setDialog('newVideo')}
          onLogout={props.onLogout}
        />
        {dialog === 'reanalyze' && (
          <ReanalyzeDialog
            prompt={prompt}
            defaultPrompt={config.defaultEditorialPrompt}
            onClose={closeDialog}
            onStart={(draft, mode) => {
              setPrompt(draft);
              setDialog(null);
              analyze(draft, mode);
            }}
          />
        )}
        <Dialog
          open={dialog === 'newVideo'}
          title="새 영상으로 시작할까요?"
          width={420}
          onClose={closeDialog}
          actions={
            <>
              <Button variant="text" onClick={closeDialog}>
                취소
              </Button>
              <Button onClick={startNew}>새 영상</Button>
            </>
          }
        >
          편집 중인 내용이 사라져요
        </Dialog>
        {failure !== null && (
          <Snackbar
            message={`다시 분석하지 못했어요\n${failure}`}
            onClose={analysis.dismiss}
          />
        )}
      </>
    );
  }

  return (
    <>
      <AppHeader>
        <CreatorBadge user={config.auth.user} onLogout={props.onLogout} />
      </AppHeader>
      {analysis.state.status === 'running' ? (
        <AnalyzingScreen progress={analysis.state.progress} onCancel={analysis.cancel} />
      ) : (
        <StartScreen
          upload={upload.state}
          onFile={upload.upload}
          prompt={prompt}
          defaultPrompt={config.defaultEditorialPrompt}
          onPromptChange={setPrompt}
          youtubeVideoId={youtubeVideoId}
          onYoutubeVideoIdChange={setYoutubeVideoId}
          setupError={config.geminiSetupError}
          analysisError={failure}
          onDismissError={analysis.dismiss}
          onStart={() => analyze(prompt)}
        />
      )}
    </>
  );
}
