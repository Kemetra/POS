/**
 * RT-15 S4 — the payout panel's state, as pure transitions (R1, R3, R6).
 *
 * The phase is derived only from what main answered: `paid` only on a
 * `paid_out` answer or a paid-out journal row; a started-but-unpaid payout is
 * `interrupted` (never a fresh start); a rejected call is `unknown`.
 */
import { describe, expect, it } from 'vitest';

import type {
  ReturnDrawerFailure,
  ReturnJournalView,
  ReturnsPayoutResponse,
} from '../../../shared/returns/types.js';
import {
  afterPayout,
  afterReprint,
  askManual,
  cancelManual,
  initialPayout,
  refreshed,
  synced,
  type PayoutState,
} from '../payout-state.js';
import { CALL_FAILED } from '../returns-bridge.js';
import { journal } from './returns-test-kit.js';

/** A payout started whose kick provably never left (no drawer): may be retried. */
const STARTED = {
  startedAt: '2026-10-04T09:06:00.000Z',
  paidAt: null,
  method: null,
  kick: 'failed_before_send' as const,
  kickCount: 1,
  kickPending: false,
};
const PAID = {
  startedAt: '2026-10-04T09:06:00.000Z',
  paidAt: '2026-10-04T09:06:05.000Z',
  method: 'drawer' as const,
  kick: 'opened' as const,
  kickCount: 1,
  kickPending: false,
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

describe('P1: the drawer may be retried only after a kick that provably never left', () => {
  it.each<[string, 'none' | 'failed_before_send' | 'opened' | 'unknown', boolean]>([
    ['never kicked', 'none', true],
    ['no drawer configured', 'failed_before_send', true],
    ['opened', 'opened', false],
    ['unknown (timeout, fault, crash mid-kick)', 'unknown', false],
  ])('an interrupted payout whose kick is %s (%s): retryable %s', (_l, kick, retryable) => {
    expect(initialPayout(journal({ payout: { ...STARTED, kick } })).phase).toEqual({
      kind: 'interrupted',
      retryable,
    });
  });

  it.each<[ReturnDrawerFailure, boolean]>([
    ['no_drawer_configured', true],
    ['printer_dk_failure', false],
    ['os_error', false],
    ['timeout', false],
  ])('a live drawer failure %s: retryable %s', (reason, retryable) => {
    const res: ReturnsPayoutResponse = { kind: 'drawer_failed', ret: INTERRUPTED, reason };
    expect(afterPayout(state(), res).phase).toEqual({ kind: 'drawer_failed', reason, retryable });
  });

  it('drawer_retry_unsafe shows the payout as interrupted, manual only', () => {
    const ret = journal({ payout: { ...STARTED, kick: 'opened' } });
    const res: ReturnsPayoutResponse = { kind: 'refused', reason: 'drawer_retry_unsafe', ret };
    expect(afterPayout(state(), res).phase).toEqual({ kind: 'interrupted', retryable: false });
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
    expect(afterPayout(state(), res).phase).toEqual({
      kind: 'drawer_failed',
      reason: 'timeout',
      retryable: false,
    });
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
    const res: ReturnsPayoutResponse = { kind: 'refused', reason: 'not_payable', ret: null };
    expect(afterPayout(state(), res)).toEqual({
      ret: READY,
      phase: { kind: 'refused', reason: 'not_payable' },
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
              phase: { kind: 'drawer_failed', reason: 'os_error', retryable: false },
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

describe('afterReprint (Codex P2: never call a refusal or an unknown a printer failure)', () => {
  it.each<[Parameters<typeof afterReprint>[1], PayoutState['reprint']]>([
    [{ kind: 'printed' }, { kind: 'printed' }],
    [{ kind: 'print_failed' }, { kind: 'print_failed' }],
    [
      { kind: 'refused', reason: 'not_paid_out' },
      { kind: 'refused', reason: 'not_paid_out' },
    ],
    // A copy may have printed before the session changed: not a printer failure.
    [
      { kind: 'refused', reason: 'session_changed' },
      { kind: 'refused', reason: 'session_changed' },
    ],
    [CALL_FAILED, { kind: 'unknown' }],
  ])('%o → %o', (res, expected) => {
    expect(afterReprint(state(PAID_OUT), res).reprint).toEqual(expected);
  });
});

/** A kick (the n-th) whose outcome is not recorded yet (`sending`), or is. */
function kicked(kickCount: number, kickPending: boolean): ReturnJournalView {
  return journal({ payout: { ...STARTED, kick: 'unknown', kickCount, kickPending } });
}

describe('synced: only a strictly newer view is adopted, never a downgrade', () => {
  it.each<[string, ReturnJournalView, ReturnJournalView, boolean]>([
    ['ready → started (adopted)', READY, INTERRUPTED, true],
    ['started → paid (adopted)', INTERRUPTED, PAID_OUT, true],
    // Reviewer P2 (49e0277): a stale or original view never rolls a panel back.
    ['started → ready (kept)', INTERRUPTED, READY, false],
    ['paid → ready (kept)', PAID_OUT, READY, false],
    ['paid → started (kept)', PAID_OUT, INTERRUPTED, false],
    // Codex P2 (49e0277): a kick's outcome recorded after `sending` is newer.
    ['a kick sending → its outcome recorded (adopted)', kicked(1, true), kicked(1, false), true],
    ['a recorded outcome → sending (older) (kept)', kicked(1, false), kicked(1, true), false],
    ['no drawer → a retry kick sending (adopted)', INTERRUPTED, kicked(2, true), true],
    ['a retry kick sending → the first kick (older) (kept)', kicked(2, true), INTERRUPTED, false],
    ['the same view (kept)', INTERRUPTED, journal({ payout: { ...STARTED } }), false],
  ])('%s', (_l, from, to, adopted) => {
    const live: PayoutState = { ...state(from), phase: { kind: 'unknown' } };
    expect(synced(live, to)).toEqual(adopted ? initialPayout(to) : live);
  });
});

describe('transient refusals wait for a refresh (Codex P2 on 49e0277)', () => {
  it.each([
    'drawer_kick_in_progress',
    'another_payout_in_progress',
    'session_changed',
    'no_session',
    'offline',
  ] as const)('%s is a wait with a refresh, keeping the row', (reason) => {
    expect(afterPayout(state(INTERRUPTED), { kind: 'refused', reason, ret: null })).toEqual({
      ret: INTERRUPTED,
      phase: { kind: 'wait', reason },
      reprint: null,
    });
  });

  it.each(['not_payable', 'role_denied', 'feature_disabled', 'shutting_down'] as const)(
    '%s stays a final refusal',
    (reason) => {
      const res: ReturnsPayoutResponse = { kind: 'refused', reason, ret: null };
      expect(afterPayout(state(INTERRUPTED), res).phase).toEqual({ kind: 'refused', reason });
    },
  );

  it('a refresh after the lease re-derives the actions: unknown kick → manual only', () => {
    const waiting: PayoutState = {
      ret: kicked(2, true),
      phase: { kind: 'wait', reason: 'drawer_kick_in_progress' },
      reprint: null,
    };
    expect(refreshed(waiting, kicked(2, false)).phase).toEqual({
      kind: 'interrupted',
      retryable: false,
    });
  });

  it('a refresh never rolls back to an older row', () => {
    const paid: PayoutState = { ...state(PAID_OUT), phase: { kind: 'unknown' } };
    expect(refreshed(paid, READY).phase.kind).toBe('paid');
  });
});
