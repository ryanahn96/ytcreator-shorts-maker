/**
 * Undo and redo for the editor, for hand edits and 말로 편집 (Edit Agent)
 * edits alike. It wraps editorReducer and keeps the steps.
 *
 * Every edit that changes the content (Scenarios, caption edits, caption
 * settings) is a step; selecting a Shorts or a Clip is not. A drag or a run
 * of input on one control becomes one step: edits with the same merge key
 * join the latest step while a pointer is held down, or while they arrive
 * less than MERGE_WINDOW_MS apart. A press, a release or a focus change
 * ends the step, and a step that ends where it began is dropped. An Edit
 * Request is applied as one step (`commit`).
 *
 * Ctrl+Z inside a text box is the box's own undo, not the editor's. What
 * it changes folds into the steps typed in that box (`boxUndoHistory`), so
 * it leaves no step behind for the editor's undo to bring back.
 *
 * Undo puts back the state before the step, together with the Shorts and
 * Clip that were selected then, so undoing a change made in another Shorts
 * brings that Shorts on screen. HISTORY_LIMIT steps are kept; a new
 * analysis or a new video mounts a new editor and so starts empty.
 */

import {useCallback, useEffect, useRef, useState} from 'react';

import {editorReducer, type EditorAction, type EditorState} from './editor';

export const HISTORY_LIMIT = 100;
/** Edits of one control closer together than this form one step. */
const MERGE_WINDOW_MS = 1000;

interface HistoryStep {
  id: number;
  /** The state before the step, with the selection of that moment. */
  before: EditorState;
  /** The state right after the step. */
  after: EditorState;
  /** The text box or other field the step was typed in, if any. */
  box?: EventTarget;
}

export interface EditorHistory {
  present: EditorState;
  /** Applied steps, oldest first. */
  done: readonly HistoryStep[];
  /** Undone steps; the last one is redone first. */
  undone: readonly HistoryStep[];
  /** Ids of steps that are undone now, including ones no redo can bring back. */
  reverted: ReadonlySet<number>;
  nextId: number;
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  return a === b || (a.size === b.size && [...a].every((value) => b.has(value)));
}

function sameMap(a: ReadonlyMap<number, string>, b: ReadonlyMap<number, string>): boolean {
  return (
    a === b ||
    (a.size === b.size && [...a].every(([key, value]) => b.get(key) === value))
  );
}

export function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Whether two states hold the same edits, whatever is selected. */
export function sameContent(a: EditorState, b: EditorState): boolean {
  return (
    sameSet(a.cutWords, b.cutWords) &&
    sameMap(a.wordText, b.wordText) &&
    sameJson(a.settings, b.settings) &&
    a.scenarios.length === b.scenarios.length &&
    a.scenarios.every((scenario, index) => sameJson(scenario, b.scenarios[index]))
  );
}

/**
 * The key under which edits of one control merge into one step, or null
 * for edits that are always a step of their own (clicks, toggles, adds).
 */
function mergeKey(state: EditorState, action: EditorAction): string | null {
  const scenario = state.scenarios[state.scenarioIndex];
  const scenarioId = scenario?.scenarioId ?? '';
  switch (action.type) {
    case 'setClipRange':
      return `range:${scenarioId}:${scenario?.clips[action.index]?.clipId ?? action.index}`;
    case 'setLook':
      return `look:${scenarioId}:${action.clipId ?? ''}`;
    case 'setMusic':
      return action.music && action.music.assetId === scenario?.music?.assetId
        ? `music:${scenarioId}`
        : null;
    case 'setCaptionMaxChars':
      return 'captionMaxChars';
    default:
      return null;
  }
}

function pushStep(history: EditorHistory, next: EditorState, box?: EventTarget): EditorHistory {
  const step: HistoryStep = {id: history.nextId, before: history.present, after: next, box};
  return {
    ...history,
    present: next,
    done: [...history.done, step].slice(-HISTORY_LIMIT),
    undone: [],
    nextId: history.nextId + 1,
  };
}

/**
 * Applies a hand edit that turned the present into `next`, typed in `box`
 * when it came from a field. With `merge`, a content change replaces the
 * end of the latest step instead of adding one, and drops the step if it
 * now ends where it began.
 */
export function editHistory(
  history: EditorHistory,
  next: EditorState,
  merge: boolean,
  box?: EventTarget,
): EditorHistory {
  if (next === history.present) {
    return history;
  }
  if (sameContent(history.present, next)) {
    return {...history, present: next};
  }
  const last = history.done.at(-1);
  if (merge && last) {
    const rest = history.done.slice(0, -1);
    return {
      ...history,
      present: next,
      done: sameContent(last.before, next)
        ? rest
        : [...rest, {...last, after: next, box: box ?? last.box}],
      undone: [],
    };
  }
  return pushStep(history, next, box);
}

/**
 * Applies a hand edit made by the own undo or redo of the text box `box`.
 * The box's latest steps are the ones at the end of the history that were
 * typed in it. If the edit takes the box back to the state before one of
 * them, that step and the ones after it are dropped; the browser groups
 * typing in its own way, so one Ctrl+Z may undo several steps. Otherwise
 * the edit joins the box's latest step, or is a step of its own when the
 * latest step was not typed in the box.
 */
function withMonotonicCounters(
  target: EditorState,
  current: EditorState,
): EditorState {
  const createdClips = Math.max(target.createdClips, current.createdClips);
  const createdImages = Math.max(target.createdImages, current.createdImages);
  return createdClips === target.createdClips &&
    createdImages === target.createdImages
    ? target
    : {...target, createdClips, createdImages};
}

export function boxUndoHistory(
  history: EditorHistory,
  action: EditorAction,
  box: EventTarget,
): EditorHistory {
  const {done, present} = history;
  const next = editorReducer(present, action);
  let first = done.length;
  while (first > 0 && done[first - 1].box === box) {
    first -= 1;
  }
  if (!sameContent(present, next)) {
    for (let index = done.length - 1; index >= first; index -= 1) {
      if (sameContent(done[index].before, next)) {
        return {
          ...history,
          present: withMonotonicCounters(next, present),
          done: done.slice(0, index),
          undone: [],
        };
      }
    }
  }
  return editHistory(history, next, first < done.length, box);
}

export function undoHistory(history: EditorHistory): EditorHistory {
  const step = history.done.at(-1);
  if (!step) {
    return history;
  }
  return {
    ...history,
    present: withMonotonicCounters(step.before, history.present),
    done: history.done.slice(0, -1),
    undone: [...history.undone, step],
    reverted: new Set(history.reverted).add(step.id),
  };
}

export function redoHistory(history: EditorHistory): EditorHistory {
  const step = history.undone.at(-1);
  if (!step) {
    return history;
  }
  const reverted = new Set(history.reverted);
  reverted.delete(step.id);
  return {
    ...history,
    present: withMonotonicCounters(step.after, history.present),
    done: [...history.done, step].slice(-HISTORY_LIMIT),
    undone: history.undone.slice(0, -1),
    reverted,
  };
}

/**
 * The editor state with its undo steps. `dispatch` takes hand edits, and
 * consecutive edits of one control merge into one step. `latest` is the
 * newest state, including edits React has not rendered yet. `commit` makes
 * `next` the present as one step and returns the step's id.
 */
export function useEditorHistory(init: () => EditorState) {
  const [history, setHistory] = useState<EditorHistory>(() => ({
    present: init(),
    done: [],
    undone: [],
    reverted: new Set(),
    nextId: 1,
  }));
  // The newest history, ahead of React when several edits land before a
  // render; merge bookkeeping stays out of React state so presses and focus
  // changes do not re-render the editor.
  const ref = useRef(history);
  const gesture = useRef(false);
  // The latest step while a hand edit may still merge into it: the merge
  // key of its edits and when the last one landed.
  const open = useRef<{key: string; at: number} | null>(null);
  // The `input` event React is handling, if any: the text box or other
  // field it came from, and whether it is that box's own undo or redo.
  const input = useRef<{box: EventTarget; own: boolean} | null>(null);

  const set = useCallback((next: EditorHistory) => {
    if (next !== ref.current) {
      ref.current = next;
      setHistory(next);
    }
  }, []);

  const dispatch = useCallback(
    (action: EditorAction) => {
      const current = ref.current;
      const now = performance.now();
      const key = mergeKey(current.present, action);
      const last = current.done.at(-1);
      const typing = input.current;
      const pending = open.current;
      const merge =
        key !== null &&
        pending !== null &&
        pending.key === key &&
        (gesture.current || now - pending.at < MERGE_WINDOW_MS);
      const next = typing?.own
        ? boxUndoHistory(current, action, typing.box)
        : editHistory(current, editorReducer(current.present, action), merge, typing?.box);
      set(next);
      if (next.done !== current.done) {
        // The step just added or grown; none when steps were dropped, so
        // later edits cannot merge into an older step.
        const step = next.done.at(-1);
        const kept =
          step && (next.nextId !== current.nextId || step.id === last?.id) ? step : null;
        open.current = key !== null && kept ? {key, at: now} : null;
      }
    },
    [set],
  );

  const commit = useCallback(
    (next: EditorState) => {
      const id = ref.current.nextId;
      open.current = null;
      set(pushStep(ref.current, next));
      return id;
    },
    [set],
  );

  const undo = useCallback(() => {
    open.current = null;
    set(undoHistory(ref.current));
  }, [set]);

  const redo = useCallback(() => {
    open.current = null;
    set(redoHistory(ref.current));
  }, [set]);

  const latest = useCallback(() => ref.current.present, []);

  // A press starts a gesture and a release ends it; both, and any focus
  // change, close the step that later edits could merge into. An `input`
  // event is noted before React handles it (window, capture) and forgotten
  // after (window, bubble), so the edits it dispatches know their field.
  useEffect(() => {
    const press = () => {
      gesture.current = true;
      open.current = null;
    };
    const release = () => {
      gesture.current = false;
      open.current = null;
    };
    const focus = () => {
      open.current = null;
    };
    const inputStart = (event: Event) => {
      const type = event instanceof InputEvent ? event.inputType : '';
      input.current = event.target
        ? {box: event.target, own: type === 'historyUndo' || type === 'historyRedo'}
        : null;
    };
    const inputEnd = () => {
      input.current = null;
    };
    const listeners = new AbortController();
    const capture = {capture: true, signal: listeners.signal};
    window.addEventListener('pointerdown', press, capture);
    window.addEventListener('pointerup', release, capture);
    window.addEventListener('pointercancel', release, capture);
    window.addEventListener('focusin', focus, capture);
    window.addEventListener('input', inputStart, capture);
    window.addEventListener('input', inputEnd, {signal: listeners.signal});
    return () => listeners.abort();
  }, []);

  return {history, dispatch, latest, commit, undo, redo};
}
