import { describe, expect, it } from 'vitest';
import { formatHumanCount, formatHumanDateTime, formatHumanMoney } from '../human-format';

const NON_WESTERN_DIGITS = /[٠-٩۰-۹]/;

describe('formatHumanMoney (UX-12)', () => {
  it.each([
    [0, '0.00 EGP'],
    [5, '0.05 EGP'],
    [99999, '999.99 EGP'],
    [100000, '1,000.00 EGP'],
    [123456789, '1,234,567.89 EGP'],
    [-125000, '-1,250.00 EGP'],
    [-5, '-0.05 EGP'],
  ])('renders %i minor units as %s', (minor, expected) => {
    expect(formatHumanMoney(minor)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 12.5, Number.MAX_SAFE_INTEGER + 2])(
    'renders a non-safe integer (%s) as an em dash',
    (value) => {
      expect(formatHumanMoney(value)).toBe('—');
    },
  );

  it('uses Western digits only', () => {
    expect(formatHumanMoney(123456789)).not.toMatch(NON_WESTERN_DIGITS);
  });
});

describe('formatHumanDateTime (UX-12)', () => {
  it('renders a 24-hour clock (15:05, never 3:05)', () => {
    const iso = new Date(2026, 5, 7, 15, 5, 0).toISOString();
    const out = formatHumanDateTime(iso);
    expect(out).not.toBeNull();
    expect(out).toContain('15:05');
    expect(out).not.toMatch(NON_WESTERN_DIGITS);
  });

  it('renders midnight as 00:xx, not 12:xx', () => {
    const iso = new Date(2026, 5, 7, 0, 7, 0).toISOString();
    expect(formatHumanDateTime(iso)).toContain('00:07');
  });

  it('includes the year only when asked', () => {
    const iso = new Date(2026, 5, 7, 9, 30, 0).toISOString();
    expect(formatHumanDateTime(iso)).not.toContain('2026');
    expect(formatHumanDateTime(iso, { withYear: true })).toContain('2026');
  });

  it('can render a date without a clock, in Western digits', () => {
    const iso = new Date(2026, 5, 7, 15, 5, 0).toISOString();
    const out = formatHumanDateTime(iso, { withYear: true, withDate: true, withTime: false });
    expect(out).not.toBeNull();
    expect(out).toContain('2026');
    expect(out).not.toContain('15:05');
    expect(out).not.toMatch(NON_WESTERN_DIGITS);
  });

  it('returns null for an unparseable value', () => {
    expect(formatHumanDateTime('not-a-date')).toBeNull();
    expect(formatHumanDateTime('')).toBeNull();
  });
});

describe('formatHumanCount (UX-12)', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [1234, '1,234'],
  ])('renders %i as %s', (n, expected) => {
    expect(formatHumanCount(n)).toBe(expected);
  });

  it('uses Western digits only', () => {
    expect(formatHumanCount(1234567)).not.toMatch(NON_WESTERN_DIGITS);
  });
});
