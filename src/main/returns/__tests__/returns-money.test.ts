/**
 * RT-15 S2 — exact return pricing (AC6): the contract's cumulative-difference
 * rule in bigint ten-thousandths, round4 half away from zero, and the
 * minor-unit gate. No float anywhere.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  amount4ToMinor,
  parseAmount4,
  parseWholeQuantity,
  priceReturnLine,
} from '../returns-money.js';

describe('parseAmount4', () => {
  it.each<[string, bigint | null]>([
    ['45.0000', 450000n],
    ['45', 450000n],
    ['0.05', 500n],
    ['0.0001', 1n],
    ['123456789012345.9999', 1234567890123459999n],
    ['-1.00', null],
    ['1.00001', null],
    ['1e3', null],
    ['', null],
    [' 1.00', null],
  ])('%j → %s', (value, expected) => {
    expect(parseAmount4(value)).toBe(expected);
  });
});

describe('parseWholeQuantity', () => {
  it.each<[string, number | null]>([
    ['3', 3],
    ['3.000000', 3],
    ['0', 0],
    ['2.5', null],
    ['2.000001', null],
    ['-1', null],
    ['abc', null],
    ['99999999999999', null],
  ])('%j → %s', (value, expected) => {
    expect(parseWholeQuantity(value)).toBe(expected);
  });
});

describe('priceReturnLine — round4(A×(c+q)/Q) − round4(A×c/Q)', () => {
  it.each<{ label: string; a: string; sold: number; returned: number; q: number; want: bigint }>([
    {
      label: 'conforming line prices to u × q',
      a: '45.0000',
      sold: 3,
      returned: 0,
      q: 2,
      want: 300000n,
    },
    {
      label: 'second partial on a conforming line',
      a: '45.0000',
      sold: 3,
      returned: 2,
      q: 1,
      want: 150000n,
    },
    {
      label: 'pre-RT-105 line rounds the first third',
      a: '10.0000',
      sold: 3,
      returned: 0,
      q: 1,
      want: 33333n,
    },
    {
      label: 'the middle third absorbs the rounding',
      a: '10.0000',
      sold: 3,
      returned: 1,
      q: 1,
      want: 33334n,
    },
    {
      label: 'the last third closes the line exactly',
      a: '10.0000',
      sold: 3,
      returned: 2,
      q: 1,
      want: 33333n,
    },
    { label: 'half rounds away from zero', a: '0.0001', sold: 2, returned: 0, q: 1, want: 1n },
    { label: 'the other half is then zero', a: '0.0001', sold: 2, returned: 1, q: 1, want: 0n },
  ])('$label', ({ a, sold, returned, q, want }) => {
    const lineAmount4 = parseAmount4(a) ?? -1n;
    expect(priceReturnLine({ lineAmount4, sold, returned, quantity: q })).toBe(want);
  });

  it('all returns on a line sum to its lineAmount once fully returned (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 8 }),
        (lineAmount4, parts) => {
          const sold = parts.reduce((s, p) => s + p, 0);
          let returned = 0;
          let sum = 0n;
          for (const quantity of parts) {
            sum += priceReturnLine({ lineAmount4, sold, returned, quantity });
            returned += quantity;
          }
          return sum === lineAmount4;
        },
      ),
    );
  });
});

describe('amount4ToMinor', () => {
  it.each<[bigint, number, number | null]>([
    [150000n, 2, 1500],
    [33333n, 2, null],
    [150000n, 0, 15],
    [150500n, 0, null],
    [150500n, 3, 15050],
    [7n, 4, 7],
    [-100n, 2, null],
    [100n, 5, null],
    [100n, -1, null],
    [100n, 1.5, null],
    [10n ** 30n, 2, null],
  ])('%s at exponent %s → %s', (amount4, exponent, expected) => {
    expect(amount4ToMinor(amount4, exponent)).toBe(expected);
  });
});
