/**
 * RT-259 (UX-08) — numeric human-input fields normalize Arabic-Indic and
 * Persian digits to ASCII. Display stays Western digits; only the Arabic
 * decimal separator is mapped, never a thousands separator.
 */
import { describe, expect, it } from 'vitest';

import { mapDigits, normalizeDigits, normalizeNumericInput } from '../normalize-digits';

describe('normalizeDigits', () => {
  it('leaves ASCII unchanged', () => {
    expect(normalizeDigits('0123456789')).toBe('0123456789');
    expect(normalizeDigits('12.50')).toBe('12.50');
  });

  it('maps Arabic-Indic digits to ASCII', () => {
    expect(normalizeDigits('١٢٣')).toBe('123');
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('maps Persian digits to ASCII', () => {
    expect(normalizeDigits('۱۲۳')).toBe('123');
    expect(normalizeDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  it('maps mixed ASCII / Arabic-Indic / Persian input', () => {
    expect(normalizeDigits('1٢۳')).toBe('123');
  });

  it('trims leading and trailing spaces', () => {
    expect(normalizeDigits('  ١٢٣  ')).toBe('123');
  });

  it('handles the empty string', () => {
    expect(normalizeDigits('')).toBe('');
  });

  it('does not map the decimal or thousands separators', () => {
    expect(normalizeDigits('١٢٣٫٥٠')).toBe('123٫50');
    expect(normalizeDigits('١٬٠٠٠')).toBe('1٬000');
  });
});

describe('mapDigits', () => {
  it('maps digits without trimming', () => {
    expect(mapDigits(' ١٢ ')).toBe(' 12 ');
  });
});

describe('normalizeNumericInput', () => {
  it('maps digits and the Arabic decimal separator to ".": «١٢٣٫٥٠» → "123.50"', () => {
    expect(normalizeNumericInput('١٢٣٫٥٠')).toBe('123.50');
  });

  it('maps Persian digits with the Arabic decimal separator', () => {
    expect(normalizeNumericInput('۱۲۳٫۵۰')).toBe('123.50');
  });

  it('leaves the Arabic thousands separator «٬» as-is (still rejected downstream)', () => {
    expect(normalizeNumericInput('١٬٠٠٠')).toBe('1٬000');
  });

  it('leaves the ASCII comma as-is (still rejected downstream)', () => {
    expect(normalizeNumericInput('1,000')).toBe('1,000');
  });

  it('leaves ASCII unchanged, trims spaces, handles empty', () => {
    expect(normalizeNumericInput('12.50')).toBe('12.50');
    expect(normalizeNumericInput('  ٥٠  ')).toBe('50');
    expect(normalizeNumericInput('')).toBe('');
  });
});
