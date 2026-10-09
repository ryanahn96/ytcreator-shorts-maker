/**
 * 말로 편집 (Edit Agent) under the preview (ADR 0011, 0012): a box for an
 * Edit Request, typed or spoken, and the latest answer on one line with
 * 되돌리기 while its edit is the newest undo step. The requests of this
 * editor session open above the box as a history; nothing is stored. One
 * request waits at a time, and 중단 stops it.
 */

import {useEffect, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';

import {useSpeechInput} from '../hooks/useSpeechInput';
import type {EditTurn} from '../lib/editAgent';
import {Icon} from './Icon';
import {Button, IconButton} from './ui';

/** One Edit Request of this editor session, as the bar shows it. */
export interface EditAgentEntry extends EditTurn {
  id: number;
  status: 'pending' | 'done' | 'failed' | 'stopped';
  /** What the server and the editor adjusted or skipped. */
  notes: string[];
  /** Why the request failed; empty unless `status` is 'failed'. */
  error: string;
}

const PLACEHOLDER = '편집 요청을 말하거나 입력하세요. 예: 헤드라인을 노란색으로 크게';
/** The server's limit on one Edit Request. */
const MAX_REQUEST_CHARS = 2000;

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

export function EditAgentBar(props: {
  entries: readonly EditAgentEntry[];
  /** Id of the newest undo step; null when there is none. */
  lastStepId: number | null;
  /** Undo steps that are undone now. */
  reverted: ReadonlySet<number>;
  /** Sends an Edit Request; false when it was not sent (one is waiting). */
  onSend: (text: string) => boolean;
  /** Stops the waiting request. */
  onStop: () => void;
  onRetry: (entryId: number) => void;
  /** Undoes the newest step. */
  onUndo: () => void;
  /** Listening started; the editor pauses the preview. */
  onListen: () => void;
}) {
  const {entries, lastStepId} = props;
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const pending = entries.some((entry) => entry.status === 'pending');
  const newest = entries.at(-1);
  const views: EntryView[] = entries.map((entry) => ({
    entry,
    undoable: entry.stepId !== null && entry.stepId === lastStepId,
    reverted: entry.stepId !== null && props.reverted.has(entry.stepId),
    retryable: entry === newest && entry.status === 'failed' && !pending,
  }));
  const newestView = views.at(-1);

  // Show the newest turn when the history opens and as turns change.
  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [historyOpen, entries.length, newest]);

  const send = (value: string): boolean => {
    const request = value.trim().slice(0, MAX_REQUEST_CHARS);
    if (request === '' || !props.onSend(request)) {
      return false;
    }
    setText('');
    speech.clearError();
    return true;
  };

  const speech = useSpeechInput({
    onStart: props.onListen,
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

  // While listening, sending ends the listen; the final words then go out.
  const submit = () => {
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

  // Escape closes the history from anywhere in the bar, e.g. from the
  // history button right after opening it. Inside the panel, the panel's
  // own handler runs first and also moves focus back to the box.
  const onBarKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && historyOpen && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      setHistoryOpen(false);
    }
  };

  // The status line: a message, and the actions shown after it. The newest
  // request shows on one line; the full text is in the tooltip. The actions
  // stay out of the live region, so a screen reader reads only the message
  // when it changes.
  let message: ReactNode = null;
  let actions: ReactNode = null;
  if (speech.listening) {
    message = (
      <>
        <Icon name="mic" size={16} className="animate-pulse text-error" />
        <span className="min-w-0 flex-1 truncate">듣고 있어요…</span>
      </>
    );
  } else if (speech.error !== '' && !pending) {
    message = (
      <>
        <Icon name="error" size={16} className="text-error" />
        <span className="min-w-0 flex-1 truncate text-error" title={speech.error}>
          {speech.error}
        </span>
      </>
    );
  } else if (newestView) {
    const {entry, undoable, reverted, retryable} = newestView;
    switch (entry.status) {
      case 'pending':
        message = (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
            <span className="min-w-0 flex-1 truncate" title={entry.request}>
              보내는 중: {entry.request}
            </span>
          </>
        );
        break;
      case 'stopped':
        message = (
          <>
            <Icon name="stop" size={16} className="text-on-surface-variant" />
            <span className="min-w-0 flex-1 truncate">편집 요청을 중단했어요.</span>
          </>
        );
        break;
      case 'failed':
        message = (
          <>
            <Icon name="error" size={16} className="text-error" />
            <span className="min-w-0 flex-1 truncate text-error" title={entry.error}>
              {entry.error}
            </span>
          </>
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
          <>
            <Icon
              name={warn ? 'warning' : 'check'}
              size={16}
              className={warn ? 'text-error' : 'text-primary'}
            />
            <span
              className={`min-w-0 flex-1 truncate ${reverted ? 'text-on-surface-variant line-through' : ''}`}
              title={[entry.reply, ...entry.notes].join('\n')}
            >
              {entry.reply}
            </span>
            {reverted && <RevertedChip />}
          </>
        );
        actions = (
          <>
            {entry.notes.length > 0 && (
              <button
                type="button"
                title={entry.notes.join('\n')}
                onClick={() => setHistoryOpen(true)}
                className={`${CHIP} ms-1 bg-secondary-container text-on-secondary-container hover:ring-1 hover:ring-primary`}
              >
                참고 {entry.notes.length}
              </button>
            )}
            {undoable && (
              <Button variant="text" size="sm" icon="undo" onClick={props.onUndo}>
                되돌리기
              </Button>
            )}
          </>
        );
        break;
      }
    }
  }

  return (
    <section aria-label="말로 편집" className="relative mt-3 space-y-2" onKeyDown={onBarKeyDown}>
      {/* Every request of this session, oldest first, above the bar. */}
      {historyOpen && (
        <section
          aria-label="지난 대화"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeHistory();
            }
          }}
          className="absolute inset-x-0 bottom-full z-20 mb-2 flex max-h-[min(60vh,28rem)] flex-col rounded-2xl border border-outline-variant bg-surface-container-high shadow-lg"
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
                  {entry.notes.length > 0 && (
                    <ul className="list-disc space-y-0.5 ps-5 text-xs text-on-surface-variant">
                      {entry.notes.map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                  )}
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
      {message && (
        <div className="flex h-8 items-center gap-1 ps-1 text-[13px] text-on-surface">
          <div role="status" className="flex min-w-0 flex-1 items-center gap-2">
            {message}
          </div>
          {actions}
          {entries.length > 0 && (
            <IconButton
              size="sm"
              icon="history"
              label={historyOpen ? '지난 대화 닫기' : '지난 대화 보기'}
              filled={historyOpen}
              onClick={() => setHistoryOpen((open) => !open)}
              className="-me-1"
            />
          )}
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
            onClick={speech.listening ? speech.stop : speech.start}
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
    </section>
  );
}
