/**
 * Which Look applies where. Every Clip shows the Scenario's Look unless it
 * carries its own (see CONTEXT.md: Look).
 */

import type {Clip, Look, Scenario} from '../types';

/** The Look a Clip shows. */
export function effectiveLook(scenario: Scenario, clip: Clip | undefined): Look {
  return clip?.look ?? scenario.look;
}

/**
 * Where an edit of the Look shown for a Clip goes: the Clip's id when it has
 * its own Look, null (the shared Look) otherwise.
 */
export function lookTarget(scenario: Scenario, clipIndex: number): string | null {
  const clip = scenario.clips[clipIndex];
  return clip?.look ? clip.clipId : null;
}

/** Numbers (1-based) of the Clips that have their own Look. */
export function ownLookClipNumbers(scenario: Scenario): number[] {
  return scenario.clips.flatMap((clip, index) => (clip.look ? [index + 1] : []));
}

/** Whether two Text Layouts put the text at the same place. */
export function sameTextLayout(a: Look['textLayout'], b: Look['textLayout']): boolean {
  return (
    a.headline.x === b.headline.x &&
    a.headline.y === b.headline.y &&
    a.caption.x === b.caption.x &&
    a.caption.y === b.caption.y
  );
}
