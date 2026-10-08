/**
 * Editor state of one analysis: the user's copies of Gemini's Scenarios and
 * transcript-wide caption edits. Every change goes through editorReducer.
 *
 * Look edits name their target: a Clip id for a Clip with its own Look, or
 * null for the Scenario's shared Look (see lib/look.ts lookTarget).
 */

import type {
  AnalysisResult,
  BackgroundMusic,
  Clip,
  CompositionSettings,
  ImageOverlay,
  Look,
  Scenario,
  TimeRange,
} from '../types';

export interface EditorState {
  /** Gemini's Scenarios, kept for "reset". */
  original: readonly Scenario[];
  scenarios: Scenario[];
  scenarioIndex: number;
  clipIndex: number;
  cutWords: ReadonlySet<number>;
  wordText: ReadonlyMap<number, string>;
  settings: CompositionSettings;
  sourceDurationSec: number;
  /** Counter that keeps ids of user-created Clips unique. */
  createdClips: number;
  /** Counter that keeps ids of Image Overlays unique. */
  createdImages: number;
}

export type EditorAction =
  | {type: 'selectScenario'; index: number}
  | {type: 'selectClip'; index: number}
  | {type: 'setClipRange'; index: number; range: TimeRange}
  | {type: 'setClipMute'; index: number; muteAudio: boolean}
  | {type: 'moveClip'; index: number; offset: number}
  | {type: 'splitClip'; index: number; atSec: number}
  | {type: 'deleteClip'; index: number}
  | {type: 'addClip'; range: TimeRange; afterIndex?: number}
  | {
      type: 'addMediaClip';
      mediaKind: 'image' | 'video';
      assetId: string;
      range: TimeRange;
      purpose: string;
      afterIndex?: number;
    }
  /** Replaces the Look at `clipId` (null: the shared Look). */
  | {type: 'setLook'; clipId: string | null; look: Look}
  | {type: 'addImage'; clipId: string | null; image: Omit<ImageOverlay, 'overlayId'>}
  /** Gives a Clip its own copy of the shared Look, or drops its own Look. */
  | {type: 'setOwnLook'; index: number; own: boolean}
  | {type: 'setMusic'; music: BackgroundMusic | null}
  | {type: 'resetScenario'}
  | {type: 'setWordText'; index: number; text: string | null}
  | {type: 'setLineWordsText'; wordIndices: readonly number[]; text: string}
  | {type: 'toggleCutWord'; index: number}
  | {type: 'setCaptionMaxChars'; maxChars: number};

export function createEditorState(
  result: AnalysisResult,
  settings: CompositionSettings,
): EditorState {
  const duration = result.sourceVideo.durationSec;
  return {
    original: result.scenarios,
    scenarios: result.scenarios,
    scenarioIndex: 0,
    clipIndex: 0,
    cutWords: new Set<number>(),
    wordText: new Map(),
    settings,
    sourceDurationSec: duration > 0 ? duration : Number.POSITIVE_INFINITY,
    createdClips: 0,
    createdImages: 0,
  };
}

/** Clamps a range to the Source Video, or null if it is too short. */
function validRange(state: EditorState, range: TimeRange): TimeRange | null {
  const startSec = Math.max(0, range.startSec);
  const endSec = Math.min(state.sourceDurationSec, range.endSec);
  return endSec - startSec >= state.settings.minSubcutSec
    ? {startSec, endSec}
    : null;
}

function validMediaRange(
  state: EditorState,
  mediaKind: 'image' | 'video',
  range: TimeRange,
): TimeRange {
  const minSec = state.settings.minSubcutSec;
  if (mediaKind === 'image') {
    const duration = Math.max(minSec, Math.min(60, range.endSec - range.startSec));
    return {startSec: 0, endSec: duration};
  }
  const startSec = Math.max(0, range.startSec);
  const endSec = Math.max(startSec + minSec, range.endSec);
  return {startSec, endSec};
}

function currentScenario(state: EditorState): Scenario {
  return state.scenarios[state.scenarioIndex];
}

function withScenario(
  state: EditorState,
  scenario: Scenario,
  clipIndex: number,
): EditorState {
  const scenarios = state.scenarios.map((item, index) =>
    index === state.scenarioIndex ? scenario : item,
  );
  const lastClip = Math.max(0, scenario.clips.length - 1);
  return {
    ...state,
    scenarios,
    clipIndex: Math.min(Math.max(0, clipIndex), lastClip),
  };
}

function withClips(
  state: EditorState,
  clips: Clip[],
  clipIndex: number,
): EditorState {
  return withScenario(state, {...currentScenario(state), clips}, clipIndex);
}

function newClipId(state: EditorState): string {
  return `${currentScenario(state).scenarioId}-u${state.createdClips + 1}`;
}

function clipAt(clips: readonly Clip[], index: number): Clip | undefined {
  return index >= 0 && index < clips.length ? clips[index] : undefined;
}

/** Inserts a new `clip` after `afterIndex` (default: the selected Clip) and selects it. */
function insertClip(
  state: EditorState,
  clip: Clip,
  afterIndex: number | undefined,
): EditorState {
  const clips = currentScenario(state).clips;
  const baseIndex = afterIndex ?? state.clipIndex;
  const at = clips.length === 0 ? 0 : Math.min(clips.length, Math.max(0, baseIndex + 1));
  const next = [...clips.slice(0, at), clip, ...clips.slice(at)];
  return {
    ...withClips(state, next, at),
    createdClips: state.createdClips + 1,
  };
}

/** The Look at `clipId`, falling back to the shared Look. */
function lookAt(scenario: Scenario, clipId: string | null): Look {
  return scenario.clips.find((clip) => clip.clipId === clipId)?.look ?? scenario.look;
}

/** Puts `look` at `clipId` if that Clip has its own Look, else shares it. */
function withLook(state: EditorState, clipId: string | null, look: Look): EditorState {
  const scenario = currentScenario(state);
  const owner = scenario.clips.find((clip) => clip.clipId === clipId && clip.look);
  const next = owner
    ? {
        ...scenario,
        clips: scenario.clips.map((clip) => (clip === owner ? {...clip, look} : clip)),
      }
    : {...scenario, look};
  return withScenario(state, next, state.clipIndex);
}

export function editorReducer(
  state: EditorState,
  action: EditorAction,
): EditorState {
  const clips = currentScenario(state).clips;
  switch (action.type) {
    case 'selectScenario':
      return {...state, scenarioIndex: action.index, clipIndex: 0};
    case 'selectClip':
      return {...state, clipIndex: action.index};
    case 'setClipRange': {
      const target = clipAt(clips, action.index);
      if (!target) {
        return state;
      }
      const mediaKind = target.mediaKind ?? 'source';
      const range =
        mediaKind === 'source'
          ? validRange(state, action.range)
          : validMediaRange(state, mediaKind, action.range);
      if (!range) {
        return state;
      }
      const next = clips.map((item, index) =>
        index === action.index ? {...item, ...range} : item,
      );
      return withClips(state, next, action.index);
    }
    case 'setClipMute': {
      if (!clipAt(clips, action.index)) {
        return state;
      }
      const next = clips.map((item, index) =>
        index === action.index ? {...item, muteAudio: action.muteAudio} : item,
      );
      return withClips(state, next, action.index);
    }
    case 'moveClip': {
      const moved = clipAt(clips, action.index);
      const target = action.index + action.offset;
      const displaced = clipAt(clips, target);
      if (!moved || !displaced) {
        return state;
      }
      const next = [...clips];
      next[action.index] = displaced;
      next[target] = moved;
      return withClips(state, next, target);
    }
    case 'splitClip': {
      const clip = clipAt(clips, action.index);
      const minSec = state.settings.minSubcutSec;
      if (
        !clip ||
        action.atSec - clip.startSec < minSec ||
        clip.endSec - action.atSec < minSec
      ) {
        return state;
      }
      const first = {...clip, endSec: action.atSec};
      const second = {...clip, clipId: newClipId(state), startSec: action.atSec};
      const next = [
        ...clips.slice(0, action.index),
        first,
        second,
        ...clips.slice(action.index + 1),
      ];
      return {
        ...withClips(state, next, action.index),
        createdClips: state.createdClips + 1,
      };
    }
    case 'deleteClip': {
      const next = clips.filter((_, index) => index !== action.index);
      return withClips(state, next, Math.min(action.index, next.length - 1));
    }
    case 'addClip': {
      const range = validRange(state, action.range);
      if (!range) {
        return state;
      }
      const clip: Clip = {
        clipId: newClipId(state),
        ...range,
        speaker: '',
        purpose: '',
        look: null,
        mediaKind: 'source',
        assetId: null,
        muteAudio: false,
      };
      return insertClip(state, clip, action.afterIndex);
    }
    case 'addMediaClip': {
      const range = validMediaRange(state, action.mediaKind, action.range);
      const clip: Clip = {
        clipId: newClipId(state),
        ...range,
        speaker: action.mediaKind === 'image' ? '이미지' : '외부 영상',
        purpose: action.purpose,
        look: null,
        mediaKind: action.mediaKind,
        assetId: action.assetId,
        muteAudio: false,
      };
      return insertClip(state, clip, action.afterIndex);
    }
    case 'setLook':
      return withLook(state, action.clipId, action.look);
    case 'addImage': {
      const look = lookAt(currentScenario(state), action.clipId);
      const image: ImageOverlay = {
        ...action.image,
        overlayId: `image-${state.createdImages + 1}`,
      };
      return {
        ...withLook(state, action.clipId, {...look, images: [...look.images, image]}),
        createdImages: state.createdImages + 1,
      };
    }
    case 'setOwnLook': {
      const scenario = currentScenario(state);
      const clip = clipAt(clips, action.index);
      if (!clip) {
        return state;
      }
      const look = action.own ? structuredClone(scenario.look) : null;
      const next = clips.map((item, index) => (index === action.index ? {...item, look} : item));
      return withClips(state, next, action.index);
    }
    case 'setMusic':
      return withScenario(
        state,
        {...currentScenario(state), music: action.music},
        state.clipIndex,
      );
    case 'resetScenario':
      return withScenario(state, state.original[state.scenarioIndex], 0);
    case 'setWordText': {
      const wordText = new Map(state.wordText);
      if (action.text === null) {
        wordText.delete(action.index);
      } else {
        wordText.set(action.index, action.text);
      }
      return {...state, wordText};
    }
    case 'setLineWordsText': {
      const {wordIndices, text} = action;
      if (wordIndices.length === 0) {
        return state;
      }
      const tokens = text
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);
      const wordText = new Map(state.wordText);
      const cutWords = new Set(state.cutWords);
      wordIndices.forEach((wordIndex, idx) => {
        cutWords.delete(wordIndex);
        if (tokens.length === 0) {
          wordText.set(wordIndex, '');
        } else if (idx < wordIndices.length - 1) {
          wordText.set(wordIndex, tokens[idx] ?? '');
        } else {
          const rest = tokens.slice(idx).join(' ');
          wordText.set(wordIndex, rest);
        }
      });
      return {...state, wordText, cutWords};
    }
    case 'toggleCutWord': {
      const cutWords = new Set(state.cutWords);
      if (!cutWords.delete(action.index)) {
        cutWords.add(action.index);
      }
      return {...state, cutWords};
    }
    case 'setCaptionMaxChars': {
      const maxChars = Math.max(4, Math.min(40, Math.round(action.maxChars)));
      return {
        ...state,
        settings: {...state.settings, captionMaxChars: maxChars},
      };
    }
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}
