/**
 * RT-15 S4 — the payout panel's state, as pure transitions (R1, R3, R6).
 *
 * The phase is derived only from what main answered: `paid` only on a
 * `paid_out` answer or a paid-out journal row; a started-but-unpaid payout is
 * `interrupted` (never a fresh start); a rejected call is `unknown`.
 */
import { describe, expect, it } from 'vitest';

import type { ReturnJournalView, ReturnsPayoutResponse } from '../../../shared/returns/types.js';
import {
  afterPayout,
  afterReprint,
  askManual,
  cancelManual,
  initialPayout,
  refreshed,
  type PayoutState,
} from '../payout-state.js';
import { CALL_FAILED } from '../returns-bridge.js';
import { journal } from './returns-test-kit.js';

const STARTED = { startedAt: '2026-10-04T09:06:00.000Z', paidAt: null, method: null };
const PAID = {
  startedAt: '2026-10-04T09:06:00.000Z',
  paidAt: '2026-10-04T09:06:05.000Z',
  method: 'drawer' as const,
};
const READY = journal();
const INTERRUPTED = journal({ payout: STARTED });
const PAID_OUT = journal({ state: 'paid_out', payout: PAID });

function state(ret: ReturnJournalView = READY): PayoutState {
  return initialPayout(ret);
}

describe('initialPayout', () => {
  it.each<[string, ReturnJournalView, string]>([
    ['a confirmed return with no payout', READY, 'ready'],
    ['a started, unpaid payout', INTERRUPTED, 'interrupted'],
    ['a paid-out return', PAID_OUT, 'paid'],
  ])('%s is %s', (_label, ret, kind) => {
    expect(initialPayout(ret).phase.kind).toBe(kind);
  });

  it('a paid-out return from the journal has no known slip result', () => {
    expect(initialPayout(PAID_OUT).phase).toEqual({ kind: 'paid', slip: null, method: 'drawer' });
  });
});

describe('afterPayout', () => {
  it('R1: paid_out is paid, with its slip result and the new row', () => {
    const res: ReturnsPayoutResponse = {
      kind: 'paid_out',
      ret: PAID_OUT,
      method: 'manual',
      slip: 'failed',
    };
    expect(afterPayout(state(), res)).toEqual({
      ret: PAID_OUT,
      phase: { kind: 'paid', slip: 'failed', method: 'manual' },
      reprint: null,
    });
  });

  it('R1: drawer_failed is never paid; it keeps the reason', () => {
    const res: ReturnsPayoutResponse = {
      kind: 'drawer_failed',
      ret: INTERRUPTED,
      reason: 'timeout',
    };
    expect(afterPayout(state(), res).phase).toEqual({ kind: 'drawer_failed', reason: 'timeout' });
  });

  it('R3: payout_started becomes the interrupted state, never a fresh start', () => {
    const res: ReturnsPayoutResponse = {
      kind: 'refused',
      reason: 'payout_started',
      ret: INTERRUPTED,
    };
    expect(afterPayout(state(), res)).toMatchObject({
      ret: INTERRUPTED,
      phase: { kind: 'interrupted' },
    });
  });

  it('already_paid_out shows the paid row and says so', () => {
    const res: ReturnsPayoutResponse = {
      kind: 'refused',
      reason: 'already_paid_out',
      ret: PAID_OUT,
    };
    expect(afterPayout(state(), res).phase).toEqual({
      kind: 'refused',
      reason: 'already_paid_out',
    });
    expect(afterPayout(state(), res).ret).toBe(PAID_OUT);
  });

  it('a refusal without a row keeps the current row', () => {
    const res: ReturnsPayoutResponse = { kind: 'refused', reason: 'session_changed', ret: null };
    expect(afterPayout(state(), res)).toEqual({
      ret: READY,
      phase: { kind: 'refused', reason: 'session_changed' },
      reprint: null,
    });
  });

  it('R1: a rejected call is unknown, never paid', () => {
    expect(afterPayout(state(), CALL_FAILED).phase).toEqual({ kind: 'unknown' });
  });
});

describe('manual confirmation (R2)', () => {
  it.each(['drawer_failed', 'interrupted'] as const)(
    'asking from %s, then cancelling, returns there',
    (kind) => {
      const from: PayoutState =
        kind === 'interrupted'
          ? state(INTERRUPTED)
          : {
              ret: INTERRUPTED,
              phase: { kind: 'drawer_failed', reason: 'os_error' },
              reprint: null,
            };
      const asked = askManual(from);
      expect(asked.phase).toEqual({ kind: 'confirm_manual', back: from.phase });
      expect(cancelManual(asked)).toEqual(from);
    },
  );

  it('cannot be asked from any other phase', () => {
    expect(askManual(state())).toEqual(state());
    expect(cancelManual(state())).toEqual(state());
  });
});

describe('refreshed (after an unknown result)', () => {
  it('re-derives the phase from the journal row', () => {
    const unknown: PayoutState = { ret: READY, phase: { kind: 'unknown' }, reprint: null };
    expect(refreshed(unknown, PAID_OUT).phase.kind).toBe('paid');
    expect(refreshed(unknown, INTERRUPTED).phase.kind).toBe('interrupted');
  });

  it('stays unknown when the row is not listed', () => {
    const unknown: PayoutState = { ret: READY, phase: { kind: 'unknown' }, reprint: null };
    expect(refreshed(unknown, undefined)).toEqual(unknown);
  });
});

describe('afterReprint', () => {
  it.each<[Parameters<typeof afterReprint>[1], PayoutState['reprint']]>([
    [{ kind: 'printed' }, 'printed'],
    [{ kind: 'print_failed' }, 'failed'],
    [{ kind: 'refused', reason: 'not_paid_out' }, 'failed'],
    [CALL_FAILED, 'failed'],
  ])('%o → %s', (res, expected) => {
    expect(afterReprint(state(PAID_OUT), res).reprint).toBe(expected);
  });
});
