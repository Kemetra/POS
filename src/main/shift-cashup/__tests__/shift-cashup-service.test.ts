/**
 * RT-17 slice 3 part 3 — the main-process shift cash-up service (device path),
 * over the real repository and sources (migration stack on sql.js).
 *
 *   • `POS_PULSE_FEATURE_SHIFT_CASHUP` off (default) → every call is refused
 *     `feature_disabled` before anything is read or written.
 *   • Each fact is attributed to the signed-in, unlocked cashier's `users.id`
 *     (the device path's `operatorUserId`); a session without one (manager /
 *     admin) is refused — the envelope path is a later part of RT-17.
 *   • The cash-up is computed by the POS (10919): this terminal's sales
 *     finalized and refunds paid out inside [openedAt, closedAt], both ends
 *     included.
 *   • Carried item (a): a pay-out above the expected drawer cash is refused, so
 *     a mistyped pay-out cannot leave the shift un-closable.
 *   • A non-zero variance needs an approver (10920: manager PIN for any
 *     variance); the approver id is supplied by the main-side caller.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type { ShiftCashupService } from '../shift-cashup-service.js';
import {
  CLOSED_AT,
  MANAGER,
  OPENED_AT,
  cashLine,
  factCounts,
  msAfter,
  msBefore,
  seedRefund,
  seedShiftSale,
  serviceHarness,
  storedBody,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import { OTHER_TERMINAL, USER } from './__helpers__/shift-sync-fixture.js';

const REF = '0192f5a2-3b4c-7d8e-9f01-0000000000c1';
const FLOAT = 50_000;
const NO_FACTS = {
  shift_cashup_opens: 0,
  shift_cashup_movements: 0,
  shift_cashup_closes: 0,
  shift_sync_outbox: 0,
};

let db: SqlJsDatabase;
let harness: ServiceHarness;
let service: ShiftCashupService;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db);
  service = harness.service;
});

afterEach(() => {
  db.close();
});

function refusal(reason: string): Error {
  return expect.objectContaining({ name: 'ShiftCashupRefusedError', reason }) as Error;
}

function stateError(reason: string): Error {
  return expect.objectContaining({ name: 'ShiftCashupStateError', reason }) as Error;
}

/** Open at `OPENED_AT` and move the clock to `CLOSED_AT`. */
function openShift(): string {
  const { shiftId } = service.openShift({ openingFloatMinor: FLOAT });
  harness.state.clock = CLOSED_AT;
  return shiftId;
}

function openAgain(): unknown {
  return service.openShift({ openingFloatMinor: FLOAT });
}

function payOut(amountMinor: number): void {
  service.recordCashMovement({ kind: 'pay_out', amountMinor, reasonCode: 'bank_drop' });
}

type Call = (svc: ShiftCashupService) => unknown;
const CALLS: ReadonlyArray<[string, Call]> = [
  ['openShift', (svc) => svc.openShift({ openingFloatMinor: FLOAT })],
  [
    'recordCashMovement',
    (svc) => svc.recordCashMovement({ kind: 'pay_in', amountMinor: 100, reasonCode: 'other' }),
  ],
  ['closeShift', (svc) => svc.closeShift({ countedCashMinor: FLOAT })],
];

describe('feature flag OFF (default) — nothing is reachable', () => {
  it.each(CALLS)('%s is refused feature_disabled and writes nothing', (_name, call) => {
    harness.state.enabled = false;
    expect(() => call(service)).toThrow(refusal('feature_disabled'));
    expect(factCounts(db)).toEqual(NO_FACTS);
  });

  it.each(CALLS.slice(1))('%s on an already open shift is refused too', (_name, call) => {
    openShift();
    harness.state.enabled = false;
    const before = factCounts(db);
    expect(() => call(service)).toThrow(refusal('feature_disabled'));
    expect(factCounts(db)).toEqual(before);
  });

  it('readStatus is refused feature_disabled', async () => {
    harness.state.enabled = false;
    await expect(service.readStatus()).rejects.toThrow(refusal('feature_disabled'));
  });

  it('checks the flag before the session', () => {
    harness.state.enabled = false;
    harness.state.session = null;
    expect(openAgain).toThrow(refusal('feature_disabled'));
  });
});

describe('admission (device path: an unlocked cashier with a users.id)', () => {
  it.each<[string, (state: ServiceHarness['state']) => void, string]>([
    ['no session (or unpaired)', (s) => (s.session = null), 'no_session'],
    ['a locked session', (s) => (s.locked = true), 'session_locked'],
    [
      'a session without a users.id (manager / admin)',
      (s) => {
        s.session = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'term-1' };
      },
      'no_cashier_identity',
    ],
  ])('refuses %s and writes nothing', (_name, arrange, reason) => {
    arrange(harness.state);
    for (const [, call] of CALLS) expect(() => call(service)).toThrow(refusal(reason));
    expect(factCounts(db)).toEqual(NO_FACTS);
  });
});

describe('openShift', () => {
  it('records the open on the session terminal, attributed to the cashier', () => {
    const opened = service.openShift({ openingFloatMinor: FLOAT });
    expect(opened).toEqual({ shiftId: expect.any(String) as string, openedAt: OPENED_AT });
    expect(storedBody(db, 1)).toEqual({
      shiftId: opened.shiftId,
      openedAt: OPENED_AT,
      openingUserId: USER,
      currencyCode: 'EGP',
      openingFloat: '500.00',
      operatorUserId: USER,
    });
  });

  it('refuses a second open shift on the terminal', () => {
    openShift();
    expect(openAgain).toThrow(stateError('shift_already_open'));
  });
});

describe('recordCashMovement', () => {
  it('refuses a movement with no open shift', () => {
    expect(() => {
      payOut(1);
    }).toThrow(stateError('shift_not_open'));
  });

  it('records a pay-in on the open shift, attributed to the cashier', () => {
    const shiftId = openShift();
    const moved = service.recordCashMovement({
      kind: 'pay_in',
      amountMinor: 2_500,
      reasonCode: 'float_top_up',
      note: 'coins',
    });
    expect(moved.shiftId).toBe(shiftId);
    expect(storedBody(db, 2)).toEqual({
      movementId: moved.movementId,
      kind: 'pay_in',
      amount: '25.00',
      reasonCode: 'float_top_up',
      note: 'coins',
      occurredAt: CLOSED_AT,
      operatorUserId: USER,
    });
  });
});

describe('pay-out guard (carried item a)', () => {
  /** Float 500 + sale 50 − refund 10 = 540.00 in the drawer at `CLOSED_AT`. */
  beforeEach(() => {
    openShift();
    seedShiftSale(db, { saleId: 's-1', finalizedAt: OPENED_AT, lines: [cashLine(5_000)] });
    seedRefund(db, { returnId: 'r-1', returnRef: REF, amountMinor: 1_000, paidAt: OPENED_AT });
  });

  it('allows a pay-out of exactly the expected drawer cash, then refuses one more minor unit', () => {
    payOut(54_000);
    const before = factCounts(db);
    expect(() => {
      payOut(1);
    }).toThrow(refusal('pay_out_exceeds_drawer_cash'));
    expect(factCounts(db)).toEqual(before);
  });

  it('refuses a pay-out above the expected drawer cash, writing nothing', () => {
    expect(() => {
      payOut(54_001);
    }).toThrow(refusal('pay_out_exceeds_drawer_cash'));
    expect(factCounts(db)['shift_cashup_movements']).toBe(0);
  });

  it('counts pay-ins and earlier pay-outs', () => {
    service.recordCashMovement({ kind: 'pay_in', amountMinor: 1_000, reasonCode: 'other' });
    payOut(30_000);
    payOut(25_000);
    expect(() => {
      payOut(1);
    }).toThrow(refusal('pay_out_exceeds_drawer_cash'));
  });

  it('never guards a pay-in', () => {
    payOut(54_000);
    service.recordCashMovement({ kind: 'pay_in', amountMinor: 9_999_999, reasonCode: 'other' });
    expect(factCounts(db)['shift_cashup_movements']).toBe(2);
  });

  it('counts only what is in the drawer now (a sale finalized later is not)', () => {
    seedShiftSale(db, { saleId: 's-late', finalizedAt: msAfter(CLOSED_AT), lines: [cashLine(9)] });
    expect(() => {
      payOut(54_001);
    }).toThrow(refusal('pay_out_exceeds_drawer_cash'));
  });
});

describe('closeShift — the cash-up', () => {
  it('computes the cash-up from this terminal’s window and records it', () => {
    const shiftId = openShift();
    service.recordCashMovement({ kind: 'pay_in', amountMinor: 1_000, reasonCode: 'other' });
    payOut(2_000);
    seedShiftSale(db, { saleId: 's-1', finalizedAt: OPENED_AT, lines: [cashLine(6_000, 1_000)] });
    seedShiftSale(db, { saleId: 's-2', finalizedAt: CLOSED_AT, lines: [] });
    seedRefund(db, { returnId: 'r-1', returnRef: REF, amountMinor: 700, paidAt: CLOSED_AT });

    // 500 + 50 − 7 + 10 − 20 = 533.00
    const closed = service.closeShift({ countedCashMinor: 53_300 });
    expect(closed).toEqual({
      shiftId,
      closedAt: CLOSED_AT,
      cashSalesTotalMinor: 5_000,
      cashRefundsTotalMinor: 700,
      expectedCashMinor: 53_300,
      countedCashMinor: 53_300,
      varianceMinor: 0,
      saleCount: 2,
    });
    expect(storedBody(db, 4)).toMatchObject({
      closedAt: CLOSED_AT,
      closingUserId: USER,
      closeKind: 'normal',
      openingFloat: '500.00',
      cashSalesTotal: '50.00',
      cashRefundsTotal: '7.00',
      payInTotal: '10.00',
      payOutTotal: '20.00',
      expectedCash: '533.00',
      countedCash: '533.00',
      variance: '0.00',
      saleCount: 2,
      cashRefundReturnRefs: [REF],
      operatorUserId: USER,
    });
  });

  it('refuses a close with no open shift', () => {
    expect(() => service.closeShift({ countedCashMinor: 0 })).toThrow(stateError('shift_not_open'));
  });

  it.each<[string, string, boolean]>([
    ['at the open instant', OPENED_AT, true],
    ['1 ms before the open', msBefore(OPENED_AT), false],
    ['at the close instant', CLOSED_AT, true],
    ['1 ms after the close', msAfter(CLOSED_AT), false],
  ])('counts a sale finalized %s: %s → %s', (_name, finalizedAt, counted) => {
    openShift();
    seedShiftSale(db, { saleId: 's-edge', finalizedAt, lines: [cashLine(1_000)] });
    const closed = service.closeShift({ countedCashMinor: FLOAT + (counted ? 1_000 : 0) });
    expect([closed.cashSalesTotalMinor, closed.saleCount]).toEqual(counted ? [1_000, 1] : [0, 0]);
  });

  it.each<[string, string | null, boolean]>([
    ['at the open instant', OPENED_AT, true],
    ['1 ms before the open', msBefore(OPENED_AT), false],
    ['at the close instant', CLOSED_AT, true],
    ['1 ms after the close', msAfter(CLOSED_AT), false],
    ['not completed (payout started only)', null, false],
  ])('counts a refund paid out %s', (_name, paidAt, counted) => {
    openShift();
    seedRefund(db, { returnId: 'r-edge', returnRef: REF, amountMinor: 1_000, paidAt });
    const closed = service.closeShift({ countedCashMinor: FLOAT - (counted ? 1_000 : 0) });
    expect(closed.cashRefundsTotalMinor).toBe(counted ? 1_000 : 0);
    expect(storedBody(db, 2)['cashRefundReturnRefs']).toEqual(counted ? [REF] : []);
  });

  it('ignores another terminal’s sales and refunds', () => {
    openShift();
    const scope = OTHER_TERMINAL;
    seedShiftSale(db, { saleId: 's-x', finalizedAt: OPENED_AT, lines: [cashLine(1)], scope });
    seedRefund(db, { returnId: 'r-x', returnRef: REF, amountMinor: 1, paidAt: OPENED_AT, scope });
    const closed = service.closeShift({ countedCashMinor: FLOAT });
    expect(closed).toMatchObject({
      cashSalesTotalMinor: 0,
      cashRefundsTotalMinor: 0,
      saleCount: 0,
    });
  });

  it('refuses a non-zero variance without an approver, writing nothing', () => {
    openShift();
    const before = factCounts(db);
    expect(() => service.closeShift({ countedCashMinor: FLOAT - 1 })).toThrow(
      refusal('variance_approval_required'),
    );
    expect(factCounts(db)).toEqual(before);
  });

  it('records a non-zero variance with its approver', () => {
    openShift();
    const closed = service.closeShift({
      countedCashMinor: FLOAT + 250,
      varianceApprovedByUserId: MANAGER,
    });
    expect(closed.varianceMinor).toBe(250);
    expect(storedBody(db, 2)).toMatchObject({
      variance: '2.50',
      varianceApprovedByUserId: MANAGER,
    });
  });

  it('lets a new shift open once the previous one is closed', () => {
    openShift();
    service.closeShift({ countedCashMinor: FLOAT });
    expect(() => service.openShift({ openingFloatMinor: 0 })).not.toThrow();
  });
});
