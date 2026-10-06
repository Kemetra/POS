/**
 * RT-17 follow-up (comment 10948, "JPY bound") — the service keeps every shift
 * aggregate inside the currency's maximum (`maxShiftAmountMinor`), so the shift
 * stays closable and every amount the close sends fits Backend-Core's
 * `NUMERIC(19,4)` (15 integer digits).
 *
 * JPY has no minor-unit digits, so the safe-integer range (16 digits) is one
 * digit too wide for it: a pay-in that was valid on its own could take the
 * expected cash past 10^15 − 1 yen, and the close would then be refused by the
 * wire builder (`invalid_amount`), leaving the shift open for good.
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
  cashLine,
  factCounts,
  seedShiftSale,
  serviceHarness,
  storedBody,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';

const JPY_MAX = 999_999_999_999_999;
const CURRENCIES = ['EGP', 'USD', 'JPY', 'KWD', 'BHD'] as const;

let db: SqlJsDatabase;
let harness: ServiceHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

afterEach(() => {
  db.close();
});

function start(currencyCode: string): void {
  db = freshSalesSyncDb();
  harness = serviceHarness(db, { currencyCode });
}

function refusal(reason: string): Error {
  return expect.objectContaining({ name: 'ShiftCashupRefusedError', reason }) as Error;
}

function openShift(openingFloatMinor: number): void {
  harness.service.openShift({ openingFloatMinor });
  harness.state.clock = CLOSED_AT;
}

function payIn(amountMinor: number): () => unknown {
  return () =>
    harness.service.recordCashMovement({ kind: 'pay_in', amountMinor, reasonCode: 'other' });
}

function closeWith(countedCashMinor: number): () => unknown {
  return () => harness.service.closeShift({ countedCashMinor });
}

describe('JPY: the pay-in guard holds the aggregates to 15 digits', () => {
  beforeEach(() => {
    start('JPY');
  });

  it('accepts a pay-in that takes the expected cash exactly to 999 999 999 999 999, and the shift closes', () => {
    openShift(JPY_MAX - 10);
    expect(payIn(10)).not.toThrow();
    expect(closeWith(JPY_MAX)).not.toThrow();
  });

  it('refuses a pay-in that takes the expected cash one yen past it, writing nothing', () => {
    openShift(JPY_MAX - 10);
    const before = factCounts(db);
    expect(payIn(11)).toThrow(refusal('aggregate_out_of_range'));
    expect(factCounts(db)).toEqual(before);
    expect(closeWith(JPY_MAX - 10)).not.toThrow();
  });

  it('refuses any pay-in on a drawer already at the maximum', () => {
    openShift(JPY_MAX);
    expect(payIn(1)).toThrow(refusal('aggregate_out_of_range'));
  });

  it('counts the cash sales of the window in the expected cash', () => {
    openShift(JPY_MAX - 1_000);
    seedShiftSale(db, { saleId: 's-1', finalizedAt: CLOSED_AT, lines: [cashLine(990)] });
    expect(payIn(11)).toThrow(refusal('aggregate_out_of_range'));
    expect(payIn(10)).not.toThrow();
  });

  it('refuses a pay-in whose total would pass the maximum although pay-outs keep the cash in range', () => {
    openShift(0);
    expect(payIn(JPY_MAX)).not.toThrow();
    harness.service.recordCashMovement({
      kind: 'pay_out',
      amountMinor: JPY_MAX,
      reasonCode: 'other',
    });
    expect(payIn(1)).toThrow(refusal('aggregate_out_of_range'));
  });
});

describe('every known currency: the largest accepted shift closes with 15-digit amounts', () => {
  it.each(CURRENCIES)('%s: open at the maximum, close at the maximum', (code) => {
    start(code);
    const max = maxShiftAmountMinor(code);
    openShift(max);
    expect(payIn(1)).toThrow(refusal('aggregate_out_of_range'));
    expect(closeWith(max)).not.toThrow();
    const body = storedBody(db, 2);
    for (const field of ['openingFloat', 'expectedCash', 'countedCash', 'variance']) {
      expect(body[field]).toMatch(/^-?[0-9]{1,15}(\.[0-9]{1,4})?$/);
    }
  });
});
