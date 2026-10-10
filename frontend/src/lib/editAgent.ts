/**
 * 말로 편집 (Edit Agent) in the browser (ADR 0011). buildEditRequest turns
 * the editor state into an Edit Request; applyEditReply applies the checked
 * edit operations of the answer to the newest editor state, which the
 * editor then commits as one undo step. The server side is
 * yt/studio/edit_agent.py.
 *
 * Operations name Clips by Clip Number, as on screen when the request was
 * sent. SentEdit keeps the Clip ids behind those numbers, so every number
 * of one answer is read against the moment of sending and still reaches
 * the intended Clip when hand edits moved Clips while the request was
 * waiting; an operation on a Clip that is gone by then is skipped with a
 * note. Values follow the hand controls: the same reducer actions,
 * defaults and limits. The server already checked every operation against
 * the sent state (Clip Numbers, Clip kinds, files and value ranges), so
 * only what can change while the request waits is checked here.
 */

import {
  clipEdgeRange,
  editorReducer,
  type EditorAction,
  type EditorState,
} from './editor';
import {clampVideoBox, MIN_VIDEO_BOX, videoBox} from './framing';
import {sameContent} from './history';
import {sameTextLayout} from './look';
import {clamp, roundMs} from './timeline';
import type {
  Clip,
  ClipEdge,
  EditOperation,
  EditRequest,
  EditResponse,
  ImageOverlay,
  Look,
  LookPatch,
  Scenario,
  StudioConfig,
  TimeRange,
  TranscriptWord,
  UploadedAsset,
} from '../types';

/** Finished turns sent back as the conversation; the server reads as many. */
const HISTORY_TURNS = 10;

type OperationName = EditOperation['op'];
type Operation<K extends OperationName> = Extract<EditOperation, {op: K}>;

/** Korean names of the operations, the same as in the server's notes. */
const LABELS: Record<OperationName, string> = {
  setClipRange: '클립 구간 정하기',
  setClipEdge: '클립 끝 맞추기',
  moveClipEdge: '클립 끝 옮기기',
  shiftClip: '클립 옮기기',
  setClipDuration: '클립 길이 정하기',
  splitClip: '클립 나누기',
  deleteClip: '클립 지우기',
  moveClip: '클립 순서 바꾸기',
  swapClips: '클립 맞바꾸기',
  addSourceClip: '원본 클립 넣기',
  addMediaClip: '삽입 클립 넣기',
  setClipMute: '삽입 영상 소리',
  patchLook: '스타일 바꾸기',
  setOwnLook: '클립 스타일 정하기',
  addImage: '이미지 넣기',
  updateImage: '이미지 바꾸기',
  removeImage: '이미지 빼기',
  setWordText: '자막 글자 고치기',
  setLineText: '자막 줄 고치기',
  resetWordText: '자막 글자 되돌리기',
  cutWords: '단어 지우기',
  restoreWords: '단어 살리기',
  setCaptionMaxChars: '자막 줄 글자 수',
  setMusic: '배경음악 넣기',
  setMusicVolume: '음악 볼륨',
  removeMusic: '배경음악 빼기',
  resetShorts: '처음 제안으로 되돌리기',
};

/** One Edit Request of this editor session and what came of it. */
export interface EditTurn {
  request: string;
  reply: string;
  operations: EditOperation[];
  /** The undo step the answer became; null when it changed nothing. */
  stepId: number | null;
}

/** What the editor keeps of a sent Edit Request to apply its answer. */
interface SentEdit {
  scenarioId: string;
  /** Clip ids by Clip Number - 1, as on screen when the request was sent. */
  clipIds: readonly string[];
  /** The Clip selected when the request was sent. */
  selectedClipId: string | null;
}

/** What applying an answer needs besides the editor state. */
interface EditContext {
  config: StudioConfig;
  /** Transcript Words sorted by time; clip edges snap to them. */
  words: readonly TranscriptWord[];
  assets: ReadonlyMap<string, UploadedAsset>;
}

export interface AppliedEdit {
  /** The new editor state; `current` itself when nothing changed. */
  state: EditorState;
  changed: boolean;
  /**
   * The one-line summary: the answer's reply and what applying it did
   * besides (the Shorts it went to, Clip Numbers that changed while
   * waiting, own-Look Clips that a shared change reached), or why nothing
   * changed when the answer's operations did not apply.
   */
  reply: string;
  /** The summary to read aloud: the answer's speech in place of its reply. */
  speech: string;
  /** What was adjusted or skipped while applying, for the user. */
  notes: string[];
  /** The Clip to show from its start; null when no Clip changed. */
  focusClipIndex: number | null;
}

/**
 * The Edit Request for `text` from the Shorts on screen, and what to keep
 * of it to apply the answer.
 */
export function buildEditRequest(input: {
  text: string;
  state: EditorState;
  sourceId: string;
  /** Source Video second under the playhead; null over an inserted clip. */
  playheadSec: number | null;
  assets: ReadonlyMap<string, UploadedAsset>;
  /** Finished turns of this session, oldest first. */
  turns: readonly EditTurn[];
  /** Undo steps that are undone now (EditorHistory.reverted). */
  reverted: ReadonlySet<number>;
}): {body: EditRequest; sent: SentEdit} {
  const {state, playheadSec} = input;
  const {sourceDurationSec} = state;
  const scenario = state.scenarios[state.scenarioIndex];
  const selected = scenario.clips[state.clipIndex];
  const body: EditRequest = {
    sourceId: input.sourceId,
    request: input.text,
    scenario,
    shortsNumber: state.scenarioIndex + 1,
    shortsCount: state.scenarios.length,
    clipNumber: selected ? state.clipIndex + 1 : null,
    playheadSec,
    // An unknown length is Infinity in the editor, which JSON cannot carry.
    sourceDurationSec:
      Number.isFinite(sourceDurationSec) && sourceDurationSec > 0 ? sourceDurationSec : 0,
    cutWords: [...state.cutWords].sort((a, b) => a - b),
    wordText: Object.fromEntries(state.wordText),
    captionMaxChars: state.settings.captionMaxChars,
    assets: [...input.assets.values()],
    history: input.turns.slice(-HISTORY_TURNS).map((turn) => ({
      request: turn.request,
      reply: turn.reply,
      operations: turn.operations,
      undone: turn.stepId !== null && input.reverted.has(turn.stepId),
    })),
  };
  return {
    body,
    sent: {
      scenarioId: scenario.scenarioId,
      clipIds: scenario.clips.map((clip) => clip.clipId),
      selectedClipId: selected?.clipId ?? null,
    },
  };
}

/**
 * `look` with `patch` merged in, the way the style controls set it: a new
 * fit moves text still at the old fit's default places to the new fit's,
 * and a partial video box completes from the Look's box (or the template's)
 * and is clamped like a dragged box. `boxFitted` tells that the clamp moved
 * a requested box value.
 */
function patchedLook(
  look: Look,
  patch: LookPatch,
  config: StudioConfig,
): {look: Look; boxFitted: boolean} {
  const style = config.templateStyle;
  let framing = look.framingLayout;
  let textLayout = look.textLayout;
  let boxFitted = false;
  const framingPatch = patch.framingLayout;
  if (framingPatch?.fit !== undefined && framingPatch.fit !== framing.fit) {
    const defaults = config.defaultTextLayouts;
    if (sameTextLayout(textLayout, defaults[framing.fit])) {
      textLayout = defaults[framingPatch.fit];
    }
    framing = {...framing, fit: framingPatch.fit};
  }
  if (framingPatch?.crop) {
    framing = {...framing, crop: {...framing.crop, ...framingPatch.crop}};
  }
  if (framingPatch?.defaultBox) {
    framing = {...framing, box: null};
  } else if (framingPatch?.box) {
    const wanted = {
      ...(framing.box ?? videoBox(style, style.canvasWidth)),
      ...framingPatch.box,
    };
    const box = clampVideoBox(style, wanted);
    // The clamp also floors to even values; only a larger move is news.
    boxFitted = (['x', 'y', 'width', 'height'] as const).some(
      (key) => Math.abs(box[key] - wanted[key]) >= 2,
    );
    framing = {...framing, box};
  }
  if (patch.textLayout) {
    textLayout = {
      headline: {...textLayout.headline, ...patch.textLayout.headline},
      caption: {...textLayout.caption, ...patch.textLayout.caption},
    };
  }
  let lookStyle = look.style;
  if (patch.style) {
    const {headline, caption, ...rest} = patch.style;
    lookStyle = {
      ...lookStyle,
      ...rest,
      headline: {...lookStyle.headline, ...headline},
      caption: {...lookStyle.caption, ...caption},
    };
  }
  return {
    look: {
      ...look,
      headline: patch.headline ? {lines: [...patch.headline.lines]} : look.headline,
      framingLayout: framing,
      textLayout,
      style: lookStyle,
    },
    boxFitted,
  };
}

/** Applies the operations of one answer, in order, to a working state. */
class Applier {
  state: EditorState;
  readonly notes: string[] = [];
  /** The note of the first skipped operation; also in `notes`. */
  firstSkip = '';
  /** What the one-line summary tells besides the answer's reply. */
  readonly summary: string[] = [];
  private readonly sent: SentEdit;
  private readonly context: EditContext;
  /** Clips that clip operations changed, in order. */
  private readonly touched: string[] = [];
  private clipsChanged = false;
  /** Own-Look Clips that a change of the shared Look also reached. */
  private readonly alsoOwn = new Set<string>();
  /** An added Clip without a place goes after this one. */
  private insertAfterId: string | null;

  constructor(state: EditorState, sent: SentEdit, context: EditContext) {
    this.state = state;
    this.sent = sent;
    this.context = context;
    this.insertAfterId = sent.selectedClipId;
  }

  private get scenario(): Scenario {
    return this.state.scenarios[this.state.scenarioIndex];
  }

  private get clips(): readonly Clip[] {
    return this.scenario.clips;
  }

  note(text: string): void {
    if (!this.notes.includes(text)) {
      this.notes.push(text);
    }
  }

  private skipNote(text: string): void {
    this.note(text);
    this.firstSkip ||= text;
  }

  private skip(operation: EditOperation, reason: string): void {
    this.skipNote(`${LABELS[operation.op]}: ${reason} 건너뛰었어요.`);
  }

  /** Runs one reducer action; false when the reducer refused it. */
  private run(action: EditorAction): boolean {
    const next = editorReducer(this.state, action);
    if (next === this.state) {
      return false;
    }
    this.state = next;
    return true;
  }

  /** Records that a clip operation changed Clips, and which one. */
  private touch(clipId: string | null): void {
    this.clipsChanged = true;
    if (clipId !== null && !this.touched.includes(clipId)) {
      this.touched.push(clipId);
    }
  }

  /** The index now of the Clip that had Clip Number `number` when sent. */
  private clipIndex(operation: EditOperation, number: number | undefined): number | null {
    const clipId = number === undefined ? undefined : this.sent.clipIds[number - 1];
    const index = this.clips.findIndex((clip) => clip.clipId === clipId);
    if (index < 0) {
      this.skip(operation, `${number}번 클립이 이제 없어서`);
      return null;
    }
    return index;
  }

  /** Tells in the summary which Clips the answer names moved since sending. */
  noteRenumbered(operations: readonly EditOperation[]): void {
    const numbers = new Set<number>();
    for (const operation of operations) {
      if ('clip' in operation && typeof operation.clip === 'number') {
        numbers.add(operation.clip);
      }
      if ('otherClip' in operation && typeof operation.otherClip === 'number') {
        numbers.add(operation.otherClip);
      }
    }
    const moved = [...numbers]
      .sort((a, b) => a - b)
      .flatMap((number) => {
        const clipId = this.sent.clipIds[number - 1];
        const index = this.clips.findIndex((clip) => clip.clipId === clipId);
        return clipId !== undefined && index >= 0 && index !== number - 1
          ? [`${number}번→${index + 1}번`]
          : [];
      });
    if (moved.length > 0) {
      this.summary.push(`보낸 뒤 클립 번호가 바뀌어 지금 번호로 적용했어요: ${moved.join(', ')}.`);
    }
  }

  apply(operation: EditOperation): void {
    // The Clip an operation names is found here once; look operations name
    // one only with target 'clip'. An operation this page does not know
    // goes to the default case with its number unread.
    const number = 'clip' in operation && operation.op in LABELS ? operation.clip : undefined;
    const index = number === undefined ? -1 : this.clipIndex(operation, number);
    if (index === null) {
      return;
    }
    switch (operation.op) {
      case 'setClipRange':
        return this.setRange(operation, index, operation);
      case 'setClipEdge':
        return this.setEdge(operation, index, operation.edge, operation.atSec);
      case 'moveClipEdge':
        return this.moveClipEdge(operation, index);
      case 'shiftClip':
        return this.shiftClip(operation, index);
      case 'setClipDuration':
        return this.setClipDuration(operation, index);
      case 'splitClip':
        return this.splitClip(operation, index);
      case 'deleteClip':
        return this.deleteClip(operation, index);
      case 'moveClip':
        return this.moveClip(operation, index);
      case 'swapClips':
        return this.swapClips(operation, index);
      case 'addSourceClip':
        return this.addSourceClip(operation);
      case 'addMediaClip':
        return this.addMediaClip(operation);
      case 'setClipMute':
        this.run({type: 'setClipMute', index, muteAudio: operation.mute});
        this.touch(this.clips[index].clipId);
        return;
      case 'patchLook':
        return this.patchLook(operation, index);
      case 'setOwnLook':
        return this.setOwnLook(operation, index);
      case 'addImage':
        return this.addImage(operation, index);
      case 'updateImage':
        return this.updateImage(operation, index);
      case 'removeImage':
        return this.editImages(operation, index, () => null);
      case 'setWordText':
        this.run({type: 'setWordText', index: operation.word, text: operation.text});
        return;
      case 'setLineText':
        this.run({type: 'setLineWordsText', wordIndices: operation.words, text: operation.text});
        return;
      case 'resetWordText':
        for (const index of operation.words) {
          if (this.state.wordText.has(index)) {
            this.run({type: 'setWordText', index, text: null});
          }
        }
        return;
      case 'cutWords':
      case 'restoreWords':
        this.run({
          type: 'setWordsCut',
          wordIndices: operation.words,
          cut: operation.op === 'cutWords',
        });
        return;
      case 'setCaptionMaxChars':
        this.run({type: 'setCaptionMaxChars', maxChars: operation.maxChars});
        return;
      case 'setMusic':
        return this.setMusic(operation);
      case 'setMusicVolume':
        return this.setMusicVolume(operation);
      case 'removeMusic':
        if (this.scenario.music) {
          this.run({type: 'setMusic', music: null});
        } else {
          this.skip(operation, '배경음악이 없어서');
        }
        return;
      case 'resetShorts':
        this.run({type: 'resetScenario'});
        this.touch(null);
        return;
      default:
        // A newer server may know operations this page does not.
        this.skipNote('알 수 없는 동작은 건너뛰었어요.');
    }
  }

  /**
   * The Clip to show once every operation ran: the first Clip a clip
   * operation changed that is still there, else the Clip the last one left
   * selected; null when no Clip changed.
   */
  finish(): number | null {
    if (this.alsoOwn.size > 0) {
      const numbers = this.clips.flatMap((clip, index) =>
        this.alsoOwn.has(clip.clipId) ? [index + 1] : [],
      );
      if (numbers.length > 0) {
        this.summary.push(`자기 스타일이 있는 ${numbers.join(', ')}번 클립에도 적용했어요.`);
      }
    }
    if (!this.clipsChanged || this.clips.length === 0) {
      return null;
    }
    for (const clipId of this.touched) {
      const index = this.clips.findIndex((clip) => clip.clipId === clipId);
      if (index >= 0) {
        return index;
      }
    }
    return Math.min(this.state.clipIndex, this.clips.length - 1);
  }

  // -- Clips ----------------------------------------------------------------

  /** The end of the media a Clip plays: the Source Video or its file. */
  private limit(clip: Clip): number {
    if ((clip.mediaKind ?? 'source') === 'source') {
      return this.state.sourceDurationSec;
    }
    const record = clip.assetId ? this.context.assets.get(clip.assetId) : undefined;
    return record && record.durationSec > 0 ? record.durationSec : Number.POSITIVE_INFINITY;
  }

  /** Sets the range of the Clip at `index`; skips a range too short to play. */
  private setRange(operation: EditOperation, index: number, range: TimeRange): void {
    const {clipId} = this.clips[index];
    const rounded = {startSec: roundMs(range.startSec), endSec: roundMs(range.endSec)};
    const tooShort =
      rounded.endSec - rounded.startSec < this.state.settings.minSubcutSec - 1e-9;
    if (tooShort || !this.run({type: 'setClipRange', index, range: rounded})) {
      this.skip(operation, '구간이 너무 짧아서');
      return;
    }
    this.touch(clipId);
  }

  /** Puts one edge at `atSec` by the transcript panel's rule (clipEdgeRange). */
  private setEdge(operation: EditOperation, index: number, edge: ClipEdge, atSec: number): void {
    const clip = this.clips[index];
    const limit = this.limit(clip);
    this.setRange(
      operation,
      index,
      clipEdgeRange({
        clip,
        edge,
        atSec: clamp(atSec, 0, limit),
        words: (clip.mediaKind ?? 'source') === 'source' ? this.context.words : [],
        minSec: this.state.settings.minSubcutSec,
        sourceDurationSec: limit,
      }),
    );
  }

  private moveClipEdge(operation: Operation<'moveClipEdge'>, index: number): void {
    const clip = this.clips[index];
    const edgeSec = operation.edge === 'start' ? clip.startSec : clip.endSec;
    this.setEdge(operation, index, operation.edge, edgeSec + operation.deltaSec);
  }

  private shiftClip(operation: Operation<'shiftClip'>, index: number): void {
    const clip = this.clips[index];
    const length = clip.endSec - clip.startSec;
    const limit = this.limit(clip);
    const wanted = clip.startSec + operation.deltaSec;
    const startSec = clamp(wanted, 0, Math.max(0, limit - length));
    if (Math.abs(startSec - wanted) > 1e-3) {
      const edge = startSec < wanted ? '끝' : '처음';
      const moved = Number(Math.abs(startSec - clip.startSec).toFixed(2));
      this.note(`${LABELS.shiftClip}: 영상 ${edge}에 닿아 ${moved}초만 옮겼어요.`);
    }
    this.setRange(operation, index, {startSec, endSec: Math.min(limit, startSec + length)});
  }

  private setClipDuration(operation: Operation<'setClipDuration'>, index: number): void {
    const clip = this.clips[index];
    const wanted = clip.startSec + operation.durationSec;
    const endSec = Math.min(this.limit(clip), wanted);
    if (endSec < wanted - 1e-3) {
      this.note(`${LABELS.setClipDuration}: 영상 끝까지만 늘렸어요.`);
    }
    this.setRange(operation, index, {startSec: clip.startSec, endSec});
  }

  private splitClip(operation: Operation<'splitClip'>, index: number): void {
    const {clipId} = this.clips[index];
    if (this.run({type: 'splitClip', index, atSec: roundMs(operation.atSec)})) {
      this.touch(clipId);
    } else {
      this.skip(operation, '나눌 지점이 클립 안에 없어서');
    }
  }

  private deleteClip(operation: Operation<'deleteClip'>, index: number): void {
    if (this.clips.length <= 1) {
      this.skip(operation, '마지막 남은 클립이라');
      return;
    }
    this.run({type: 'deleteClip', index});
    this.touch(null);
  }

  /** Takes a Clip out and puts it back elsewhere ("맨 앞으로"). */
  private moveClip(operation: Operation<'moveClip'>, index: number): void {
    const {clipId} = this.clips[index];
    let to: number;
    if (operation.place === 'first') {
      to = 0;
    } else if (operation.place === 'last') {
      to = this.clips.length - 1;
    } else {
      const other = this.clipIndex(operation, operation.otherClip);
      if (other === null) {
        return;
      }
      // Positions after the moved Clip shift down once it is taken out.
      const otherAfter = other > index ? other - 1 : other;
      to = operation.place === 'before' ? otherAfter : otherAfter + 1;
    }
    if (this.run({type: 'moveClipTo', index, to})) {
      this.touch(clipId);
    }
  }

  private swapClips(operation: Operation<'swapClips'>, index: number): void {
    const other = this.clipIndex(operation, operation.otherClip);
    if (other === null) {
      return;
    }
    const {clipId} = this.clips[index];
    if (this.run({type: 'moveClip', index, offset: other - index})) {
      this.touch(clipId);
    }
  }

  /** afterIndex of an added Clip; null when the Clip it goes next to is gone. */
  private afterIndex(
    operation: Operation<'addSourceClip'> | Operation<'addMediaClip'>,
  ): number | null {
    switch (operation.place) {
      case 'first':
        return -1;
      case 'last':
        return this.clips.length - 1;
      case 'before':
      case 'after': {
        const other = this.clipIndex(operation, operation.otherClip);
        if (other === null) {
          return null;
        }
        return operation.place === 'before' ? other - 1 : other;
      }
      default: {
        // After the Clip selected when sending, then after the Clips this
        // answer added there, so several adds keep their order.
        const index = this.clips.findIndex((clip) => clip.clipId === this.insertAfterId);
        return index >= 0 ? index : this.state.clipIndex;
      }
    }
  }

  /** Records the Clip an add just inserted; insertClip selects it. */
  private added(operation: Operation<'addSourceClip'> | Operation<'addMediaClip'>): void {
    const {clipId} = this.clips[this.state.clipIndex];
    if (operation.place === undefined) {
      this.insertAfterId = clipId;
    }
    this.touch(clipId);
  }

  private addSourceClip(operation: Operation<'addSourceClip'>): void {
    const afterIndex = this.afterIndex(operation);
    if (afterIndex === null) {
      return;
    }
    const {startSec, endSec} = operation;
    if (this.run({type: 'addClip', range: {startSec, endSec}, afterIndex})) {
      this.added(operation);
    } else {
      this.skip(operation, '구간이 너무 짧아서');
    }
  }

  private addMediaClip(operation: Operation<'addMediaClip'>): void {
    const afterIndex = this.afterIndex(operation);
    if (afterIndex === null) {
      return;
    }
    const {mediaKind, assetId, file, startSec, endSec} = operation;
    this.run({
      type: 'addMediaClip',
      mediaKind,
      assetId,
      range: {startSec, endSec},
      purpose: file,
      afterIndex,
    });
    this.added(operation);
  }

  // -- Looks ----------------------------------------------------------------

  /** Gives the Clip at `index` its own copy of the shared Look unless it has one. */
  private ownLook(index: number): Look {
    const clip = this.clips[index];
    if (clip.look) {
      return clip.look;
    }
    // setOwnLook copies the shared Look every time, so only when missing.
    this.run({type: 'setOwnLook', index, own: true});
    return this.clips[index].look ?? this.scenario.look;
  }

  /** Puts `look` patched at `clipId` (null: the shared Look). */
  private putPatched(clipId: string | null, look: Look, patch: LookPatch): void {
    const patched = patchedLook(look, patch, this.context.config);
    if (patched.boxFitted) {
      this.note(`영상 박스는 가로세로 ${MIN_VIDEO_BOX} 이상, 화면 안이어야 해서 맞췄어요.`);
    }
    this.run({type: 'setLook', clipId, look: patched.look});
  }

  /**
   * Without a Clip the shared Look changes, and every Clip with its own
   * Look gets the same values; with one, only that Clip's own Look.
   */
  private patchLook(operation: Operation<'patchLook'>, index: number): void {
    const patch = operation.look ?? {};
    if (operation.target === 'clip') {
      const look = this.ownLook(index);
      const {clipId} = this.clips[index];
      this.putPatched(clipId, look, patch);
      this.touch(clipId);
      return;
    }
    this.putPatched(null, this.scenario.look, patch);
    for (const clip of this.clips) {
      if (clip.look) {
        this.putPatched(clip.clipId, clip.look, patch);
        this.alsoOwn.add(clip.clipId);
      }
    }
  }

  private setOwnLook(operation: Operation<'setOwnLook'>, index: number): void {
    const clip = this.clips[index];
    if (operation.own === Boolean(clip.look)) {
      return;
    }
    this.run({type: 'setOwnLook', index, own: operation.own});
    this.touch(clip.clipId);
  }

  private addImage(operation: Operation<'addImage'>, index: number): void {
    const {assetId, x, y, width, height, rotationDeg} = operation;
    const image = {assetId, x, y, width, height, rotationDeg};
    if (operation.target === 'clip') {
      this.ownLook(index);
      const {clipId} = this.clips[index];
      this.run({type: 'addImage', clipId, image});
      this.touch(clipId);
      return;
    }
    this.run({type: 'addImage', clipId: null, image});
    // The same overlay (and id) goes on every own Look, so later changes
    // to it reach them all.
    const overlay = this.scenario.look.images.at(-1);
    if (!overlay) {
      return;
    }
    for (const clip of this.clips) {
      if (clip.look) {
        const look = {...clip.look, images: [...clip.look.images, overlay]};
        this.run({type: 'setLook', clipId: clip.clipId, look});
        this.alsoOwn.add(clip.clipId);
      }
    }
  }

  private updateImage(operation: Operation<'updateImage'>, index: number): void {
    this.editImages(operation, index, (image) => {
      const width = operation.width ?? image.width;
      // A new width keeps the image's aspect ratio, as the size slider does.
      const height =
        operation.width === undefined
          ? image.height
          : Math.max(1, Math.round((width * image.height) / image.width));
      return {
        ...image,
        x: operation.x ?? image.x,
        y: operation.y ?? image.y,
        width,
        height,
        rotationDeg: operation.rotationDeg ?? image.rotationDeg,
      };
    });
  }

  /**
   * Replaces (or removes, on null) the Image Overlay an operation names: in
   * the own Look of the Clip at `index`, or in every Look of the Shorts
   * that holds it.
   */
  private editImages(
    operation: Operation<'updateImage'> | Operation<'removeImage'>,
    index: number,
    edit: (image: ImageOverlay) => ImageOverlay | null,
  ): void {
    const {imageId} = operation;
    const holds = (look: Look) => look.images.some((image) => image.overlayId === imageId);
    const edited = (look: Look): Look => ({
      ...look,
      images: look.images.flatMap((image) => {
        if (image.overlayId !== imageId) {
          return [image];
        }
        const next = edit(image);
        return next ? [next] : [];
      }),
    });
    const missing = `'${imageId}' 이미지가 없어서`;
    if (operation.target === 'clip') {
      const clip = this.clips[index];
      if (!holds(clip.look ?? this.scenario.look)) {
        this.skip(operation, missing);
        return;
      }
      const look = this.ownLook(index);
      this.run({type: 'setLook', clipId: clip.clipId, look: edited(look)});
      this.touch(clip.clipId);
      return;
    }
    let found = false;
    if (holds(this.scenario.look)) {
      this.run({type: 'setLook', clipId: null, look: edited(this.scenario.look)});
      found = true;
    }
    for (const clip of this.clips) {
      if (clip.look && holds(clip.look)) {
        this.run({type: 'setLook', clipId: clip.clipId, look: edited(clip.look)});
        this.alsoOwn.add(clip.clipId);
        found = true;
      }
    }
    if (!found) {
      this.skip(operation, missing);
    }
  }

  // -- Music ----------------------------------------------------------------

  private setMusic(operation: Operation<'setMusic'>): void {
    const volume =
      operation.volume ??
      this.scenario.music?.volume ??
      this.context.config.composition.defaultMusicVolume;
    this.run({type: 'setMusic', music: {assetId: operation.assetId, volume}});
  }

  private setMusicVolume(operation: Operation<'setMusicVolume'>): void {
    const {music} = this.scenario;
    if (!music) {
      this.skip(operation, '배경음악이 없어서');
      return;
    }
    this.run({type: 'setMusic', music: {...music, volume: operation.volume}});
  }
}

/**
 * Applies the operations of an answer to `current`, the newest editor
 * state, in the Shorts the request was sent from (which comes on screen).
 * Selection follows the edit: when Clips changed, the first Clip changed
 * is selected; style-only and caption edits keep the selection.
 */
export function applyEditReply(
  current: EditorState,
  sent: SentEdit,
  answer: Pick<EditResponse, 'reply' | 'speech' | 'operations'>,
  context: EditContext,
): AppliedEdit {
  const {operations} = answer;
  const scenarioIndex = current.scenarios.findIndex(
    (scenario) => scenario.scenarioId === sent.scenarioId,
  );
  const start =
    scenarioIndex === current.scenarioIndex
      ? current
      : editorReducer(current, {type: 'selectScenario', index: scenarioIndex});
  const applier = new Applier(start, sent, context);
  applier.noteRenumbered(operations);
  for (const operation of operations) {
    applier.apply(operation);
  }
  const focusClipIndex = applier.finish();
  if (sameContent(current, applier.state)) {
    // An answer without operations (a question back, or a reason it could
    // not edit) keeps its reply. When its operations did not apply, the
    // reply tells of edits that did not happen, so it says why instead, as
    // the server does when it drops every operation. The spoken form
    // leaves the reason to the notes, which are read after it.
    const failed = '요청한 편집을 적용하지 못했어요.';
    const same = '이미 요청한 대로라 바뀐 값이 없어요.';
    return {
      state: current,
      changed: false,
      reply:
        operations.length === 0
          ? answer.reply
          : applier.firstSkip
            ? `${failed} ${applier.firstSkip}`
            : same,
      speech:
        operations.length === 0 ? answer.speech : applier.firstSkip ? failed : same,
      notes: applier.notes,
      focusClipIndex: null,
    };
  }
  const summary =
    scenarioIndex === current.scenarioIndex
      ? applier.summary
      : [`요청을 보낸 ${scenarioIndex + 1}번 Shorts에 적용했어요.`, ...applier.summary];
  const state =
    focusClipIndex === null ? applier.state : {...applier.state, clipIndex: focusClipIndex};
  const join = (first: string) => [first, ...summary].filter((text) => text !== '').join(' ');
  return {
    state,
    changed: true,
    reply: join(answer.reply),
    speech: join(answer.speech),
    notes: applier.notes,
    focusClipIndex,
  };
}
