/**
 * Click-to-focus from the preview to the right panel. A click on the stage
 * names what was hit (StageHit); the editor turns it into a FocusTarget,
 * shows the tab that edits it and the panel scrolls to and focuses the
 * matching control.
 */

/** What a click (not a drag) on the preview stage hit. */
export type StageHit =
  | {kind: 'headline'; line: number}
  | {kind: 'caption'}
  | {kind: 'image'; overlayId: string}
  | {kind: 'videoBox'};

/** The control the right panel should bring into view. */
export type FocusTarget =
  /** The input of one Headline line (index into Headline.lines). */
  | {kind: 'headline'; line: number}
  /** The caption text editor, opened on this Transcript Word if given. */
  | {kind: 'caption'; wordIndex: number | null}
  /** The caption font and color fields. */
  | {kind: 'captionStyle'}
  /** The fields of one Image Overlay. */
  | {kind: 'image'; overlayId: string}
  /** The video framing / box size controls. */
  | {kind: 'videoBox'};

/** A FocusTarget with a sequence number, so the same target can repeat. */
export interface FocusRequest {
  seq: number;
  target: FocusTarget;
}

/** The tab of the right panel that edits `target`. */
export function tabOf(target: FocusTarget): 'captions' | 'style' {
  return target.kind === 'caption' ? 'captions' : 'style';
}

/** Scrolls the page so `element` sits mid-screen. */
export function revealElement(element: Element | null | undefined): void {
  element?.scrollIntoView({behavior: 'smooth', block: 'center'});
}

/**
 * Reveals and focuses `input` without the focus jump that would cut the
 * smooth scroll short.
 */
export function revealInput(input: HTMLElement | null | undefined): void {
  if (input) {
    revealElement(input);
    input.focus({preventScroll: true});
  }
}

/** The Section named `anchor` (see ui.Section) under `root`. */
export function anchorElement(root: ParentNode, anchor: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);
}
