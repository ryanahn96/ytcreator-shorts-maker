/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {Film, Sparkles} from 'lucide-react';
import {useCallback, useEffect, useState} from 'react';

import {ShortformStudioPanel} from './components/ShortformStudioPanel';
import {TextButton} from './components/ui';
import {errorMessage, getConfig} from './lib/api';
import {geminiBackendLabel} from './lib/format';
import type {StudioConfig} from './types';

type ConfigState =
  | {status: 'loading'}
  | {status: 'ready'; config: StudioConfig}
  | {status: 'failed'; error: string};

function GeminiBadge(props: {config: StudioConfig}) {
  const {config} = props;
  const backend = geminiBackendLabel(config.geminiBackend);
  const ready = config.geminiSetupError === '';
  const target =
    config.geminiBackend === 'vertex'
      ? `Vertex AI: ${config.vertexProject} (${config.vertexLocation}), ADC 인증`
      : 'Gemini API: GEMINI_API_KEY';
  return (
    <span
      title={
        ready ? `${target}\n${config.modelChain.join(' → ')}` : config.geminiSetupError
      }
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${
        ready
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-red-500/30 bg-red-500/10 text-red-300'
      }`}
    >
      <Sparkles className="h-3.5 w-3.5" />
      {ready ? `${backend} · ${config.modelChain[0] ?? ''}` : `${backend} 설정 필요`}
    </span>
  );
}

export default function App() {
  const [state, setState] = useState<ConfigState>({status: 'loading'});
  const load = useCallback(() => {
    setState({status: 'loading'});
    getConfig().then(
      (config) => setState({status: 'ready', config}),
      (error: unknown) => setState({status: 'failed', error: errorMessage(error)}),
    );
  }, []);
  useEffect(load, [load]);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-900/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1720px] flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-indigo-500/40 bg-indigo-600/20 text-indigo-400">
              <Film className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-sm font-extrabold tracking-tight text-white sm:text-base">
                에이전틱 숏폼 점프컷 스튜디오
              </h1>
              <p className="text-[11px] text-zinc-400">
                정보성 롱폼 영상을 원본 음성만으로 9:16 점프컷 숏폼으로 만듭니다.
              </p>
            </div>
          </div>
          {state.status === 'ready' && <GeminiBadge config={state.config} />}
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1720px] flex-1 p-4 sm:p-6">
        {state.status === 'loading' && (
          <p className="text-sm text-zinc-400">서버 설정을 불러오는 중…</p>
        )}
        {state.status === 'failed' && (
          <div className="space-y-2">
            <p className="text-sm text-red-400">서버 설정을 불러오지 못했습니다: {state.error}</p>
            <TextButton onClick={load}>다시 시도</TextButton>
          </div>
        )}
        {state.status === 'ready' && <ShortformStudioPanel config={state.config} />}
      </main>
    </div>
  );
}
