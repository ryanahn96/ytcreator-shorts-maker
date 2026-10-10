/**
 * Reads 말로 편집 answers aloud (ADR 0012): the server's Gemini TTS makes
 * the audio and the Web Audio API plays it. One answer plays at a time; a
 * new one, stop() or turning the voice off ends the one before. The on/off
 * choice is kept in localStorage.
 *
 * Browsers start sound only after the user acted on the page, and an
 * answer arrives seconds after its request, so unlock() resumes the audio
 * output from the click or key press that sent the request.
 */

import {useEffect, useRef, useState} from 'react';

import {errorMessage, speakText} from '../lib/api';

const STORAGE_KEY = 'editAgentVoice';

/** Nothing playing, fetching the audio, playing it, or the last one failed. */
export type VoiceStatus = 'idle' | 'loading' | 'speaking' | 'failed';

interface Reading {
  controller: AbortController;
  /** Set once the audio plays. */
  source: AudioBufferSourceNode | null;
}

export function useReplyVoice(handlers: {
  /** The audio starts; the editor pauses the preview. */
  onSpeak: () => void;
}) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(STORAGE_KEY) !== 'off');
  const [status, setStatus] = useState<VoiceStatus>('idle');
  /** Why the last reading failed; empty unless `status` is 'failed'. */
  const [error, setError] = useState('');
  const output = useRef<AudioContext | null>(null);
  const reading = useRef<Reading | null>(null);
  // The newest handlers, so a reading started earlier calls them.
  const latest = useRef(handlers);
  latest.current = handlers;

  const audio = (): AudioContext => {
    if (output.current === null || output.current.state === 'closed') {
      output.current = new AudioContext();
    }
    return output.current;
  };

  /** Ends the reading in progress, if any. */
  const stop = () => {
    const current = reading.current;
    reading.current = null;
    current?.controller.abort();
    current?.source?.stop();
    setStatus('idle');
  };

  /** Lets sound start later; call it from the user's click or key press. */
  const unlock = () => {
    void audio().resume();
  };

  /** Reads `text` aloud, ending the reading before it; nothing when off. */
  const speak = async (text: string) => {
    stop();
    if (!enabled || text.trim() === '') {
      return;
    }
    const mine: Reading = {controller: new AbortController(), source: null};
    reading.current = mine;
    setStatus('loading');
    setError('');
    try {
      const data = await speakText(text, mine.controller.signal);
      const context = audio();
      const buffer = await context.decodeAudioData(data);
      if (reading.current !== mine) {
        return;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (reading.current === mine) {
          reading.current = null;
          setStatus('idle');
        }
      };
      mine.source = source;
      latest.current.onSpeak();
      void context.resume();
      source.start();
      setStatus('speaking');
    } catch (reason) {
      // A reading that was stopped or replaced ends quietly.
      if (reading.current === mine) {
        reading.current = null;
        setStatus('failed');
        setError(errorMessage(reason));
      }
    }
  };

  const toggle = () => {
    const next = !enabled;
    localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
    setEnabled(next);
    if (next) {
      unlock();
    } else {
      stop();
    }
  };

  useEffect(
    () => () => {
      reading.current?.controller.abort();
      reading.current = null;
      void output.current?.close();
      output.current = null;
    },
    [],
  );

  return {enabled, status, error, speak, stop, unlock, toggle};
}
