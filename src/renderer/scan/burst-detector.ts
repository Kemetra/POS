/**
 * RT-239 (VNext A2) — wedge-burst detection, pure.
 *
 * A keyboard-wedge scanner types its code, then Enter, far faster than a
 * person. Per the freeze package (15 §3.1 rule 2) a burst is decided by TIMING,
 * never by length: characters whose inter-key gaps are all ≤ 35 ms, ending in an
 * Enter whose own gap is also ≤ 35 ms. One character qualifies, because catalogue
 * aliases have no minimum length.
 *
 * This module has no DOM and no clock: every function takes the event
 * timestamps as input, so tests drive it with exact numbers.
 */

/** Maximum gap between two keys of one burst, including the last key to Enter. */
export const BURST_GAP_MS = 35;

/** The characters typed so far in one candidate burst, and when the last one arrived. */
export interface BurstRun {
  readonly chars: string;
  readonly lastAt: number;
}

export type RunState = BurstRun | null;

/** The slice of a keyboard event that decides whether a key is part of a code. */
export interface KeyFacts {
  readonly key: string;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
}

/**
 * A key the scanner types as part of a code. Shift is excluded by the caller
 * (the Honeywell sends it for upper case and `AB-12` must stay one run);
 * auto-repeat is excluded because a held key repeats about every 33 ms, which
 * would otherwise look like a burst.
 */
export function isScanChar(facts: KeyFacts): boolean {
  if (facts.repeat || facts.isComposing) return false;
  if (MODIFIERS.some((modifier) => facts[modifier])) return false;
  return facts.key.length === 1;
}

/** A chord (Ctrl+A, Alt+x, Cmd+c) is a shortcut, never part of a scanned code. */
const MODIFIERS = ['ctrlKey', 'altKey', 'metaKey'] as const;

export interface ExtendResult {
  readonly run: BurstRun;
  /** True when this character did not continue the previous run. */
  readonly started: boolean;
}

/** Add a character at `at`: continue the run if the gap allows, otherwise start a new one. */
export function extendRun(run: RunState, key: string, at: number): ExtendResult {
  if (run !== null && at - run.lastAt <= BURST_GAP_MS) {
    return { run: { chars: run.chars + key, lastAt: at }, started: false };
  }
  return { run: { chars: key, lastAt: at }, started: true };
}

/** At Enter: the scanned code if the run is a burst, otherwise null. */
export function finishRun(run: RunState, enterAt: number): string | null {
  if (run === null || run.chars.length === 0) return null;
  return enterAt - run.lastAt <= BURST_GAP_MS ? run.chars : null;
}
