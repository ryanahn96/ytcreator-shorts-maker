/**
 * Client-side edit resolution: Subcuts, caption cues, the RenderPlan and the
 * source-to-output time mapping used by the preview.
 *
 * It runs on every edit so the editor, preview and export stay in sync
 * without a server round trip. The backend (src/render/composer.py) then
 * re-validates the plan and snaps it to the frame grid. Clips meet with
 * hard cuts, so picture and sound share one segment list.
 */

import {effectiveLook} from './look';
import type {
  CaptionCue,
  Clip,
  ClipMediaKind,
  CompositionSettings,
  CueWord,
  Look,
  RenderClip,
  RenderPlan,
  Scenario,
  TimeRange,
  TranscriptWord,
} from '../types';

export type SubcutSettings = Pick<
  CompositionSettings,
  | 'silenceThresholdSec'
  | 'cutMarginSec'
  | 'minSubcutSec'
  | 'captionMaxChars'
  | 'captionMaxGapSec'
>;

/** Transcript Words sorted by start, plus the first word of every line. */
export interface Transcript {
  words: readonly TranscriptWord[];
  lineStarts: ReadonlySet<number>;
}

/** Caption edits that apply to the whole transcript, across Scenarios. */
export interface TranscriptEdits {
  /** Words removed from audio and captions (Gemini fillers + user picks). */
  cutWords: ReadonlySet<number>;
  /** Caption text overrides by word index; '' hides the word. */
  wordText: ReadonlyMap<number, string>;
}

export interface ResolvedClip {
  clip: Clip;
  /** The Look shown while this Clip plays (its own or the shared one). */
  look: Look;
  /** Transcript Words that start inside the Clip. */
  words: readonly TranscriptWord[];
  subcuts: TimeRange[];
  /** Index in RenderPlan.clips, or null when no Subcut is left. */
  planIndex: number | null;
}

/** A Subcut placed on the output timeline (picture and sound alike). */
export interface OutputSegment extends TimeRange {
  planIndex: number;
  outputStartSec: number;
  mediaKind: ClipMediaKind;
  assetId: string | null;
  muteAudio: boolean;
}

/** A caption on the output timeline. */
export interface OutputCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface ResolvedScenario {
  clips: ResolvedClip[];
  plan: RenderPlan | null;
  segments: OutputSegment[];
  cues: OutputCue[];
  durationSec: number;
}

/** `seconds` rounded to whole milliseconds. */
export function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** `value` limited to `low`..`high` (`high` wins when they cross). */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function totalSec(ranges: readonly TimeRange[]): number {
  return ranges.reduce((sum, range) => sum + range.endSec - range.startSec, 0);
}

/** Index of the first word starting at or after `seconds`. */
export function firstWordAtOrAfter(
  words: readonly TranscriptWord[],
  seconds: number,
): number {
  let low = 0;
  let high = words.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (words[middle].startSec < seconds) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Words whose start lies in [range.startSec, range.endSec). */
export function wordsStartingIn(
  words: readonly TranscriptWord[],
  range: TimeRange,
): TranscriptWord[] {
  return words.slice(
    firstWordAtOrAfter(words, range.startSec),
    firstWordAtOrAfter(words, range.endSec),
  );
}

/** Moves `seconds` to the nearest word start or end among `words`. */
export function snapToWord(
  words: readonly TranscriptWord[],
  seconds: number,
  edge: 'start' | 'end',
): number {
  let best = seconds;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const word of words) {
    const candidate = edge === 'start' ? word.startSec : word.endSec;
    const distance = Math.abs(candidate - seconds);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Removes `removals` from `range`; drops pieces shorter than `minSec`. */
export function subtractRanges(
  range: TimeRange,
  removals: readonly TimeRange[],
  minSec: number,
): TimeRange[] {
  const kept: TimeRange[] = [];
  let cursor = range.startSec;
  const sorted = [...removals].sort((a, b) => a.startSec - b.startSec);
  for (const removal of sorted) {
    if (removal.startSec >= range.endSec) {
      break;
    }
    if (removal.endSec <= cursor) {
      continue;
    }
    if (removal.startSec > cursor) {
      kept.push({startSec: cursor, endSec: removal.startSec});
    }
    cursor = removal.endSec;
  }
  if (cursor < range.endSec) {
    kept.push({startSec: cursor, endSec: range.endSec});
  }
  return kept.filter((piece) => piece.endSec - piece.startSec >= minSec);
}

/** Pauses long enough to remove, shrunk by the cut margin on both sides. */
function pauseRemovals(
  pauses: readonly TimeRange[],
  range: TimeRange,
  settings: SubcutSettings,
): TimeRange[] {
  const removals: TimeRange[] = [];
  for (const pause of pauses) {
    const overlaps =
      pause.endSec > range.startSec && pause.startSec < range.endSec;
    if (
      !overlaps ||
      pause.endSec - pause.startSec < settings.silenceThresholdSec
    ) {
      continue;
    }
    const startSec = pause.startSec + settings.cutMarginSec;
    const endSec = pause.endSec - settings.cutMarginSec;
    if (endSec > startSec) {
      removals.push({startSec, endSec});
    }
  }
  return removals;
}

function captionText(word: TranscriptWord, edits: TranscriptEdits): string {
  return (edits.wordText.get(word.index) ?? word.text).trim();
}

function maxWordDurationSec(text: string): number {
  const clean = text.replace(/[.,?!:;"'()[\]…\-—]/g, '').length;
  return Math.min(1.2, Math.max(0.35, Math.max(1, clean) * 0.16 + 0.15));
}

/** Groups a Clip's words into caption lines. */
function captionCues(
  resolved: Pick<ResolvedClip, 'clip' | 'words'>,
  planIndex: number,
  transcript: Transcript,
  edits: TranscriptEdits,
  pauses: readonly TimeRange[],
  settings: SubcutSettings,
): CaptionCue[] {
  const {clip, words} = resolved;
  const longPauses = pauses.filter(
    (pause) =>
      pause.endSec - pause.startSec >= settings.captionMaxGapSec &&
      pause.endSec > clip.startSec &&
      pause.startSec < clip.endSec,
  );
  const pausedBetween = (fromSec: number, toSec: number) =>
    longPauses.some((pause) => {
      const middle = (pause.startSec + pause.endSec) / 2;
      return middle > fromSec && middle < toSec;
    });

  const cues: CaptionCue[] = [];
  let line: CueWord[] = [];
  let chars = 0;
  let previousStart = clip.startSec;
  let previousEnd = clip.startSec;
  for (const word of words) {
    const text = captionText(word, edits);
    if (word.isSoundTag || edits.cutWords.has(word.index) || !text) {
      continue;
    }
    const wordEnd = Math.max(
      word.startSec,
      Math.min(word.endSec, clip.endSec),
    );
    const maxWordSec = maxWordDurationSec(text);
    const wordStart =
      wordEnd - word.startSec > maxWordSec
        ? Math.max(previousEnd, word.startSec, wordEnd - maxWordSec)
        : word.startSec;
    const breaks =
      line.length > 0 &&
      (transcript.lineStarts.has(word.index) ||
        chars + 1 + text.length > settings.captionMaxChars ||
        wordStart - previousEnd >= settings.captionMaxGapSec ||
        pausedBetween(previousStart, wordStart));
    if (breaks) {
      cues.push({clipIndex: planIndex, words: line});
      line = [];
      chars = 0;
    }
    chars += (line.length > 0 ? 1 : 0) + text.length;
    line.push({
      text,
      startSec: wordStart,
      endSec: Math.max(wordStart, wordEnd),
    });
    previousStart = wordStart;
    previousEnd = Math.max(wordStart, wordEnd);
  }
  if (line.length > 0) {
    cues.push({clipIndex: planIndex, words: line});
  }
  return cues;
}

function outputSegments(clips: readonly RenderClip[]): OutputSegment[] {
  const segments: OutputSegment[] = [];
  let cursor = 0;
  clips.forEach((clip, planIndex) => {
    const mediaKind: ClipMediaKind = clip.mediaKind ?? 'source';
    const assetId = clip.assetId ?? null;
    const muteAudio = Boolean(clip.muteAudio);
    for (const subcut of clip.subcuts) {
      segments.push({
        ...subcut,
        planIndex,
        outputStartSec: cursor,
        mediaKind,
        assetId,
        muteAudio,
      });
      cursor += subcut.endSec - subcut.startSec;
    }
  });
  return segments;
}

/** Maps a source time inside a Clip to output time (mirrors _to_output). */
function toOutput(seconds: number, segments: readonly OutputSegment[]): number {
  for (const segment of segments) {
    if (seconds <= segment.startSec) {
      return segment.outputStartSec;
    }
    if (seconds < segment.endSec) {
      return segment.outputStartSec + (seconds - segment.startSec);
    }
  }
  const last = segments[segments.length - 1];
  return last.outputStartSec + (last.endSec - last.startSec);
}

function outputCues(
  plan: RenderPlan,
  segments: readonly OutputSegment[],
  minCueSec: number,
): OutputCue[] {
  const byClip = new Map<number, OutputSegment[]>();
  for (const segment of segments) {
    byClip.set(segment.planIndex, [
      ...(byClip.get(segment.planIndex) ?? []),
      segment,
    ]);
  }
  const cues: OutputCue[] = [];
  for (const cue of plan.cues) {
    const clipSegments = byClip.get(cue.clipIndex);
    if (!clipSegments) {
      continue;
    }
    const startSec = toOutput(cue.words[0].startSec, clipSegments);
    const endSec = toOutput(cue.words[cue.words.length - 1].endSec, clipSegments);
    if (endSec - startSec >= minCueSec) {
      const text = cue.words.map((word) => word.text).join(' ');
      cues.push({startSec, endSec, text});
    }
  }
  cues.sort((a, b) => a.startSec - b.startSec);
  return cues.flatMap((cue, index) => {
    const next = cues[index + 1];
    const endSec = next ? Math.min(cue.endSec, next.startSec) : cue.endSec;
    return endSec - cue.startSec >= minCueSec ? [{...cue, endSec}] : [];
  });
}

/**
 * The pieces of `range` that are played: the range minus pauses of at
 * least silenceThresholdSec (shrunk by cutMarginSec) and minus cut words.
 * Pieces shorter than minSubcutSec are dropped.
 *
 * `words` are the Transcript Words that start inside `range`.
 */
export function clipSubcuts(input: {
  range: TimeRange;
  words: readonly TranscriptWord[];
  edits: TranscriptEdits;
  pauses: readonly TimeRange[];
  settings: SubcutSettings;
}): TimeRange[] {
  const {range, words, edits, pauses, settings} = input;
  const cutRanges = words
    .filter((word) => edits.cutWords.has(word.index))
    .map((word) => ({
      startSec: word.startSec,
      endSec: Math.min(word.endSec, range.endSec),
    }));
  return subtractRanges(
    range,
    [...pauseRemovals(pauses, range, settings), ...cutRanges],
    settings.minSubcutSec,
  );
}

/**
 * Resolves an edited Scenario into Subcuts, captions and a RenderPlan.
 *
 * Subcuts follow clipSubcuts. Captions skip sound tags, cut words and
 * words whose edited text is empty.
 */
export function resolveScenario(input: {
  scenario: Scenario;
  transcript: Transcript;
  edits: TranscriptEdits;
  pauses: readonly TimeRange[];
  settings: SubcutSettings;
  minCueSec: number;
}): ResolvedScenario {
  const {scenario, transcript, edits, pauses, settings} = input;
  const planClips: RenderClip[] = [];
  const cues: CaptionCue[] = [];
  const clips: ResolvedClip[] = [];
  for (const clip of scenario.clips) {
    const look = effectiveLook(scenario, clip);
    const mediaKind: ClipMediaKind = clip.mediaKind ?? 'source';
    if (mediaKind !== 'source') {
      const duration = clip.endSec - clip.startSec;
      const subcuts: TimeRange[] =
        duration >= settings.minSubcutSec && Boolean(clip.assetId)
          ? [{startSec: clip.startSec, endSec: clip.endSec}]
          : [];
      if (subcuts.length === 0) {
        clips.push({clip, look, words: [], subcuts, planIndex: null});
        continue;
      }
      const planIndex = planClips.length;
      planClips.push({
        subcuts,
        look: {...look, headline: {lines: shownHeadlineLines(look.headline.lines)}},
        mediaKind,
        assetId: clip.assetId ?? null,
        muteAudio: Boolean(clip.muteAudio),
      });
      clips.push({
        clip,
        look,
        words: [],
        subcuts,
        planIndex,
      });
      continue;
    }
    const words = wordsStartingIn(transcript.words, clip);
    const subcuts = clipSubcuts({range: clip, words, edits, pauses, settings});
    if (subcuts.length === 0) {
      clips.push({clip, look, words, subcuts, planIndex: null});
      continue;
    }
    const planIndex = planClips.length;
    planClips.push({
      subcuts,
      look: {...look, headline: {lines: shownHeadlineLines(look.headline.lines)}},
      mediaKind: 'source',
      assetId: null,
      muteAudio: false,
    });
    cues.push(
      ...captionCues({clip, words}, planIndex, transcript, edits, pauses, settings),
    );
    clips.push({clip, look, words, subcuts, planIndex});
  }
  const plan: RenderPlan | null =
    planClips.length > 0 ? {clips: planClips, cues, music: scenario.music} : null;
  const segments = outputSegments(planClips);
  return {
    clips,
    plan,
    segments,
    cues: plan ? outputCues(plan, segments, input.minCueSec) : [],
    durationSec: totalSec(segments),
  };
}

/** The Headline lines that are drawn: trimmed, empty ones dropped. */
export function shownHeadlineLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

/** The segment playing at `outputSec` and the matching source time. */
export function locateOutput(
  segments: readonly OutputSegment[],
  outputSec: number,
): {index: number; sourceSec: number} | null {
  if (segments.length === 0) {
    return null;
  }
  let index = 0;
  while (
    index + 1 < segments.length &&
    segments[index + 1].outputStartSec <= outputSec
  ) {
    index++;
  }
  const segment = segments[index];
  const offset = Math.max(0, outputSec - segment.outputStartSec);
  return {
    index,
    sourceSec: Math.min(segment.startSec + offset, segment.endSec),
  };
}
