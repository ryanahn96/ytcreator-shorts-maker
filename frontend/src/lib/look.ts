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

/** Whether two Text Layouts put the text at the same place. */
export function sameTextLayout(a: Look['textLayout'], b: Look['textLayout']): boolean {
  return (
    a.headline.x === b.headline.x &&
    a.headline.y === b.headline.y &&
    a.caption.x === b.caption.x &&
    a.caption.y === b.caption.y
  );
}

/**
 * One change to a Look, applied to the Look as it is when the change lands
 * rather than as it was when the change started (a stage drag can outlast
 * an Edit Request that edits the same Look).
 */
export type LookEdit = (look: Look) => Look;
