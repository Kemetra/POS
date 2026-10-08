import { describe, expect, it } from 'vitest';

import { afterCheck, found, mayBeRecorded, setQuantity, withNotice } from '../return-flow-state.js';
import { journal, SALE, L1 } from './returns-test-kit.js';

/** RT-15 S3 — pure transitions whose guards no realistic bridge answer reaches. */
describe('mayBeRecorded (O5)', () => {
  it('is false once main names a journaled return, even for a session loss', () => {
    const ret = journal({ state: 'refused', refusalReason: 'session_changed' });
    expect(mayBeRecorded({ kind: 'refused', reason: 'session_changed', ret })).toBe(false);
    expect(mayBeRecorded({ kind: 'refused', reason: 'session_changed', ret: null })).toBe(true);
  });
});

describe('setQuantity (A4)', () => {
  it('clamps to whole 0..returnable and ignores unknown lines and other steps', () => {
    const select = found('T1-000042', SALE);
    const pick = (q: number) => setQuantity(select, L1, q);
    expect(pick(9)).toMatchObject({ picked: { [L1]: 2 } });
    expect(pick(-3)).toMatchObject({ picked: { [L1]: 0 } });
    expect(pick(1.7)).toMatchObject({ picked: { [L1]: 1 } });
    expect(setQuantity(select, 'not-a-line', 1)).toBe(select);
    const lookup = { step: 'lookup', notice: null } as const;
    expect(setQuantity(lookup, L1, 1)).toBe(lookup);
  });

  it('keeps an outcome free of step notices', () => {
    const outcome = { step: 'outcome', outcome: { kind: 'failed' } } as const;
    expect(withNotice(outcome, { kind: 'failed' })).toBe(outcome);
  });
});

describe('afterCheck (U3 defensive guard)', () => {
  it('applies a check answer only while an unconfirmed outcome is on screen', () => {
    const next = { kind: 'failed' } as const;
    const lost = { kind: 'unconfirmed', ret: journal(), still: false, notice: null } as const;
    expect(afterCheck({ step: 'outcome', outcome: lost }, next)).toEqual({
      step: 'outcome',
      outcome: next,
    });
    const lookup = { step: 'lookup', notice: null } as const;
    expect(afterCheck(lookup, next)).toBe(lookup);
    const confirmed = { step: 'outcome', outcome: { kind: 'failed' } } as const;
    expect(afterCheck(confirmed, next)).toBe(confirmed);
  });
});
