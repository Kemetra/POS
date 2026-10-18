/**
 * RT-278 S1 (plan `docs/design/vnext/29-rt278-shift-amount-bounds.md`, owner
 * decisions OD-278-1…3 in RT-278 comment 12764) — the pure plausibility bound
 * on shift amounts shared by main and the renderer
 * (`src/shared/shift-cashup/amount-bound.ts`).
 */
import { describe, expect, it } from 'vitest';

import { maxCashReceivedMinor } from '../../../../src/shared/payments/cash-bound.js';
import {
  isShiftAmountWithinBound,
  maxShiftEntryMinor,
  type ShiftAmountEntry,
} from '../../../../src/shared/shift-cashup/amount-bound.js';

const FLOAT_CAP = 10_000_000; // EGP 100,000.00 (OD-278-1)
const COUNT_CAP = 100_000_000; // EGP 1,000,000.00 (OD-278-2)
/** F-02: the 13-digit barcode 6221000000011 read as major units. */
const F02_MINOR = 622_100_000_001_100;

const CAPS: ReadonlyArray<readonly [ShiftAmountEntry, number]> = [
  ['opening_float', FLOAT_CAP],
  ['pay_in', FLOAT_CAP],
  ['counted_cash', COUNT_CAP],
];

describe('RT-278 — maxShiftEntryMinor', () => {
  it.each(CAPS)('%s is %i minor for EGP', (entry, cap) => {
    expect(maxShiftEntryMinor(entry, 'EGP')).toBe(cap);
  });

  it('takes the float and pay-in cap from the D-F2 cash constant (one owner decision moves both)', () => {
    expect(maxShiftEntryMinor('opening_float', 'EGP')).toBe(maxCashReceivedMinor('EGP'));
    expect(maxShiftEntryMinor('pay_in', 'EGP')).toBe(maxCashReceivedMinor('EGP'));
  });

  it.each(['USD', 'JPY', '', 'constructor', 'toString'])(
    'fails closed with 0 for an unknown currency (%j)',
    (currency) => {
      for (const [entry] of CAPS) expect(maxShiftEntryMinor(entry, currency)).toBe(0);
    },
  );
});

describe('RT-278 — isShiftAmountWithinBound: flat caps, nothing relative', () => {
  it.each(CAPS)('%s: accepts 0 and the cap, refuses cap + 1', (entry, cap) => {
    expect(isShiftAmountWithinBound(entry, 0, 'EGP')).toBe(true);
    expect(isShiftAmountWithinBound(entry, cap, 'EGP')).toBe(true);
    expect(isShiftAmountWithinBound(entry, cap + 1, 'EGP')).toBe(false);
  });

  it.each(CAPS)('%s: refuses the F-02 amount', (entry) => {
    expect(isShiftAmountWithinBound(entry, F02_MINOR, 'EGP')).toBe(false);
  });

  it('for an unknown currency accepts only 0', () => {
    expect(isShiftAmountWithinBound('opening_float', 0, 'USD')).toBe(true);
    expect(isShiftAmountWithinBound('opening_float', 1, 'USD')).toBe(false);
    expect(isShiftAmountWithinBound('pay_in', 1, 'USD')).toBe(false);
    expect(isShiftAmountWithinBound('counted_cash', 1, 'USD')).toBe(false);
  });
});
