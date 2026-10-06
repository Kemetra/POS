/**
 * RT-17 slice 4 part 1 — the in-memory tally of refusals that answer a probe
 * of the blind count (10941 "Slice 4 must" item 3): it counts per shift, for
 * the current shift only, and starts again at zero for another shift.
 */
import { describe, expect, it } from 'vitest';

import { createShiftProbeTally } from '../shift-probe-tally.js';

const S1 = 'shift-1';
const S2 = 'shift-2';
const NONE = { payOut: 0, varianceClose: 0 };

describe('shift probe tally', () => {
  it('starts at zero for any shift, and for no shift', () => {
    const tally = createShiftProbeTally();
    expect(tally.countsFor(S1)).toEqual(NONE);
    expect(tally.countsFor(null)).toEqual(NONE);
  });

  it('counts each kind for its shift', () => {
    const tally = createShiftProbeTally();
    tally.record({ shiftId: S1, kind: 'payOut' });
    tally.record({ shiftId: S1, kind: 'payOut' });
    tally.record({ shiftId: S1, kind: 'varianceClose' });
    expect(tally.countsFor(S1)).toEqual({ payOut: 2, varianceClose: 1 });
    expect(tally.countsFor(S2)).toEqual(NONE);
    expect(tally.countsFor(null)).toEqual(NONE);
  });

  it('starts again at zero when another shift records', () => {
    const tally = createShiftProbeTally();
    tally.record({ shiftId: S1, kind: 'payOut' });
    tally.record({ shiftId: S2, kind: 'varianceClose' });
    expect(tally.countsFor(S2)).toEqual({ payOut: 0, varianceClose: 1 });
    expect(tally.countsFor(S1)).toEqual(NONE);
  });

  it('hands out a copy (the caller cannot change the counts)', () => {
    const tally = createShiftProbeTally();
    tally.record({ shiftId: S1, kind: 'payOut' });
    tally.countsFor(S1).payOut = 99;
    expect(tally.countsFor(S1).payOut).toBe(1);
  });
});
