/**
 * RT-437 (D-F2) — the pure cash-received bound shared by main and the
 * renderer (`src/shared/payments/cash-bound.ts`).
 */
import { describe, expect, it } from 'vitest';

import {
  isCashAmountWithinBound,
  maxCashReceivedMinor,
} from '../../../../src/shared/payments/cash-bound.js';

const CAP = 10_000_000; // EGP 100,000.00

describe('RT-437 — maxCashReceivedMinor', () => {
  it('is EGP 100,000.00 for EGP (owner decision 1)', () => {
    expect(maxCashReceivedMinor('EGP')).toBe(CAP);
  });

  it('fails closed with 0 for an unknown currency', () => {
    expect(maxCashReceivedMinor('USD')).toBe(0);
    expect(maxCashReceivedMinor('')).toBe(0);
    expect(maxCashReceivedMinor('constructor')).toBe(0);
  });
});

describe('RT-437 — isCashAmountWithinBound: amount ≤ max(cap, remaining)', () => {
  it('accepts the cap and refuses one minor unit above it on a small balance', () => {
    expect(isCashAmountWithinBound(CAP, 1500, 'EGP')).toBe(true);
    expect(isCashAmountWithinBound(CAP + 1, 1500, 'EGP')).toBe(false);
  });

  it('refuses the F-02 amount (a 13-digit barcode read as major units)', () => {
    expect(isCashAmountWithinBound(622_100_000_001_100, 1500, 'EGP')).toBe(false);
  });

  it('accepts a balance above the cap paid exactly, and refuses any overpay on it', () => {
    const remaining = 15_000_000; // EGP 150,000.00
    expect(isCashAmountWithinBound(remaining, remaining, 'EGP')).toBe(true);
    expect(isCashAmountWithinBound(remaining + 1, remaining, 'EGP')).toBe(false);
  });

  it('uses the balance still owed, not the subtotal (split case)', () => {
    // 150,000 sale with 149,999 already on card: 1 EGP owed.
    expect(isCashAmountWithinBound(15_000_000, 100, 'EGP')).toBe(false);
  });

  it('for an unknown currency accepts only up to the remaining balance', () => {
    expect(isCashAmountWithinBound(1500, 1500, 'USD')).toBe(true);
    expect(isCashAmountWithinBound(1501, 1500, 'USD')).toBe(false);
  });
});
