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
 *
 * RT-278 S1: a new float, pay-in or count is now also held to a plausibility
 * cap (`src/shared/shift-cashup/amount-bound.ts`), EGP only; any other currency
 * fails closed (cap 0), before the aggregate guard. A shift near the maximum
 * can therefore only be one recorded before rollout, seeded here through the
 * repository: its close must still fit the wire in every currency.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { maxShiftAmountMinor } from '../shift-amount-bound.js';
import {
  CLOSED_AT,
  factCounts,
  seedPreRolloutShift,
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
  // No variance needs a manager (the production default).
  harness = serviceHarness(db, { currencyCode, varianceApprovalThresholdMinor: null });
}

function refusal(reason: string): Error {
  return expect.objectContaining({ name: 'ShiftCashupRefusedError', reason }) as Error;
}

function preRollout(currencyCode: string, openingFloatMinor: number): void {
  seedPreRolloutShift(db, { openingFloatMinor, currencyCode });
  harness.state.clock = CLOSED_AT;
}

function payIn(amountMinor: number): () => unknown {
  return () =>
    harness.service.recordCashMovement({ kind: 'pay_in', amountMinor, reasonCode: 'other' });
}

function closeWith(countedCashMinor: number): () => unknown {
  return () => harness.service.closeShift({ countedCashMinor });
}

describe('JPY: the plausibility cap fails closed, before the aggregate guard', () => {
  it('opens only with a zero float', () => {
    start('JPY');
    expect(() => harness.service.openShift({ openingFloatMinor: 1 })).toThrow(
      refusal('amount_out_of_range'),
    );
    expect(() => harness.service.openShift({ openingFloatMinor: 0 })).not.toThrow();
  });

  it('refuses any pay-in, even on a drawer at the maximum, writing nothing', () => {
    start('JPY');
    preRollout('JPY', JPY_MAX);
    const before = factCounts(db);
    expect(payIn(1)).toThrow(refusal('amount_out_of_range'));
    expect(factCounts(db)).toEqual(before);
  });

  it('closes a pre-rollout shift at the maximum with a zero count, every amount in 15 digits', () => {
    start('JPY');
    preRollout('JPY', JPY_MAX);
    expect(closeWith(1)).toThrow(refusal('amount_out_of_range'));
    expect(closeWith(0)).not.toThrow();
    expect(storedBody(db, 2)).toMatchObject({
      expectedCash: '999999999999999',
      variance: '-999999999999999',
    });
  });
});

describe('every known currency: a pre-rollout shift at the maximum still closes with 15-digit amounts', () => {
  it.each(CURRENCIES)('%s: seeded open at the maximum, refused pay-in, close', (code) => {
    start(code);
    const max = maxShiftAmountMinor(code);
    preRollout(code, max);
    const reason = code === 'EGP' ? 'aggregate_out_of_range' : 'amount_out_of_range';
    expect(payIn(1)).toThrow(refusal(reason));
    expect(closeWith(0)).not.toThrow();
    const body = storedBody(db, 2);
    for (const field of ['openingFloat', 'expectedCash', 'countedCash', 'variance']) {
      expect(body[field]).toMatch(/^-?[0-9]{1,15}(\.[0-9]{1,4})?$/);
    }
  });
});
