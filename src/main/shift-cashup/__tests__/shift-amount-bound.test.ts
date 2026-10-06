/**
 * RT-17 follow-up (comment 10948, "JPY bound") — the POS-side maximum of a shift
 * amount, per currency.
 *
 * Backend-Core stores a shift amount in `NUMERIC(19,4)`: at most 15 integer
 * digits (the contract's `^-?[0-9]{1,15}(\.[0-9]{1,4})?$`). The POS holds
 * minor units as safe integers (≤ 2^53 − 1, 16 digits). For a currency with 2 or
 * 3 minor-unit digits that range is already below 10^15 major units, but JPY
 * (no decimals) would reach 9 007 199 254 740 991 yen, one digit too many: a
 * shift could be driven to an aggregate the close then cannot send. So the
 * maximum is the smaller of the safe-integer range and 15 integer digits.
 */
import { describe, expect, it } from 'vitest';

import {
  knownExponentFor,
  minorUnitsToDecimalString,
} from '../../sales-sync/create-sale-sync-client.js';
import { maxShiftAmountMinor } from '../shift-amount-bound.js';

/** The currencies the POS knows (the sale-sync client's exponent table). */
const CURRENCIES = ['EGP', 'USD', 'JPY', 'KWD', 'BHD'] as const;

/** Backend-Core `NUMERIC(19,4)`: 19 digits in all, 4 of them after the point. */
const NUMERIC_19_4 = /^-?[0-9]{1,15}(\.[0-9]{1,4})?$/;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function integerDigits(decimal: string): number {
  return (decimal.split('.')[0] ?? '').length;
}

describe('maxShiftAmountMinor — every currency fits NUMERIC(19,4)', () => {
  it.each(CURRENCIES)('%s: the maximum is a known, safe, positive integer', (code) => {
    expect(knownExponentFor(code)).toBeDefined();
    const max = maxShiftAmountMinor(code);
    expect(Number.isSafeInteger(max)).toBe(true);
    expect(max).toBeGreaterThan(0);
  });

  it.each(CURRENCIES)(
    '%s: the maximum, as a major amount, has at most 15 integer digits',
    (code) => {
      const exponent = knownExponentFor(code) ?? Number.NaN;
      const max = minorUnitsToDecimalString(maxShiftAmountMinor(code), exponent);
      expect(max).toMatch(NUMERIC_19_4);
      expect(integerDigits(max)).toBeLessThanOrEqual(15);
    },
  );

  it.each(CURRENCIES)(
    '%s: the maximum is as high as it can be (one more is unsafe, or has 16 digits)',
    (code) => {
      const exponent = knownExponentFor(code) ?? Number.NaN;
      const max = maxShiftAmountMinor(code);
      if (max === MAX_SAFE) return;
      expect(integerDigits(minorUnitsToDecimalString(max + 1, exponent))).toBe(16);
    },
  );

  it('JPY (no decimals) is held to 15 digits: 999 999 999 999 999, below the safe integer', () => {
    expect(maxShiftAmountMinor('JPY')).toBe(999_999_999_999_999);
    expect(maxShiftAmountMinor('JPY')).toBeLessThan(MAX_SAFE);
  });

  it.each(['EGP', 'USD', 'KWD', 'BHD'] as const)(
    '%s keeps the full safe-integer range (it already fits 15 digits)',
    (code) => {
      expect(maxShiftAmountMinor(code)).toBe(MAX_SAFE);
    },
  );

  it('an unknown currency has no usable maximum (fail closed)', () => {
    expect(maxShiftAmountMinor('XYZ')).toBe(0);
    expect(maxShiftAmountMinor('egp')).toBe(0);
  });
});
