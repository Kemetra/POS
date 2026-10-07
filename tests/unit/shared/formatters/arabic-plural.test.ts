/**
 * RT-258 / UX-12 — Arabic has six plural categories. `pluralAr` picks a full
 * sentence template per `Intl.PluralRules('ar')` category and renders `{n}`
 * with Western digits.
 */

import { describe, expect, it } from 'vitest';

import { arabicPluralCategory, pluralAr } from '../../../../src/shared/formatters/arabic-plural.js';

const FORMS = {
  zero: 'لا عمليات',
  one: 'عملية واحدة',
  two: 'عمليتان',
  few: '{n} عمليات',
  many: '{n} عملية',
  other: '{n} عملية (أخرى)',
} as const;

describe('arabicPluralCategory (ICU `ar` rules)', () => {
  it.each([
    [0, 'zero'],
    [1, 'one'],
    [2, 'two'],
    [3, 'few'],
    [10, 'few'],
    [11, 'many'],
    [99, 'many'],
    [100, 'other'],
    [101, 'other'],
    [102, 'other'],
  ] as const)('%i → %s', (n, category) => {
    expect(arabicPluralCategory(n)).toBe(category);
  });
});

describe('pluralAr', () => {
  it.each([
    [0, 'لا عمليات'],
    [1, 'عملية واحدة'],
    [2, 'عمليتان'],
    [3, '3 عمليات'],
    [10, '10 عمليات'],
    [11, '11 عملية'],
    [99, '99 عملية'],
    [100, '100 عملية (أخرى)'],
    [101, '101 عملية (أخرى)'],
    [102, '102 عملية (أخرى)'],
  ])('selects the template for %i', (n, expected) => {
    expect(pluralAr(n, FORMS)).toBe(expected);
  });

  it('falls back to `other` when the category has no template (zero is optional)', () => {
    const noZero = { ...FORMS, zero: undefined };
    expect(pluralAr(0, noZero)).toBe('0 عملية (أخرى)');
  });

  it('substitutes every {n} occurrence', () => {
    expect(pluralAr(5, { ...FORMS, few: '{n} من {n}' })).toBe('5 من 5');
  });

  it('groups thousands and keeps Western digits, never Arabic-Indic', () => {
    const out = pluralAr(1234, FORMS);
    expect(out).toBe('1,234 عملية');
    expect(out).not.toMatch(/[٠-٩]/);
    expect(pluralAr(3, FORMS)).not.toMatch(/[٠-٩]/);
  });
});
