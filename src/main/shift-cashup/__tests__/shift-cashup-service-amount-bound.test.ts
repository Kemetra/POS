/**
 * RT-278 S1 (plan `docs/design/vnext/29-rt278-shift-amount-bounds.md` §3.3,
 * owner decisions OD-278-1…4 and 7 in RT-278 comment 12764) — main refuses an
 * implausible shift amount (`amount_out_of_range`) before anything is read or
 * written:
 *
 *   • opening float and each pay-in above EGP 100,000.00;
 *   • counted cash above EGP 1,000,000.00, checked at the top of the close's
 *     pre-check, so a scanned count is never tallied as a probe and never
 *     reaches the manager PIN verification;
 *   • no new pay-out cap (the drawer bound stays);
 *   • shifts recorded before rollout keep working: the caps bound new inputs
 *     only, never an aggregate.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { maxShiftAmountMinor } from '../shift-amount-bound.js';
import {
  CLOSED_AT,
  MANAGER_PIN,
  MANAGER_REF,
  factCounts,
  seedPreRolloutShift,
  serviceHarness,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';

const FLOAT_CAP = 10_000_000; // EGP 100,000.00
const COUNT_CAP = 100_000_000; // EGP 1,000,000.00
/** F-02: the 13-digit barcode 6221000000011 read as major units. */
const F02_MINOR = 622_100_000_001_100;

let db: SqlJsDatabase;
let harness: ServiceHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

afterEach(() => {
  db.close();
});

/** Production default: no variance needs a manager (unless a test says otherwise). */
function start(options: { varianceApprovalThresholdMinor?: number | null } = {}): void {
  db = freshSalesSyncDb();
  harness = serviceHarness(db, { varianceApprovalThresholdMinor: null, ...options });
}

function refusal(reason: string): Error {
  return expect.objectContaining({ name: 'ShiftCashupRefusedError', reason }) as Error;
}

function openWith(openingFloatMinor: number): () => unknown {
  return () => harness.service.openShift({ openingFloatMinor });
}

function openShift(openingFloatMinor = 50_000): void {
  harness.service.openShift({ openingFloatMinor });
  harness.state.clock = CLOSED_AT;
}

function move(kind: 'pay_in' | 'pay_out', amountMinor: number): () => unknown {
  return () => harness.service.recordCashMovement({ kind, amountMinor, reasonCode: 'bank_drop' });
}

function closeWith(countedCashMinor: number): () => unknown {
  return () => harness.service.closeShift({ countedCashMinor });
}

async function openShiftView() {
  return (await harness.service.readStatus()).openShift;
}

describe('opening float: at most EGP 100,000.00', () => {
  beforeEach(() => {
    start();
  });

  it('opens with a float at the cap', async () => {
    expect(openWith(FLOAT_CAP)).not.toThrow();
    expect((await openShiftView())?.openingFloatMinor).toBe(FLOAT_CAP);
  });

  it.each([FLOAT_CAP + 1, F02_MINOR])(
    'refuses %i as amount_out_of_range, writing nothing',
    async (amount) => {
      const before = factCounts(db);
      expect(openWith(amount)).toThrow(refusal('amount_out_of_range'));
      expect(factCounts(db)).toEqual(before);
      expect(await openShiftView()).toBeNull();
    },
  );
});

describe('pay-in: at most EGP 100,000.00 per movement', () => {
  beforeEach(() => {
    start();
    openShift();
  });

  it('records a pay-in at the cap', async () => {
    expect(move('pay_in', FLOAT_CAP)).not.toThrow();
    expect((await openShiftView())?.payInTotalMinor).toBe(FLOAT_CAP);
  });

  it.each([FLOAT_CAP + 1, F02_MINOR])(
    'refuses %i as amount_out_of_range: no movement, the pay-in total unchanged',
    async (amount) => {
      const before = factCounts(db);
      expect(move('pay_in', amount)).toThrow(refusal('amount_out_of_range'));
      expect(factCounts(db)).toEqual(before);
      expect((await openShiftView())?.payInTotalMinor).toBe(0);
    },
  );

  it('refuses before the aggregate check (amount_out_of_range, not aggregate_out_of_range)', () => {
    db.close();
    start();
    seedPreRolloutShift(db, { openingFloatMinor: maxShiftAmountMinor('EGP') });
    harness.state.clock = CLOSED_AT;
    expect(move('pay_in', FLOAT_CAP + 1)).toThrow(refusal('amount_out_of_range'));
    expect(move('pay_in', 1)).toThrow(refusal('aggregate_out_of_range'));
  });
});

describe('pay-out: no new cap (OD-278-4)', () => {
  beforeEach(() => {
    start();
  });

  it('accepts a pay-out above the pay-in cap while the drawer holds it', () => {
    seedPreRolloutShift(db, { openingFloatMinor: FLOAT_CAP, payInsMinor: [FLOAT_CAP] });
    harness.state.clock = CLOSED_AT;
    expect(move('pay_out', FLOAT_CAP + 1)).not.toThrow();
  });

  it('still answers a pay-out above the drawer with pay_out_exceeds_drawer_cash', () => {
    openShift(50_000);
    expect(move('pay_out', 50_001)).toThrow(refusal('pay_out_exceeds_drawer_cash'));
  });
});

describe('counted cash: at most EGP 1,000,000.00', () => {
  it('closes a count at the cap', () => {
    start();
    seedPreRolloutShift(db, { openingFloatMinor: FLOAT_CAP, payInsMinor: [FLOAT_CAP] });
    harness.state.clock = CLOSED_AT;
    const before = factCounts(db);
    expect(closeWith(COUNT_CAP)).not.toThrow();
    expect(factCounts(db)).not.toEqual(before);
  });

  it.each([COUNT_CAP + 1, F02_MINOR])(
    'refuses %i as amount_out_of_range: no close, the shift still open',
    async (amount) => {
      start();
      openShift();
      const before = factCounts(db);
      expect(closeWith(amount)).toThrow(refusal('amount_out_of_range'));
      expect(factCounts(db)).toEqual(before);
      expect(await openShiftView()).not.toBeNull();
    },
  );

  it('with a variance threshold set, refuses a scanned count before variance_approval_required, and tallies no probe', async () => {
    start({ varianceApprovalThresholdMinor: 0 });
    openShift();
    expect(closeWith(F02_MINOR)).toThrow(refusal('amount_out_of_range'));
    expect((await harness.service.readStatus()).probeRefusals.varianceClose).toBe(0);
    // The same mechanism still tallies a plausible count that needs approval.
    expect(closeWith(50_001)).toThrow(refusal('variance_approval_required'));
    expect((await harness.service.readStatus()).probeRefusals.varianceClose).toBe(1);
  });

  it('verifyApprover refuses a scanned count without spending a manager PIN attempt', async () => {
    start({ varianceApprovalThresholdMinor: 0 });
    openShift();
    await expect(
      harness.service.verifyApprover({
        countedCashMinor: F02_MINOR,
        managerRef: MANAGER_REF,
        managerPin: MANAGER_PIN,
      }),
    ).rejects.toThrow(refusal('amount_out_of_range'));
    expect(harness.state.verifyCalls).toEqual([]);
    expect((await harness.service.readStatus()).probeRefusals).toEqual({
      payOut: 0,
      varianceClose: 0,
      approverFailure: 0,
    });
  });
});

describe('a shift recorded before rollout keeps working', () => {
  it('with a float and a pay-in above the cap, still takes a pay-out and closes under the count cap', async () => {
    start();
    seedPreRolloutShift(db, {
      openingFloatMinor: FLOAT_CAP * 3,
      payInsMinor: [FLOAT_CAP * 2],
    });
    harness.state.clock = CLOSED_AT;
    expect(move('pay_out', FLOAT_CAP * 4)).not.toThrow();
    expect((await openShiftView())?.payOutTotalMinor).toBe(FLOAT_CAP * 4);
    expect(closeWith(FLOAT_CAP)).not.toThrow();
    expect(await openShiftView()).toBeNull();
  });
});
