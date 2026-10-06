/**
 * RT-17 slice 4 part 2 — the verified variance approver (option A, Jira RT-17
 * comment 10943) and the carried F1 bound (comment 10944), over the real
 * repository and sources (migration stack on sql.js) and a fake manager PIN
 * store (the real store is covered in `manager-pin-store.test.ts`).
 *
 * Review round 1:
 *   • P2-4, no oracle: `verifyApprover` first runs the close's whole
 *     synchronous pre-check (admission, the open shift at now, the clock, the
 *     drawer settled, the cash-up) and computes the variance. It checks a PIN
 *     only when the close would otherwise be refused
 *     `variance_approval_required`; a zero variance needs no approver (null).
 *     Every failed approver attempt is counted per shift (`approverFailure`).
 *   • Keyed (Codex P1): the PIN is checked for ONE manager, named by an opaque
 *     `managerRef` the store lists (`listApprovers`).
 *   • P2-3, bound: the approval is bound to the shift, the counted cash and
 *     the variance it was given for, besides the session and pairing epoch;
 *     `closeShift` refuses any mismatch (`approval_stale`).
 *   • The approver is never the closing cashier (`approver_is_closer`), and a
 *     manager whose record expired is refused (`approver_expired`).
 *   • F1: a pay-in is refused when the shift's pay-in total or its expected
 *     cash would leave the safe-integer range.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type { VerifiedApprover } from '../shift-cashup-service.js';
import {
  CLOSED_AT,
  MANAGER,
  MANAGER_PIN,
  MANAGER_REF,
  OPENED_AT,
  cardLine,
  cashLine,
  cashierSession,
  factCounts,
  managerSession,
  seedRefund,
  seedSettlement,
  seedShiftSale,
  serviceHarness,
  storedBody,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import { SCOPE, USER } from './__helpers__/shift-sync-fixture.js';

const FLOAT = 50_000;
const MAX = Number.MAX_SAFE_INTEGER;
const F3_REF = '0192f5a2-3b4c-7d8e-9f01-f3f3f3f3f3f3';

let db: SqlJsDatabase;
let harness: ServiceHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db);
});

afterEach(() => {
  db.close();
});

function refusal(reason: string): Error {
  return expect.objectContaining({ name: 'ShiftCashupRefusedError', reason }) as Error;
}

function openShift(openingFloatMinor = FLOAT): string {
  const { shiftId } = harness.service.openShift({ openingFloatMinor });
  harness.state.clock = CLOSED_AT;
  return shiftId;
}

function approve(countedCashMinor = FLOAT + 1): Promise<VerifiedApprover | null> {
  return harness.service.verifyApprover({
    countedCashMinor,
    managerRef: MANAGER_REF,
    managerPin: MANAGER_PIN,
  });
}

async function approval(countedCashMinor = FLOAT + 1): Promise<VerifiedApprover> {
  const approver = await approve(countedCashMinor);
  if (approver === null) throw new Error('fixture: an approval was expected');
  return approver;
}

function closeWith(countedCashMinor: number, approver?: VerifiedApprover): () => unknown {
  return () =>
    harness.service.closeShift({
      countedCashMinor,
      ...(approver === undefined ? {} : { approver }),
    });
}

async function approverFailures(): Promise<number> {
  return (await harness.service.readStatus()).probeRefusals.approverFailure;
}

describe('verifyApprover — keyed, and only when the close needs it', () => {
  it('verifies the named manager in the session’s scope at the close’s instant', async () => {
    openShift();
    const approver = await approval(FLOAT - 75);
    expect(harness.state.verifyCalls).toEqual([
      { scope: SCOPE, managerRef: MANAGER_REF, pin: MANAGER_PIN, now: CLOSED_AT },
    ]);
    const closed = harness.service.closeShift({ countedCashMinor: FLOAT - 75, approver });
    expect(closed.varianceMinor).toBe(-75);
    expect(storedBody(db, 2)).toMatchObject({ varianceApprovedByUserId: MANAGER });
  });

  it('checks no PIN and needs no approver for a zero variance', async () => {
    openShift();
    await expect(approve(FLOAT)).resolves.toBeNull();
    expect(harness.state.verifyCalls).toEqual([]);
  });

  it.each<[string, () => void, string]>([
    ['no open shift', () => undefined, 'shift_not_open'],
    [
      'a clock behind the open',
      () => {
        openShift();
        harness.state.clock = '2026-10-05T07:00:00.000Z';
      },
      'clock_regressed',
    ],
    [
      'drawer activity in flight',
      () => {
        openShift();
        seedSettlement(db, { saleId: 's-1' });
      },
      'drawer_activity_pending',
    ],
    [
      'an unreadable sale tender',
      () => {
        openShift();
        seedShiftSale(db, { saleId: 's-1', finalizedAt: OPENED_AT, lines: [{ tender_type: 'x' }] });
      },
      'unreadable_sale_tenders',
    ],
  ])('runs the close’s pre-check first: %s refuses before any PIN', async (_n, arrange, reason) => {
    arrange();
    await expect(approve()).rejects.toThrow(expect.objectContaining({ reason }) as Error);
    expect(harness.state.verifyCalls).toEqual([]);
  });

  it.each<[string, ServiceHarness['state']['verdict'], string]>([
    ['a wrong PIN or unknown manager', { kind: 'invalid' }, 'approver_invalid'],
    ['a record under lockout', { kind: 'locked' }, 'approver_locked'],
    ['an expired record (no online sign-in for 30 days)', { kind: 'expired' }, 'approver_expired'],
    ['the closing cashier', { kind: 'verified', userId: USER }, 'approver_is_closer'],
  ])('refuses %s and counts it for the shift', async (_name, verdict, reason) => {
    openShift();
    harness.state.verdict = verdict;
    await expect(approve()).rejects.toThrow(refusal(reason));
    await expect(approve()).rejects.toThrow(refusal(reason));
    await expect(approverFailures()).resolves.toBe(2);
  });

  it('compares the closer case-insensitively', async () => {
    harness.state.session = { ...cashierSession(), user_id: USER.toUpperCase() };
    openShift();
    harness.state.verdict = { kind: 'verified', userId: USER };
    await expect(approve()).rejects.toThrow(refusal('approver_is_closer'));
  });

  it('counts no failure for a verified manager', async () => {
    openShift();
    await approval();
    await expect(approverFailures()).resolves.toBe(0);
  });

  it.each<[string, (s: ServiceHarness['state']) => void, string]>([
    ['the flag off', (s) => (s.enabled = false), 'feature_disabled'],
    ['no session', (s) => (s.session = null), 'no_session'],
    ['a locked session', (s) => (s.locked = true), 'session_locked'],
    ['a session without a users.id', (s) => (s.session = managerSession()), 'no_cashier_identity'],
    ['an unpaired or revoked terminal (no epoch)', (s) => (s.epoch = null), 'no_session'],
  ])('refuses %s before any PIN is checked', async (_name, arrange, reason) => {
    openShift();
    arrange(harness.state);
    await expect(approve()).rejects.toThrow(refusal(reason));
    expect(harness.state.verifyCalls).toEqual([]);
  });

  type Race = (s: ServiceHarness['state']) => void;
  it.each<[string, Race, string]>([
    ['a sign-out', (s) => (s.session = null), 'no_session'],
    ['a lock', (s) => (s.locked = true), 'session_locked'],
    ['the flag turned off', (s) => (s.enabled = false), 'feature_disabled'],
    [
      'a new session of the same cashier',
      (s) => (s.session = { ...cashierSession(), operator_session_id: 'sess-cashier-2' }),
      'no_session',
    ],
    ['a revocation', (s) => (s.epoch = null), 'no_session'],
    ['a re-pair of the same terminal (new epoch)', (s) => (s.epoch = 'epoch-2'), 'no_session'],
  ])('refuses when %s lands during the verification', async (_name, race, reason) => {
    openShift();
    harness.state.duringVerify = () => {
      race(harness.state);
    };
    await expect(approve()).rejects.toThrow(refusal(reason));
  });

  it('checks the session again even when the verification failed', async () => {
    openShift();
    harness.state.verdict = { kind: 'invalid' };
    harness.state.duringVerify = () => {
      harness.state.session = null;
    };
    await expect(approve()).rejects.toThrow(refusal('no_session'));
  });
});

describe('closeShift accepts only its own approval, once, for the same close', () => {
  it('uses an approval once', async () => {
    openShift();
    const approver = await approval();
    expect(closeWith(FLOAT + 1, approver)).not.toThrow();
    harness.state.clock = '2026-10-05T16:00:00.001Z';
    harness.service.openShift({ openingFloatMinor: FLOAT });
    harness.state.clock = '2026-10-05T17:00:00.000Z';
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('approver_invalid'));
  });

  it('spends the approval even when the close is refused', async () => {
    openShift();
    const approver = await approval();
    expect(closeWith(FLOAT + 2, approver)).toThrow(refusal('approval_stale'));
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('approver_invalid'));
  });

  it('refuses an approval it did not issue (a look-alike object)', () => {
    const shiftId = openShift();
    const forged = {
      userId: MANAGER,
      operatorSessionId: cashierSession().operator_session_id,
      pairingEpoch: 'epoch-1',
      shiftId,
      countedCashMinor: FLOAT + 1,
      varianceMinor: 1,
    } as unknown as VerifiedApprover;
    expect(closeWith(FLOAT + 1, forged)).toThrow(refusal('approver_invalid'));
    expect(factCounts(db).shift_cashup_closes).toBe(0);
  });

  it('refuses an approval issued to another session', async () => {
    openShift();
    const approver = await approval();
    harness.state.session = { ...cashierSession(), operator_session_id: 'sess-cashier-2' };
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('no_session'));
  });

  it.each<[string, string | null]>([
    ['a re-pair', 'epoch-2'],
    ['a revocation', null],
  ])('refuses an approval issued before %s', async (_name, epoch) => {
    openShift();
    const approver = await approval();
    harness.state.epoch = epoch;
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('no_session'));
  });

  it('refuses an approval given for another count (P2-3)', async () => {
    openShift();
    const approver = await approval(FLOAT + 1);
    expect(closeWith(FLOAT + 500, approver)).toThrow(refusal('approval_stale'));
    expect(factCounts(db).shift_cashup_closes).toBe(0);
  });

  it('refuses an approval for another count even when the variance is the same (P2-3)', async () => {
    openShift();
    const approver = await approval(FLOAT + 100);
    seedShiftSale(db, { saleId: 's-1', finalizedAt: CLOSED_AT, lines: [cashLine(40)] });
    expect(closeWith(FLOAT + 140, approver)).toThrow(refusal('approval_stale'));
    expect(factCounts(db).shift_cashup_closes).toBe(0);
  });

  it('refuses an approval when the variance moved since (a sale landed)', async () => {
    openShift();
    const approver = await approval(FLOAT + 100);
    seedShiftSale(db, { saleId: 's-1', finalizedAt: CLOSED_AT, lines: [cashLine(40)] });
    expect(closeWith(FLOAT + 100, approver)).toThrow(refusal('approval_stale'));
  });

  it('refuses an approval when the variance is now zero', async () => {
    openShift();
    const approver = await approval(FLOAT + 40);
    seedShiftSale(db, { saleId: 's-1', finalizedAt: CLOSED_AT, lines: [cashLine(40)] });
    expect(closeWith(FLOAT + 40, approver)).toThrow(refusal('approval_stale'));
  });

  it('refuses an approval given for another shift', async () => {
    openShift();
    const approver = await approval(FLOAT + 1);
    harness.service.closeShift({ countedCashMinor: FLOAT });
    harness.state.clock = '2026-10-05T16:00:00.001Z';
    harness.service.openShift({ openingFloatMinor: FLOAT });
    harness.state.clock = '2026-10-05T17:00:00.000Z';
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('approval_stale'));
  });

  it('still refuses a non-zero variance without an approval', () => {
    openShift();
    expect(closeWith(FLOAT + 1)).toThrow(refusal('variance_approval_required'));
  });
});

describe('F3 — the approval is bound to the cash-up it was given for (10948)', () => {
  type Activity = () => void;
  const equalSaleAndRefund: Activity = () => {
    seedShiftSale(db, { saleId: 's-f3', finalizedAt: CLOSED_AT, lines: [cashLine(40)] });
    seedRefund(db, { returnId: 'r-f3', returnRef: F3_REF, amountMinor: 40, paidAt: CLOSED_AT });
  };
  const equalPayInAndPayOut: Activity = () => {
    for (const kind of ['pay_in', 'pay_out'] as const) {
      harness.service.recordCashMovement({ kind, amountMinor: 25, reasonCode: 'other' });
    }
  };
  const cardOnlySale: Activity = () => {
    seedShiftSale(db, { saleId: 's-card', finalizedAt: CLOSED_AT, lines: [cardLine(900)] });
  };

  it.each<[string, Activity]>([
    ['an equal-value cash sale and refund', equalSaleAndRefund],
    ['an equal pay-in and pay-out', equalPayInAndPayOut],
    ['a card-only sale (no drawer cash)', cardOnlySale],
  ])('refuses as stale when %s lands during the PIN check', async (_name, activity) => {
    openShift();
    harness.state.duringVerify = activity;
    const approver = await approval(FLOAT + 1);
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('approval_stale'));
    expect(factCounts(db).shift_cashup_closes).toBe(0);
  });

  it('refuses as stale when the activity lands between the approval and the close', async () => {
    openShift();
    const approver = await approval(FLOAT + 1);
    equalSaleAndRefund();
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('approval_stale'));
  });

  it('still closes with the approval when nothing moved in the drawer', async () => {
    openShift();
    equalSaleAndRefund();
    const approver = await approval(FLOAT + 1);
    const closed = harness.service.closeShift({ countedCashMinor: FLOAT + 1, approver });
    expect(closed).toMatchObject({ varianceMinor: 1, saleCount: 1, cashRefundsTotalMinor: 40 });
  });
});

describe('listApprovers — the managers a close can name', () => {
  it('lists the session scope’s approvers from the store, at now', () => {
    expect(harness.service.listApprovers()).toEqual([
      { managerRef: MANAGER_REF, displayName: 'Mona Manager' },
    ]);
    expect(harness.state.listCalls).toEqual([{ scope: SCOPE, now: harness.state.clock }]);
  });

  it('serves a manager session too', () => {
    harness.state.session = managerSession();
    expect(harness.service.listApprovers()).toHaveLength(1);
  });

  it.each<[string, (s: ServiceHarness['state']) => void, string]>([
    ['the flag off', (s) => (s.enabled = false), 'feature_disabled'],
    ['no session', (s) => (s.session = null), 'no_session'],
    ['a locked session', (s) => (s.locked = true), 'session_locked'],
    ['an unpaired or revoked terminal (no epoch)', (s) => (s.epoch = null), 'no_session'],
  ])('refuses %s, listing nothing', (_name, arrange, reason) => {
    arrange(harness.state);
    expect(() => harness.service.listApprovers()).toThrow(refusal(reason));
    expect(harness.state.listCalls).toEqual([]);
  });
});

describe('F1 — a pay-in never takes the shift out of the safe range (10944)', () => {
  function payIn(amountMinor: number): () => unknown {
    return () =>
      harness.service.recordCashMovement({ kind: 'pay_in', amountMinor, reasonCode: 'other' });
  }

  it('accepts a pay-in that takes the expected cash exactly to the bound, and the shift closes', () => {
    openShift(MAX - 10);
    expect(payIn(10)).not.toThrow();
    expect(closeWith(MAX)).not.toThrow();
  });

  it('refuses a pay-in that takes the expected cash past the bound, writing nothing', () => {
    openShift(MAX - 10);
    const before = factCounts(db);
    expect(payIn(11)).toThrow(refusal('aggregate_out_of_range'));
    expect(factCounts(db)).toEqual(before);
    expect(closeWith(MAX - 10)).not.toThrow();
  });

  it('counts the cash sales of the window in the expected cash', () => {
    openShift(MAX - 1_000);
    seedShiftSale(db, { saleId: 's-1', finalizedAt: CLOSED_AT, lines: [cashLine(990)] });
    expect(payIn(11)).toThrow(refusal('aggregate_out_of_range'));
    expect(payIn(10)).not.toThrow();
  });

  it('refuses a pay-in whose total would pass the bound although pay-outs keep the cash in range', () => {
    openShift(0);
    expect(payIn(MAX)).not.toThrow();
    harness.service.recordCashMovement({ kind: 'pay_out', amountMinor: MAX, reasonCode: 'other' });
    expect(payIn(1)).toThrow(refusal('aggregate_out_of_range'));
  });
});
