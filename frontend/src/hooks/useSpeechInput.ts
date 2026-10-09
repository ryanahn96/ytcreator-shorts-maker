/**
 * Korean speech input for 말로 편집 with the browser's Web Speech API (ADR
 * 0012). While the user speaks, the words so far stream to onInterim; the
 * final result goes to onFinal, and recognition stops by itself after it.
 * Where the browser has no SpeechRecognition `supported` is false and the
 * mic stays hidden.
 */

import {useEffect, useRef, useState} from 'react';

/** The part of SpeechRecognition this hook uses (not in TypeScript's DOM lib). */
interface Recognition {
  lang: string;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: {results: SpeechRecognitionResultList}) => void) | null;
  onerror: ((event: {error: string}) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

const scope = window as unknown as Record<string, (new () => Recognition) | undefined>;
const SpeechRecognitionCtor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': '마이크를 쓸 수 없어요. 주소창의 사이트 설정에서 마이크를 허용해 주세요.',
  'service-not-allowed': '이 브라우저에서는 음성 인식을 쓸 수 없어요.',
  'audio-capture': '마이크를 찾지 못했어요.',
  'no-speech': '말소리를 듣지 못했어요. 마이크를 다시 눌러 말해 주세요.',
  network: '음성 인식 서버에 연결하지 못했어요.',
};

/**
 * `error` says why the last listen failed and is empty when it did not.
 * `stop` stops listening; what was heard so far still arrives as the final
 * result. `clearError` forgets the error, once the user has moved on.
 */
export function useSpeechInput(handlers: {
  onStart: () => void;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const recognition = useRef<Recognition | null>(null);
  // The newest handlers, so a recognition started earlier calls them.
  const latest = useRef(handlers);
  latest.current = handlers;

  const stop = () => recognition.current?.stop();

  const start = () => {
    if (!SpeechRecognitionCtor || recognition.current) {
      return;
    }
    const session = new SpeechRecognitionCtor();
    session.lang = 'ko-KR';
    session.interimResults = true;
    session.onstart = () => {
      setListening(true);
      latest.current.onStart();
    };
    session.onresult = ({results}) => {
      const text = Array.from(results, (result) => result[0]?.transcript ?? '').join('');
      if (results[results.length - 1]?.isFinal) {
        latest.current.onFinal(text.trim());
      } else {
        latest.current.onInterim(text);
      }
    };
    session.onerror = (event) => {
      if (event.error !== 'aborted') {
        setError(ERROR_MESSAGES[event.error] ?? `음성 인식 오류: ${event.error}`);
      }
    };
    session.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    recognition.current = session;
    setError('');
    try {
      session.start();
    } catch (reason) {
      // start() throws when another recognition is still running.
      recognition.current = null;
      setError(`음성 인식을 시작하지 못했어요: ${String(reason)}`);
    }
  };

  const clearError = () => setError('');

  useEffect(() => () => recognition.current?.abort(), []);

  const supported = SpeechRecognitionCtor !== undefined;
  return {supported, listening, error, start, stop, clearError};
}
