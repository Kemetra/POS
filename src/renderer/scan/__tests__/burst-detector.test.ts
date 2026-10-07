import { describe, it, expect } from 'vitest';

import {
  BURST_GAP_MS,
  extendRun,
  finishRun,
  isScanChar,
  type KeyFacts,
  type RunState,
} from '../burst-detector.js';

const key = (k: string, over: Partial<KeyFacts> = {}): KeyFacts => ({
  key: k,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  ...over,
});

/** Feed characters at the given timestamps and return the final run. */
function typeRun(chars: string, times: number[]): RunState {
  let run: RunState = null;
  Array.from(chars).forEach((c, i) => {
    run = extendRun(run, c, times[i] ?? 0).run;
  });
  return run;
}

describe('isScanChar', () => {
  it('accepts a single printable character', () => {
    expect(isScanChar(key('7'))).toBe(true);
    expect(isScanChar(key('-'))).toBe(true);
  });

  it('rejects named keys, modified keys, repeats and composition', () => {
    expect(isScanChar(key('Enter'))).toBe(false);
    expect(isScanChar(key('Shift'))).toBe(false);
    expect(isScanChar(key('a', { ctrlKey: true }))).toBe(false);
    expect(isScanChar(key('a', { altKey: true }))).toBe(false);
    expect(isScanChar(key('a', { metaKey: true }))).toBe(false);
    expect(isScanChar(key('a', { repeat: true }))).toBe(false);
    expect(isScanChar(key('a', { isComposing: true }))).toBe(false);
  });
});

describe('extendRun / finishRun — timing, not length', () => {
  it('a 13-digit EAN at 5 ms gaps ending in Enter is a burst', () => {
    const ean = '6221000000011';
    const times = Array.from(ean).map((_, i) => 1000 + i * 5);
    expect(finishRun(typeRun(ean, times), 1000 + ean.length * 5)).toBe(ean);
  });

  it('a short code (AB-12) is a burst', () => {
    expect(finishRun(typeRun('AB-12', [0, 5, 10, 15, 20]), 25)).toBe('AB-12');
  });

  it('one character is a burst (no minimum length)', () => {
    expect(finishRun(typeRun('X', [100]), 105)).toBe('X');
  });

  it('human typing gaps are not a burst', () => {
    expect(finishRun(typeRun('1234', [0, 120, 240, 360]), 480)).toBeNull();
  });

  it('exactly 35 ms is still a burst; 36 ms is not', () => {
    expect(finishRun(typeRun('12', [0, BURST_GAP_MS]), 2 * BURST_GAP_MS)).toBe('12');
    // 36 ms between the two characters splits them: only '2' is the burst.
    expect(finishRun(typeRun('12', [0, BURST_GAP_MS + 1]), 2 * BURST_GAP_MS + 1)).toBe('2');
    expect(finishRun(typeRun('12', [0, 5]), 5 + BURST_GAP_MS + 1)).toBeNull();
  });

  it('a slow gap in the middle starts a new run instead of extending it', () => {
    const run = typeRun('1234', [0, 5, 200, 205]);
    expect(run?.chars).toBe('34');
    expect(finishRun(run, 210)).toBe('34');
  });

  it('reports `started` only for the first character of a run', () => {
    const first = extendRun(null, '1', 0);
    const second = extendRun(first.run, '2', 5);
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
  });

  it('Enter with no characters is not a burst', () => {
    expect(finishRun(null, 10)).toBeNull();
  });

  it('a long pause between the last character and Enter is not a burst', () => {
    expect(finishRun(typeRun('1234', [0, 5, 10, 15]), 15 + 500)).toBeNull();
  });
});
