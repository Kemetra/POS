/**
 * RT-854 (RT-699 I1, doc 28 §3, §8 "Pure math") — the shared manual-discount
 * math: canonical token parse, half-up percent rounding on the line gross,
 * 0 ≤ net ≤ gross, overflow refused, the closed reason list, and the
 * envelope totals. Money module: ≥ 95% coverage (vitest.config.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  MANUAL_DISCOUNT_REASON_CODES,
  computeManualDiscount,
  envelopeDiscountTotals,
  formatManualDiscountToken,
  isManualDiscountReasonCode,
  lineDiscountMinor,
  parseManualDiscountToken,
} from '../../../../src/shared/cart/manual-discount.js';

describe('parseManualDiscountToken — canonical tokens only (doc 28 §3.1)', () => {
  it.each([
    ['manual_pct_1', { kind: 'percent', value: 1 }],
    ['manual_pct_10', { kind: 'percent', value: 10 }],
    ['manual_pct_100', { kind: 'percent', value: 100 }],
    ['manual_amt_1', { kind: 'amount', value: 1 }],
    ['manual_amt_900', { kind: 'amount', value: 900 }],
  ])('parses %s', (token, expected) => {
    expect(parseManualDiscountToken(token)).toEqual(expected);
  });

  it.each([
    'manual_pct_010',
    'manual_pct_0',
    'manual_pct_101',
    'manual_amt_-5',
    'manual_amt_1.5',
    'manual_pct_10x',
    'manual_amt_0',
    'manual_amt_01',
    'manual_pct_',
    'manual_amt_',
    'percent_10',
    'STAFF_10PCT',
    'MANUAL_PCT_10',
    ' manual_pct_10',
    'manual_pct_10 ',
    'manual_pct_+10',
    'manual_amt_1e3',
    '',
  ])('refuses %j', (token) => {
    expect(parseManualDiscountToken(token)).toBeNull();
  });

  it('refuses an amount beyond the safe-integer range', () => {
    expect(parseManualDiscountToken('manual_amt_9007199254740993')).toBeNull();
  });

  it('accepts the largest safe amount', () => {
    expect(parseManualDiscountToken(`manual_amt_${String(Number.MAX_SAFE_INTEGER)}`)).toEqual({
      kind: 'amount',
      value: Number.MAX_SAFE_INTEGER,
    });
  });

  it('round-trips through formatManualDiscountToken', () => {
    expect(formatManualDiscountToken({ kind: 'percent', value: 15 })).toBe('manual_pct_15');
    expect(formatManualDiscountToken({ kind: 'amount', value: 250 })).toBe('manual_amt_250');
    for (const token of ['manual_pct_1', 'manual_pct_100', 'manual_amt_7']) {
      const parsed = parseManualDiscountToken(token);
      expect(parsed).not.toBeNull();
      if (parsed !== null) expect(formatManualDiscountToken(parsed)).toBe(token);
    }
  });
});

describe('computeManualDiscount — integer minor units on the line gross (doc 28 §3.2)', () => {
  it('rounds a percent half up: gross 45, 10% → 5 (4.5 rounds up)', () => {
    expect(computeManualDiscount(45, { kind: 'percent', value: 10 })).toEqual({
      amount_minor: 5,
      net_minor: 40,
    });
  });

  it('rounds a percent half up: gross 44, 10% → 4', () => {
    expect(computeManualDiscount(44, { kind: 'percent', value: 10 })).toEqual({
      amount_minor: 4,
      net_minor: 40,
    });
  });

  it('gross 9000, 10% → 900', () => {
    expect(computeManualDiscount(9000, { kind: 'percent', value: 10 })).toEqual({
      amount_minor: 900,
      net_minor: 8100,
    });
  });

  it('allows a percent that rounds to 0: 1% of 1 → amount 0 (§11.1)', () => {
    expect(computeManualDiscount(1, { kind: 'percent', value: 1 })).toEqual({
      amount_minor: 0,
      net_minor: 1,
    });
  });

  it('100% → a free line, net 0', () => {
    expect(computeManualDiscount(4599, { kind: 'percent', value: 100 })).toEqual({
      amount_minor: 4599,
      net_minor: 0,
    });
  });

  it('amount = gross → net 0', () => {
    expect(computeManualDiscount(500, { kind: 'amount', value: 500 })).toEqual({
      amount_minor: 500,
      net_minor: 0,
    });
  });

  it('refuses an amount above the gross', () => {
    expect(computeManualDiscount(500, { kind: 'amount', value: 501 })).toBeNull();
  });

  it('a gross of 0 takes a percent (amount 0) but no amount discount', () => {
    expect(computeManualDiscount(0, { kind: 'percent', value: 50 })).toEqual({
      amount_minor: 0,
      net_minor: 0,
    });
    expect(computeManualDiscount(0, { kind: 'amount', value: 1 })).toBeNull();
  });

  it('refuses a percent whose intermediate product overflows', () => {
    expect(
      computeManualDiscount(Number.MAX_SAFE_INTEGER, { kind: 'percent', value: 2 }),
    ).toBeNull();
    // gross × P is safe but + 50 is not
    expect(
      computeManualDiscount(Number.MAX_SAFE_INTEGER - 10, { kind: 'percent', value: 1 }),
    ).toBeNull();
  });

  it('stays exact near the top of the safe range (no float rounding)', () => {
    const gross = Math.floor((Number.MAX_SAFE_INTEGER - 50) / 100);
    const result = computeManualDiscount(gross, { kind: 'percent', value: 99 });
    expect(result).not.toBeNull();
    if (result === null) return;
    const exact = (BigInt(gross) * 99n + 50n) / 100n;
    expect(BigInt(result.amount_minor)).toBe(exact);
    expect(result.net_minor + result.amount_minor).toBe(gross);
  });

  it.each([
    [-1, { kind: 'percent', value: 10 }],
    [1.5, { kind: 'percent', value: 10 }],
    [Number.NaN, { kind: 'amount', value: 1 }],
    [100, { kind: 'percent', value: 0 }],
    [100, { kind: 'percent', value: 101 }],
    [100, { kind: 'percent', value: 10.5 }],
    [100, { kind: 'amount', value: 0 }],
    [100, { kind: 'amount', value: -3 }],
  ] as const)('refuses gross %s with %j', (gross, discount) => {
    expect(computeManualDiscount(gross, discount)).toBeNull();
  });

  it('is deterministic: the same inputs give the same amount', () => {
    const a = computeManualDiscount(12345, { kind: 'percent', value: 37 });
    const b = computeManualDiscount(12345, { kind: 'percent', value: 37 });
    expect(a).toEqual(b);
  });

  it('keeps 0 ≤ net ≤ gross for every percent of a range of grosses', () => {
    for (let gross = 0; gross <= 250; gross += 1) {
      for (let p = 1; p <= 100; p += 1) {
        const result = computeManualDiscount(gross, { kind: 'percent', value: p });
        expect(result).not.toBeNull();
        if (result === null) continue;
        expect(result.net_minor).toBeGreaterThanOrEqual(0);
        expect(result.net_minor).toBeLessThanOrEqual(gross);
        expect(result.amount_minor + result.net_minor).toBe(gross);
      }
    }
  });
});

describe('lineDiscountMinor — token + line gross', () => {
  it('computes from a canonical token', () => {
    expect(lineDiscountMinor(9000, 'manual_pct_10')).toBe(900);
    expect(lineDiscountMinor(9000, 'manual_amt_250')).toBe(250);
  });

  it('is null for a non-canonical token or an amount above the gross', () => {
    expect(lineDiscountMinor(9000, 'percent_10')).toBeNull();
    expect(lineDiscountMinor(100, 'manual_amt_101')).toBeNull();
  });
});

describe('MANUAL_DISCOUNT_REASON_CODES — the closed list (doc 28 §11.2)', () => {
  it('holds exactly the four owner-approved codes', () => {
    expect([...MANUAL_DISCOUNT_REASON_CODES]).toEqual([
      'promotion',
      'loyal_or_contract_customer',
      'near_expiry_or_damaged',
      'price_correction',
    ]);
  });

  it.each([
    'promotion',
    'loyal_or_contract_customer',
    'near_expiry_or_damaged',
    'price_correction',
  ])('accepts %s', (code) => {
    expect(isManualDiscountReasonCode(code)).toBe(true);
  });

  it.each(['', 'customer_left', 'PROMOTION', 'promotion ', 'other', undefined, null, 1])(
    'refuses %j',
    (code) => {
      expect(isManualDiscountReasonCode(code)).toBe(false);
    },
  );
});

describe('envelopeDiscountTotals — Σ line discounts and the amount due (doc 28 §3.3)', () => {
  const lines = [
    { line_id: 'l1', line_subtotal_minor: 9000 },
    { line_id: 'l2', line_subtotal_minor: 4500 },
  ];

  it('no placeholders: discount 0, due = subtotal', () => {
    expect(envelopeDiscountTotals(lines, [])).toEqual({
      discount_total_minor: 0,
      total_due_minor: 13500,
    });
  });

  it('sums one discount per line', () => {
    expect(
      envelopeDiscountTotals(lines, [
        { line_id: 'l1', placeholder_kind: 'manual_pct_10' },
        { line_id: 'l2', placeholder_kind: 'manual_amt_500' },
      ]),
    ).toEqual({ discount_total_minor: 1400, total_due_minor: 12100 });
  });

  it('a fully discounted cart is due 0', () => {
    expect(
      envelopeDiscountTotals(lines, [
        { line_id: 'l1', placeholder_kind: 'manual_pct_100' },
        { line_id: 'l2', placeholder_kind: 'manual_amt_4500' },
      ]),
    ).toEqual({ discount_total_minor: 13500, total_due_minor: 0 });
  });

  it('ignores a placeholder whose line is not in the envelope (removed line)', () => {
    expect(
      envelopeDiscountTotals(lines, [{ line_id: 'gone', placeholder_kind: 'manual_pct_50' }]),
    ).toEqual({ discount_total_minor: 0, total_due_minor: 13500 });
  });

  it('is null for a non-canonical token, a second discount on a line, or an amount above the gross', () => {
    expect(
      envelopeDiscountTotals(lines, [{ line_id: 'l1', placeholder_kind: 'percent_10' }]),
    ).toBeNull();
    expect(
      envelopeDiscountTotals(lines, [
        { line_id: 'l1', placeholder_kind: 'manual_pct_10' },
        { line_id: 'l1', placeholder_kind: 'manual_pct_5' },
      ]),
    ).toBeNull();
    expect(
      envelopeDiscountTotals(lines, [{ line_id: 'l2', placeholder_kind: 'manual_amt_4501' }]),
    ).toBeNull();
  });

  it('is null when the subtotal overflows', () => {
    expect(
      envelopeDiscountTotals(
        [
          { line_id: 'a', line_subtotal_minor: Number.MAX_SAFE_INTEGER },
          { line_id: 'b', line_subtotal_minor: 1 },
        ],
        [],
      ),
    ).toBeNull();
  });
});
