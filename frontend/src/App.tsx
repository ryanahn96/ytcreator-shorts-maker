/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {useCallback, useEffect, useState} from 'react';

import {AppHeader} from './components/AppHeader';
import {BrandMark, Icon} from './components/Icon';
import {Studio} from './components/Studio';
import {ThemeMenu} from './components/ThemeMenu';
import {Button, buttonClass, Notice, ProgressBar} from './components/ui';
import {errorMessage, getConfig, LOGIN_URL, logout} from './lib/api';
import type {AuthStatus, StudioConfig} from './types';

type ConfigState =
  | {status: 'loading'}
  | {status: 'ready'; config: StudioConfig}
  | {status: 'failed'; error: string};

function readInitialAuthError(): string | null {
  const params = new URLSearchParams(window.location.search);
  const err = params.get('auth_error');
  if (err) {
    params.delete('auth_error');
    const qs = params.toString();
    const nextUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
    return err;
  }
  return null;
}

function LoginScreen(props: {
  auth: AuthStatus;
  authError: string | null;
  onDismissError: () => void;
}) {
  const {auth, authError} = props;
  const canLogin = auth.oauthConfigured;
  return (
    <>
      <AppHeader>
        <ThemeMenu />
      </AppHeader>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center gap-6 px-4 pt-[10vh] pb-16 sm:px-6">
        {authError && (
          <Notice tone="error" onClose={props.onDismissError} className="w-full">
            {authError}
          </Notice>
        )}
        {!auth.oauthConfigured && auth.oauthSetupError && (
          <Notice tone="error" className="w-full">
            {auth.oauthSetupError}
          </Notice>
        )}
        <section className="flex w-full flex-col items-center gap-6 rounded-[28px] bg-surface-container px-6 py-10 text-center sm:px-10">
          <BrandMark size={56} />
          <div className="space-y-2">
            <h2 className="text-2xl font-medium tracking-tight text-on-surface">
              YouTube 크리에이터 계정으로 로그인
            </h2>
            <p className="text-sm text-on-surface-variant">
              본인 YouTube 채널을 연결하면 시청자 유지율 피크 구간 분석과 Shorts
              원클릭 업로드를 바로 사용할 수 있어요.
            </p>
          </div>
          <ul className="w-full space-y-2.5 rounded-2xl bg-surface-container-low p-4 text-left text-sm text-on-surface-variant">
            <li className="flex items-start gap-2.5">
              <Icon name="insights" size={20} className="mt-0.5 text-primary" />
              <span>
                <strong className="font-medium text-on-surface">
                  시청자 유지율(Audience Retention) 반영
                </strong>{' '}
                — 시청자가 가장 집중하거나 반복 재생한 피크 구간을 Gemini가 우선
                선별해요.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Icon name="subtitles" size={20} className="mt-0.5 text-primary" />
              <span>
                <strong className="font-medium text-on-surface">
                  채널 공식 자막 트랙 연동
                </strong>{' '}
                — 채널에 등록된 자막이 있으면 첫 분석 시 바로 가져와 자막 정확도를
                높여요.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Icon name="upload" size={20} className="mt-0.5 text-primary" />
              <span>
                <strong className="font-medium text-on-surface">
                  완성된 9:16 Shorts 바로 업로드
                </strong>{' '}
                — 내보내기 창에서 비공개·일부 공개·공개 상태로 내 채널에 즉시 올릴
                수 있어요.
              </span>
            </li>
          </ul>
          {canLogin ? (
            <a
              href={LOGIN_URL}
              className={`${buttonClass('gradient', 'lg')} min-w-64`}
            >
              <Icon name="login" />
              Google / YouTube 계정으로 로그인
            </a>
          ) : (
            <Button variant="gradient" size="lg" disabled className="min-w-64">
              OAuth 클라이언트 설정 필요
            </Button>
          )}
        </section>
      </main>
    </>
  );
}

export default function App() {
  const [state, setState] = useState<ConfigState>({status: 'loading'});
  const [authError, setAuthError] = useState<string | null>(readInitialAuthError);
  const load = useCallback(() => {
    setState({status: 'loading'});
    getConfig().then(
      (config) => setState({status: 'ready', config}),
      (error: unknown) => setState({status: 'failed', error: errorMessage(error)}),
    );
  }, []);
  useEffect(load, [load]);

  const handleLogout = useCallback(() => {
    logout().then(
      (auth) => {
        setState((prev) =>
          prev.status === 'ready' ? {status: 'ready', config: {...prev.config, auth}} : prev,
        );
      },
      (error: unknown) => setAuthError(errorMessage(error)),
    );
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-surface text-on-surface">
      {state.status === 'ready' ? (
        state.config.auth.authenticated ? (
          <Studio config={state.config} onLogout={handleLogout} />
        ) : (
          <LoginScreen
            auth={state.config.auth}
            authError={authError}
            onDismissError={() => setAuthError(null)}
          />
        )
      ) : (
        <>
          <AppHeader>
            <ThemeMenu />
          </AppHeader>
          <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center gap-4 px-4 pt-[16vh] sm:px-6">
            {state.status === 'loading' ? (
              <ProgressBar label="불러오는 중" className="w-48" />
            ) : (
              <>
                <Notice tone="error" className="w-full">
                  {`서버 설정을 불러오지 못했어요\n${state.error}`}
                </Notice>
                <Button variant="tonal" icon="refresh" onClick={load}>
                  다시 시도
                </Button>
              </>
            )}
          </main>
        </>
      )}
    </div>
  );
}
