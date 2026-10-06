/**
 * RT-17 slice 3 part 3 — the pure cash-up calculator (10919 "Expected cash"):
 *
 *   expected = float + Σ net cash tenders of the window's sales
 *              − Σ completed drawer refund payouts + pay-ins − pay-outs
 *
 * Net cash is each applied cash line's amount less its change; card and
 * voucher lines are not drawer cash. A sale with no tender lines (RT-10 D8)
 * still counts as a sale. A source the calculator cannot read faithfully is
 * refused, never guessed.
 */
import { describe, expect, it } from 'vitest';

import {
  ShiftCashupSourceError,
  computeCashup,
  type CashupInput,
  type CashupRefund,
} from '../shift-cashup-calculator.js';
import { cardLine, cashLine } from './__helpers__/shift-cashup-service-fixture.js';

const REF_A = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const REF_B = '0192f5a2-3b4c-7d8e-9f01-0000000000b2';

function sale(lines: ReadonlyArray<Record<string, unknown>>): { tenderLinesSummaryJson: string } {
  return { tenderLinesSummaryJson: JSON.stringify(lines) };
}

function refund(overrides: Partial<CashupRefund> = {}): CashupRefund {
  return { returnRef: REF_A, amountMinor: 700, currencyCode: 'EGP', ...overrides };
}

function input(overrides: Partial<CashupInput> = {}): CashupInput {
  return {
    currencyCode: 'EGP',
    openingFloatMinor: 50_000,
    payInTotalMinor: 0,
    payOutTotalMinor: 0,
    sales: [],
    refunds: [],
    ...overrides,
  };
}

describe('computeCashup — arithmetic', () => {
  it('is the float alone for an empty shift', () => {
    expect(computeCashup(input())).toEqual({
      cashSalesTotalMinor: 0,
      cashRefundsTotalMinor: 0,
      expectedCashMinor: 50_000,
      saleCount: 0,
      cashRefundReturnRefs: [],
    });
  });

  it('adds net cash sales and pay-ins, subtracts refunds and pay-outs', () => {
    const result = computeCashup(
      input({
        payInTotalMinor: 1_000,
        payOutTotalMinor: 3_000,
        sales: [sale([cashLine(2_000, 500)]), sale([cashLine(4_000)])],
        refunds: [refund({ amountMinor: 700 }), refund({ returnRef: REF_B, amountMinor: 300 })],
      }),
    );
    // 50 000 + (1 500 + 4 000) − (700 + 300) + 1 000 − 3 000 = 52 500
    expect(result).toEqual({
      cashSalesTotalMinor: 5_500,
      cashRefundsTotalMinor: 1_000,
      expectedCashMinor: 52_500,
      saleCount: 2,
      cashRefundReturnRefs: [REF_A, REF_B],
    });
  });

  it.each([
    ['a card-only sale', [cardLine(9_000)], 0],
    ['a voucher line', [{ tender_type: 'internal_voucher', amount_applied_minor: 9_000 }], 0],
    ['a split sale (cash net of change + card)', [cashLine(3_000, 200), cardLine(4_000)], 2_800],
    ['two cash lines', [cashLine(1_000, 100), cashLine(500)], 1_400],
    ['a tender-unknown sale (RT-10 D8)', [], 0],
    ['a cash line with no change key', [{ tender_type: 'cash', amount_applied_minor: 750 }], 750],
  ])('counts only drawer cash for %s', (_name, lines, cash) => {
    const result = computeCashup(input({ sales: [sale(lines)] }));
    expect(result.cashSalesTotalMinor).toBe(cash);
    expect(result.saleCount).toBe(1);
    expect(result.expectedCashMinor).toBe(50_000 + cash);
  });

  it('can report a negative expected cash (the close builder refuses it)', () => {
    const result = computeCashup(input({ openingFloatMinor: 0, refunds: [refund()] }));
    expect(result.expectedCashMinor).toBe(-700);
  });

  it('computes in bigint, refusing a total that is not a safe integer', () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(() =>
      computeCashup(input({ openingFloatMinor: big, sales: [sale([cashLine(big)])] })),
    ).toThrow(expect.objectContaining({ reason: 'total_out_of_range' }) as Error);
  });

  it('keeps an exact result when a partial sum passes 2^53 but the total does not', () => {
    const big = Number.MAX_SAFE_INTEGER - 10;
    const result = computeCashup(
      input({ openingFloatMinor: big, payInTotalMinor: big, payOutTotalMinor: big }),
    );
    expect(result.expectedCashMinor).toBe(big);
  });
});

describe('computeCashup — unreadable sources are refused, never guessed', () => {
  it.each([
    ['unparseable JSON', 'not json'],
    ['a non-list summary', '{}'],
    ['a non-object line', '[1]'],
    ['a null line', '[null]'],
    ['a fractional cash amount', JSON.stringify([cashLine(10.5)])],
    ['a negative cash amount', JSON.stringify([cashLine(-1)])],
    ['a string cash amount', JSON.stringify([{ tender_type: 'cash', amount_applied_minor: '9' }])],
    ['change above the amount', JSON.stringify([cashLine(100, 101)])],
    ['a negative change', JSON.stringify([cashLine(100, -1)])],
    ['an unsafe cash amount', JSON.stringify([cashLine(2 ** 53)])],
  ])('refuses %s', (_name, json) => {
    expect(() => computeCashup(input({ sales: [{ tenderLinesSummaryJson: json }] }))).toThrow(
      expect.objectContaining({ reason: 'unreadable_sale_tenders' }) as Error,
    );
  });

  it.each([
    ['a negative amount', { amountMinor: -1 }],
    ['a fractional amount', { amountMinor: 1.5 }],
    ['an unsafe amount', { amountMinor: 2 ** 53 }],
  ])('refuses a refund with %s', (_name, overrides) => {
    expect(() => computeCashup(input({ refunds: [refund(overrides)] }))).toThrow(
      expect.objectContaining({ reason: 'invalid_refund' }) as Error,
    );
  });

  it('refuses a refund paid in another currency than the shift', () => {
    expect(() => computeCashup(input({ refunds: [refund({ currencyCode: 'USD' })] }))).toThrow(
      expect.objectContaining({ reason: 'refund_currency_mismatch' }) as Error,
    );
  });

  it('is a typed error naming the reason only', () => {
    const error = new ShiftCashupSourceError('invalid_refund');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ShiftCashupSourceError');
    expect(error.message).toBe('shift cash-up source refused: invalid_refund');
  });
});
