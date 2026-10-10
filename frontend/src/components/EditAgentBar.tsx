/**
 * 말로 편집 (Edit Agent, ADR 0011, 0012), floating at the bottom right of
 * the editor like a chat widget. It takes an Edit Request, typed or spoken,
 * shows the whole answer with its notes and 되돌리기 while its edit is the
 * newest undo step, and reads the answer aloud with Gemini TTS. The
 * requests of this editor session open above it as a history; nothing is
 * stored. One request waits at a time, and 중단 stops it. Folded, it is a
 * pill with a mic; listening or a new answer opens it again.
 */

import {useEffect, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';

import {useReplyVoice} from '../hooks/useReplyVoice';
import {useSpeechInput} from '../hooks/useSpeechInput';
import type {EditTurn} from '../lib/editAgent';
import {Icon, type IconName} from './Icon';
import {Button, IconButton, STATE_LAYER} from './ui';

/** One Edit Request of this editor session, as the widget shows it. */
export interface EditAgentEntry extends EditTurn {
  id: number;
  status: 'pending' | 'done' | 'failed' | 'stopped';
  /** The reply written to be heard; it is read aloud with the notes. */
  speech: string;
  /** What the server and the editor adjusted or skipped. */
  notes: string[];
  /** Why the request failed; empty unless `status` is 'failed'. */
  error: string;
}

const PLACEHOLDER = '편집 요청을 말하거나 입력하세요. 예: 헤드라인을 노란색으로 크게';
/** The server's limits on one Edit Request and on one reading. */
const MAX_REQUEST_CHARS = 2000;
const MAX_SPEECH_CHARS = 1000;
/** Room kept between the widget and the controls under it, in pixels. */
const GAP_PX = 32;

const CHIP = 'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium';

interface EntryView {
  entry: EditAgentEntry;
  /** The entry's edit is the newest undo step, so 되돌리기 undoes it. */
  undoable: boolean;
  /** The entry's edit is undone now. */
  reverted: boolean;
  /** 다시 시도 is offered: the newest entry failed and nothing waits. */
  retryable: boolean;
}

function RevertedChip() {
  return (
    <span className={`${CHIP} bg-surface-container-highest text-on-surface-variant`}>
      되돌림
    </span>
  );
}

/** A status line: an icon and text that wraps instead of being cut. */
function Line(props: {icon: IconName; error?: boolean; children: ReactNode}) {
  return (
    <p className={`flex items-start gap-2 ${props.error ? 'text-error' : ''}`}>
      <Icon
        name={props.icon}
        size={16}
        className={`mt-0.5 ${props.error ? '' : 'text-on-surface-variant'}`}
      />
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{props.children}</span>
    </p>
  );
}

function NoteList(props: {notes: readonly string[]}) {
  return (
    <ul className="list-disc space-y-0.5 ps-5 text-xs text-on-surface-variant">
      {props.notes.map((note, index) => (
        <li key={index}>{note}</li>
      ))}
    </ul>
  );
}

export function EditAgentBar(props: {
  entries: readonly EditAgentEntry[];
  /** Id of the newest undo step; null when there is none. */
  lastStepId: number | null;
  /** Undo steps that are undone now. */
  reverted: ReadonlySet<number>;
  /** The preview is playing; starting it ends the reading aloud. */
  previewPlaying: boolean;
  /** Sends an Edit Request; false when it was not sent (one is waiting). */
  onSend: (text: string) => boolean;
  /** Stops the waiting request. */
  onStop: () => void;
  onRetry: (entryId: number) => void;
  /** Undoes the newest step. */
  onUndo: () => void;
  /** Listening or reading aloud starts; the editor pauses the preview. */
  onPausePreview: () => void;
}) {
  const {entries, lastStepId} = props;
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // What gets focus after the widget opens or folds.
  const focusNext = useRef<'input' | 'pill' | null>(null);
  const pending = entries.some((entry) => entry.status === 'pending');
  const newest = entries.at(-1);
  // The newest entry when it was last announced; what is there on mount
  // was announced before.
  const announced = useRef(newest);
  const views: EntryView[] = entries.map((entry) => ({
    entry,
    undoable: entry.stepId !== null && entry.stepId === lastStepId,
    reverted: entry.stepId !== null && props.reverted.has(entry.stepId),
    retryable: entry === newest && entry.status === 'failed' && !pending,
  }));
  const newestView = views.at(-1);

  const voice = useReplyVoice({onSpeak: props.onPausePreview});
  const reading = voice.status === 'loading' || voice.status === 'speaking';

  // Show the newest turn when the history opens and as turns change.
  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [historyOpen, entries.length, newest]);

  // A finished request opens the widget, and its answer is read aloud.
  useEffect(() => {
    if (!newest || newest === announced.current || newest.status === 'pending') {
      return;
    }
    announced.current = newest;
    if (newest.status === 'stopped') {
      return;
    }
    setCollapsed(false);
    if (newest.status === 'done') {
      const words = [newest.speech || newest.reply, ...newest.notes].join(' ');
      void voice.speak(words.slice(0, MAX_SPEECH_CHARS));
    }
  }, [newest]);

  // Starting the preview ends the reading, so the two sounds never mix.
  useEffect(() => {
    if (props.previewPlaying) {
      voice.stop();
    }
  }, [props.previewPlaying]);

  // The editor keeps this much room under its last controls (index.css).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const style = document.documentElement.style;
    const observer = new ResizeObserver(() =>
      style.setProperty('--edit-agent-space', `${root.offsetHeight + GAP_PX}px`),
    );
    observer.observe(root);
    return () => {
      observer.disconnect();
      style.removeProperty('--edit-agent-space');
    };
  }, []);

  useEffect(() => {
    const target = focusNext.current === 'input' ? inputRef.current : pillRef.current;
    if (focusNext.current !== null) {
      target?.focus();
    }
    focusNext.current = null;
  }, [collapsed]);

  const expand = () => {
    focusNext.current = 'input';
    setCollapsed(false);
  };

  const collapse = () => {
    focusNext.current = 'pill';
    setHistoryOpen(false);
    setCollapsed(true);
  };

  const send = (value: string): boolean => {
    const request = value.trim().slice(0, MAX_REQUEST_CHARS);
    if (request === '' || !props.onSend(request)) {
      return false;
    }
    voice.stop();
    setText('');
    speech.clearError();
    return true;
  };

  const speech = useSpeechInput({
    onStart: props.onPausePreview,
    onInterim: setText,
    // What was heard goes out at once; if a request is still waiting it
    // stays in the box to send later.
    onFinal: (heard) => {
      if (heard !== '') {
        setText(heard);
        send(heard);
      }
    },
  });

  // The reading stops first, or the mic would hear it.
  const listen = () => {
    voice.stop();
    voice.unlock();
    setCollapsed(false);
    speech.start();
  };

  // While listening, sending ends the listen; the final words then go out.
  const submit = () => {
    voice.unlock();
    if (speech.listening) {
      speech.stop();
    } else {
      send(text);
    }
  };

  // The stopped request comes back to the box unless the user typed anew.
  const stop = () => {
    const waiting = entries.find((entry) => entry.status === 'pending');
    if (waiting && text.trim() === '') {
      setText(waiting.request);
    }
    props.onStop();
  };

  const retry = (entryId: number) => {
    voice.stop();
    voice.unlock();
    speech.clearError();
    props.onRetry(entryId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that ends a Korean syllable belongs to the input method.
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault();
      if (!pending) {
        submit();
      }
    }
  };

  const closeHistory = () => {
    setHistoryOpen(false);
    inputRef.current?.focus();
  };

  // Escape closes the history from anywhere in the widget, e.g. from the
  // history button right after opening it. Inside the panel, the panel's
  // own handler runs first and also moves focus back to the box.
  const onWidgetKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && historyOpen && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      setHistoryOpen(false);
    }
  };

  // The latest result: a message that wraps to show everything, and the
  // actions after it. The actions stay out of the live region, so a screen
  // reader reads only the message when it changes.
  let message: ReactNode = null;
  let actions: ReactNode = null;
  if (speech.listening) {
    message = (
      <p className="flex items-center gap-2">
        <Icon name="mic" size={16} className="animate-pulse text-error" />
        듣고 있어요…
      </p>
    );
  } else if (speech.error !== '' && !pending) {
    message = (
      <Line icon="error" error>
        {speech.error}
      </Line>
    );
  } else if (newestView) {
    const {entry, undoable, reverted, retryable} = newestView;
    switch (entry.status) {
      case 'pending':
        message = (
          <p className="flex items-start gap-2">
            <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
            <span className="line-clamp-2 min-w-0 flex-1 break-words" title={entry.request}>
              보내는 중: {entry.request}
            </span>
          </p>
        );
        break;
      case 'stopped':
        message = <Line icon="stop">편집 요청을 중단했어요.</Line>;
        break;
      case 'failed':
        message = (
          <Line icon="error" error>
            {entry.error}
          </Line>
        );
        actions = retryable && (
          <Button variant="text" size="sm" icon="refresh" onClick={() => retry(entry.id)}>
            다시 시도
          </Button>
        );
        break;
      case 'done': {
        // Nothing changed and something was skipped or adjusted: no check mark.
        const warn = entry.stepId === null && entry.notes.length > 0;
        message = (
          <div className="flex items-start gap-2">
            <Icon
              name={warn ? 'warning' : 'check'}
              size={16}
              className={`mt-0.5 ${warn ? 'text-error' : 'text-primary'}`}
            />
            <div className="min-w-0 flex-1 space-y-1">
              <p
                className={`break-words whitespace-pre-wrap ${
                  reverted ? 'text-on-surface-variant line-through' : ''
                }`}
              >
                {entry.reply}
              </p>
              {entry.notes.length > 0 && <NoteList notes={entry.notes} />}
            </div>
          </div>
        );
        actions = (reverted || undoable || voice.status !== 'idle') && (
          <>
            {reverted && <RevertedChip />}
            {undoable && (
              <Button variant="text" size="sm" icon="undo" onClick={props.onUndo}>
                되돌리기
              </Button>
            )}
            {reading && (
              <Button variant="text" size="sm" icon="stop" onClick={voice.stop}>
                읽기 멈추기
              </Button>
            )}
            {voice.status === 'failed' && (
              <span className="px-2 text-xs text-error" title={voice.error}>
                음성으로 읽지 못했어요.
              </span>
            )}
          </>
        );
        break;
      }
    }
  }

  return (
    <section
      ref={rootRef}
      aria-label="말로 편집"
      onKeyDown={onWidgetKeyDown}
      className={`fixed right-4 bottom-4 z-40 border border-outline-variant bg-surface-container-high shadow-lg sm:right-6 sm:bottom-6 ${
        collapsed
          ? 'flex items-center gap-1 rounded-full p-1'
          : 'w-[min(26rem,calc(100vw-2rem))] space-y-2 rounded-[28px] p-2'
      }`}
    >
      {collapsed ? (
        <>
          <button
            ref={pillRef}
            type="button"
            title="말로 편집 열기"
            aria-expanded={false}
            onClick={expand}
            className={`flex h-10 items-center gap-2 rounded-full ps-3 pe-4 text-sm font-medium text-on-surface ${STATE_LAYER}`}
          >
            <Icon name="graphic_eq" className="text-primary" />
            말로 편집
            {(pending || reading) && (
              <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
            )}
          </button>
          {speech.supported && (
            <IconButton icon="mic" label="말로 입력" disabled={pending} onClick={listen} />
          )}
        </>
      ) : (
        <>
          {/* Every request of this session, oldest first, above the widget. */}
          {historyOpen && (
            <section
              aria-label="지난 대화"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  closeHistory();
                }
              }}
              className="absolute inset-x-0 bottom-full z-20 mb-2 flex max-h-[min(55vh,28rem)] flex-col rounded-[28px] border border-outline-variant bg-surface-container-high shadow-lg"
            >
              <div className="flex shrink-0 items-center justify-between py-1 ps-4 pe-1">
                <h3 className="text-sm font-medium text-on-surface">지난 대화</h3>
                <IconButton size="sm" icon="close" label="지난 대화 닫기" onClick={closeHistory} />
              </div>
              <ol ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3">
                {views.map(({entry, undoable, reverted, retryable}) => (
                  <li key={entry.id} className="space-y-1.5 text-[13px]">
                    <p className="ms-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-secondary-container px-3 py-2 break-words whitespace-pre-wrap text-on-secondary-container">
                      {entry.request}
                    </p>
                    <div className="max-w-[92%] space-y-1 text-on-surface">
                      {entry.status === 'pending' && (
                        <p className="flex items-center gap-2 text-on-surface-variant">
                          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
                          보내는 중
                        </p>
                      )}
                      {entry.status === 'stopped' && (
                        <p className="text-on-surface-variant">편집 요청을 중단했어요.</p>
                      )}
                      {entry.status === 'failed' && <p className="text-error">{entry.error}</p>}
                      {entry.status === 'done' && (
                        <p className={reverted ? 'text-on-surface-variant line-through' : ''}>
                          {entry.reply}
                        </p>
                      )}
                      {entry.notes.length > 0 && <NoteList notes={entry.notes} />}
                      {(reverted || undoable || retryable) && (
                        <div className="flex flex-wrap items-center gap-1">
                          {reverted && <RevertedChip />}
                          {undoable && (
                            <Button variant="text" size="sm" icon="undo" onClick={props.onUndo}>
                              되돌리기
                            </Button>
                          )}
                          {retryable && (
                            <Button
                              variant="text"
                              size="sm"
                              icon="refresh"
                              onClick={() => retry(entry.id)}
                            >
                              다시 시도
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
          <header className="flex items-center gap-1 ps-3">
            <Icon name="graphic_eq" className="text-primary" />
            <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">
              말로 편집
            </h2>
            {entries.length > 0 && (
              <IconButton
                size="sm"
                icon="history"
                label={historyOpen ? '지난 대화 닫기' : '지난 대화 보기'}
                filled={historyOpen}
                onClick={() => setHistoryOpen((open) => !open)}
              />
            )}
            <IconButton
              size="sm"
              icon={voice.enabled ? 'volume_up' : 'volume_off'}
              label={voice.enabled ? '음성으로 읽기 끄기' : '음성으로 읽기 켜기'}
              onClick={voice.toggle}
            />
            <IconButton size="sm" icon="expand_more" label="말로 편집 접기" onClick={collapse} />
          </header>
          {message && (
            <div className="rounded-2xl bg-surface px-3 py-2 text-[13px] leading-5 text-on-surface">
              <div role="status" className="max-h-[min(40vh,16rem)] overflow-y-auto">
                {message}
              </div>
              {actions && <div className="mt-1 flex flex-wrap items-center gap-1">{actions}</div>}
            </div>
          )}
          <div className="flex items-end gap-1 rounded-2xl border border-outline-variant bg-surface py-1.5 ps-3 pe-1.5 transition-colors hover:border-outline focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
            <textarea
              ref={inputRef}
              aria-label="편집 요청"
              placeholder={PLACEHOLDER}
              value={text}
              rows={2}
              maxLength={MAX_REQUEST_CHARS}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              className="block min-w-0 flex-1 resize-none bg-transparent py-0.5 text-[13px] leading-5 text-on-surface placeholder:text-on-surface-variant focus:outline-none"
            />
            {speech.supported && (
              <IconButton
                size="sm"
                icon="mic"
                label={speech.listening ? '듣기 멈추기' : '말로 입력'}
                variant={speech.listening ? 'filled' : 'standard'}
                filled={speech.listening}
                disabled={pending && !speech.listening}
                onClick={speech.listening ? speech.stop : listen}
                className={speech.listening ? 'animate-pulse' : ''}
              />
            )}
            {pending ? (
              <Button variant="tonal" size="sm" icon="stop" onClick={stop}>
                중단
              </Button>
            ) : (
              <IconButton
                size="sm"
                icon="send"
                label="보내기"
                variant="filled"
                disabled={text.trim() === ''}
                onClick={submit}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
