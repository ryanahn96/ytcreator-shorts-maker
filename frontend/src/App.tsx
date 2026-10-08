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
          <h2 className="text-2xl font-medium tracking-tight text-on-surface">
            YouTube 계정으로 로그인
          </h2>
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
