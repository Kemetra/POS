/**
 * RT-17 slice 4 part 2 — the verified variance approver (option A, Jira RT-17
 * comment 10943) and the carried F1 bound (comment 10944), over the real
 * repository and sources (migration stack on sql.js) and a fake manager PIN
 * verifier (the real store is covered in `manager-pin-store.test.ts`).
 *
 *   • `verifyApprover` admits the closing cashier exactly like a fact (flag,
 *     session, lock, cashier identity), then verifies the manager PIN in the
 *     session's scope (tenant, branch, paired terminal). The verification is
 *     awaited, so the admission is checked again after it — the same session
 *     and the same RT-215 pairing epoch. A wrong PIN is `approver_invalid`, a
 *     PIN store under lockout `approver_locked`.
 *   • What it returns is an opaque, single-use approval bound to that session
 *     and pairing: `closeShift` accepts only an approval it issued, not yet
 *     used, for the same session and epoch, whose manager is not the closing
 *     cashier (`approver_is_closer`). The verified manager's users.id becomes
 *     `varianceApprovedByUserId` (only for a non-zero variance).
 *   • F1: a pay-in is refused when the shift's pay-in total or its expected
 *     cash would leave the safe-integer range, so a pay-in can never make the
 *     shift impossible to close.
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
  cashLine,
  cashierSession,
  factCounts,
  managerSession,
  seedShiftSale,
  serviceHarness,
  storedBody,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import { SCOPE, USER } from './__helpers__/shift-sync-fixture.js';

const FLOAT = 50_000;
const MAX = Number.MAX_SAFE_INTEGER;

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

function approve(): Promise<VerifiedApprover> {
  return harness.service.verifyApprover({ managerPin: MANAGER_PIN });
}

function closeWith(countedCashMinor: number, approver?: VerifiedApprover): () => unknown {
  return () =>
    harness.service.closeShift({
      countedCashMinor,
      ...(approver === undefined ? {} : { approver }),
    });
}

describe('verifyApprover — the manager PIN, verified in the session’s scope', () => {
  it('verifies the PIN against the session’s scope and closes with that manager', async () => {
    openShift();
    const approver = await approve();
    expect(harness.state.verifyCalls).toEqual([{ scope: SCOPE, pin: MANAGER_PIN }]);
    const closed = harness.service.closeShift({ countedCashMinor: FLOAT - 75, approver });
    expect(closed.varianceMinor).toBe(-75);
    expect(storedBody(db, 2)).toMatchObject({ varianceApprovedByUserId: MANAGER });
  });

  it.each<[string, ServiceHarness['state']['verdict'], string]>([
    ['a wrong PIN', { kind: 'invalid' }, 'approver_invalid'],
    ['a PIN store under lockout', { kind: 'locked' }, 'approver_locked'],
  ])('refuses %s', async (_name, verdict, reason) => {
    harness.state.verdict = verdict;
    await expect(approve()).rejects.toThrow(refusal(reason));
  });

  it.each<[string, (s: ServiceHarness['state']) => void, string]>([
    ['the flag off', (s) => (s.enabled = false), 'feature_disabled'],
    ['no session', (s) => (s.session = null), 'no_session'],
    ['a locked session', (s) => (s.locked = true), 'session_locked'],
    ['a session without a users.id', (s) => (s.session = managerSession()), 'no_cashier_identity'],
    ['an unpaired or revoked terminal (no epoch)', (s) => (s.epoch = null), 'no_session'],
  ])('refuses %s before any PIN is checked', async (_name, arrange, reason) => {
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
    harness.state.duringVerify = () => {
      race(harness.state);
    };
    await expect(approve()).rejects.toThrow(refusal(reason));
  });

  it('checks the session again even when the verification failed', async () => {
    harness.state.verdict = { kind: 'invalid' };
    harness.state.duringVerify = () => {
      harness.state.session = null;
    };
    await expect(approve()).rejects.toThrow(refusal('no_session'));
  });
});

describe('closeShift accepts only an approval it issued, once, in the same session and pairing', () => {
  it('refuses the approval when its manager is the closing cashier', async () => {
    openShift();
    harness.state.verdict = { kind: 'verified', userId: USER };
    const approver = await approve();
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('approver_is_closer'));
    expect(factCounts(db).shift_cashup_closes).toBe(0);
  });

  it('compares the two users.id case-insensitively', async () => {
    harness.state.session = { ...cashierSession(), user_id: USER.toUpperCase() };
    openShift();
    harness.state.verdict = { kind: 'verified', userId: USER };
    const approver = await approve();
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('approver_is_closer'));
  });

  it('refuses the closing cashier as approver even for a zero variance', async () => {
    openShift();
    harness.state.verdict = { kind: 'verified', userId: USER };
    const approver = await approve();
    expect(closeWith(FLOAT, approver)).toThrow(refusal('approver_is_closer'));
  });

  it('uses an approval once', async () => {
    openShift();
    const approver = await approve();
    expect(closeWith(FLOAT, approver)).not.toThrow();
    harness.state.clock = '2026-10-05T16:00:00.001Z';
    harness.service.openShift({ openingFloatMinor: 0 });
    harness.state.clock = '2026-10-05T17:00:00.000Z';
    expect(closeWith(1, approver)).toThrow(refusal('approver_invalid'));
  });

  it('spends the approval even when the close is refused for something else', async () => {
    const approver = await approve();
    expect(closeWith(FLOAT + 1, approver)).toThrow(
      expect.objectContaining({ reason: 'shift_not_open' }) as Error,
    );
    openShift();
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('approver_invalid'));
  });

  it('refuses an approval it did not issue (a look-alike object)', () => {
    openShift();
    const forged = {
      userId: MANAGER,
      operatorSessionId: cashierSession().operator_session_id,
      pairingEpoch: 'epoch-1',
    } as unknown as VerifiedApprover;
    expect(closeWith(FLOAT + 1, forged)).toThrow(refusal('approver_invalid'));
  });

  it('refuses an approval issued to another session', async () => {
    openShift();
    const approver = await approve();
    harness.state.session = { ...cashierSession(), operator_session_id: 'sess-cashier-2' };
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('no_session'));
  });

  it.each<[string, string | null]>([
    ['a re-pair', 'epoch-2'],
    ['a revocation', null],
  ])('refuses an approval issued before %s', async (_name, epoch) => {
    openShift();
    const approver = await approve();
    harness.state.epoch = epoch;
    expect(closeWith(FLOAT + 1, approver)).toThrow(refusal('no_session'));
  });

  it('still refuses a non-zero variance without an approval', () => {
    openShift();
    expect(closeWith(FLOAT + 1)).toThrow(refusal('variance_approval_required'));
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
