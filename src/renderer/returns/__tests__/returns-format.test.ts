import { describe, expect, it } from 'vitest';

import { formatReturnMoney, formatReturnTime, normalizeSaleNumber } from '../returns-format.js';

/** RT-15 S3 — K4: Western digits, exact minor units, normalised input. */
describe('formatReturnMoney', () => {
  it('renders integer minor units exactly, never through a float', () => {
    expect(formatReturnMoney(12345, 'EGP')).toBe('123.45 EGP');
    expect(formatReturnMoney(5, 'EGP')).toBe('0.05 EGP');
  });

  it('renders a dash instead of a wrong number for unsafe or unknown-currency amounts', () => {
    expect(formatReturnMoney(Number.MAX_SAFE_INTEGER + 2, 'EGP')).toBe('—');
    expect(formatReturnMoney(1.5, 'EGP')).toBe('—');
    expect(formatReturnMoney(100, 'USD')).toBe('—');
  });
});

describe('normalizeSaleNumber', () => {
  it('turns Arabic-Indic and Persian digits into ASCII and trims', () => {
    expect(normalizeSaleNumber('  ٠١٢٣٤٥٦٧٨٩ ')).toBe('0123456789');
    expect(normalizeSaleNumber('T1-۱۲۳')).toBe('T1-123');
  });
});

describe('formatReturnTime', () => {
  it('uses Western digits for a valid timestamp', () => {
    const text = formatReturnTime('2026-10-04T09:05:00.000Z');
    expect(text).toMatch(/2026/);
    expect(text).not.toMatch(/[٠-٩]/);
  });

  it('renders a dash for an unparseable timestamp', () => {
    expect(formatReturnTime('not-a-date')).toBe('—');
  });
});
