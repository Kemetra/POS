/**
 * RT-646 — count-aware Arabic forms for the sync counts (M-O2, S16, M-O3).
 * `countedParts` picks the plural-category sentence (RT-258's ICU `ar` rules)
 * and splits it around the count, so the count stays an isolated LTR run.
 * The copy itself is checked here form by form, and against doc 15 §5.1.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArabicPluralForms } from '../../../shared/formatters/arabic-plural';
import { countedParts, countedText } from '../counted-copy';
import { BANNER_COPY, STATUS_COPY } from '../status-copy';

describe('countedParts', () => {
  const forms: ArabicPluralForms = {
    one: 'ONE',
    two: 'TWO',
    few: 'a {n} few',
    many: '{n} many',
    other: 'other {n}',
  };

  it.each([
    [1, { before: 'ONE', count: null, after: '' }],
    [2, { before: 'TWO', count: null, after: '' }],
    [3, { before: 'a ', count: 3, after: ' few' }],
    [10, { before: 'a ', count: 10, after: ' few' }],
    [11, { before: '', count: 11, after: ' many' }],
    [99, { before: '', count: 99, after: ' many' }],
    [100, { before: 'other ', count: 100, after: '' }],
    [102, { before: 'other ', count: 102, after: '' }],
    [103, { before: 'a ', count: 103, after: ' few' }],
    [111, { before: '', count: 111, after: ' many' }],
  ] as const)('%i → its plural category, split around the count', (n, expected) => {
    expect(countedParts(n, forms)).toEqual(expected);
  });

  it('falls back to «other» for zero when no zero form is given', () => {
    expect(countedParts(0, forms)).toEqual({ before: 'other ', count: 0, after: '' });
  });

  it('joins the parts back into one string with Western digits', () => {
    expect(countedText(countedParts(12, forms))).toBe('12 many');
    expect(countedText(countedParts(1, forms))).toBe('ONE');
  });
});

describe('the RT-646 sync-count copy, form by form', () => {
  const text = (n: number, f: ArabicPluralForms): string => countedText(countedParts(n, f));

  it.each([
    [1, 'عملية واحدة بانتظار الإرسال'],
    [2, 'عمليتان بانتظار الإرسال'],
    [3, '3 عمليات بانتظار الإرسال'],
    [10, '10 عمليات بانتظار الإرسال'],
    [11, '11 عملية بانتظار الإرسال'],
    [100, '100 عملية بانتظار الإرسال'],
    [103, '103 عمليات بانتظار الإرسال'],
  ] as const)('M-O2 at %i: «%s»', (n, expected) => {
    expect(text(n, STATUS_COPY.waiting)).toBe(expected);
  });

  it.each([
    [1, 'جارٍ إرسال عملية واحدة…'],
    [2, 'جارٍ إرسال عمليتين…'],
    [3, 'جارٍ إرسال 3 عمليات…'],
    [10, 'جارٍ إرسال 10 عمليات…'],
    [11, 'جارٍ إرسال 11 عملية…'],
    [100, 'جارٍ إرسال 100 عملية…'],
  ] as const)('S16 at %i: «%s»', (n, expected) => {
    expect(text(n, STATUS_COPY.sending)).toBe(expected);
  });

  it.each([
    [1, 'تعذّر إرسال عملية واحدة. راجع المدير.'],
    [2, 'تعذّر إرسال عمليتين. راجع المدير.'],
    [3, 'تعذّر إرسال 3 عمليات. راجع المدير.'],
    [10, 'تعذّر إرسال 10 عمليات. راجع المدير.'],
    [11, 'تعذّر إرسال 11 عملية. راجع المدير.'],
    [100, 'تعذّر إرسال 100 عملية. راجع المدير.'],
  ] as const)('M-O3 at %i: «%s»', (n, expected) => {
    expect(text(n, BANNER_COPY.syncAttention)).toBe(expected);
  });

  it('gives 100+ ("other") the same sentence as 11–99 ("many"), and defines no zero form', () => {
    for (const forms of [STATUS_COPY.waiting, STATUS_COPY.sending, BANNER_COPY.syncAttention]) {
      expect(forms.other).toBe(forms.many);
      expect(forms.zero).toBeUndefined();
    }
  });
});

describe('the RT-646 sync-count copy matches doc 15 §5.1', () => {
  const doc15 = readFileSync(
    resolve(__dirname, '../../../../docs/design/vnext/15-vnext-freeze-package.md'),
    'utf8',
  );
  const cell = (s: string): string => `«${s.replace('{n}', '‹n›')}»`;
  const row = (id: string, f: ArabicPluralForms): string =>
    `| ${id} | ${cell(f.one)} | ${cell(f.two)} | ${cell(f.few)} | ${cell(f.many)} |`;

  it.each([
    ['M-O2', STATUS_COPY.waiting],
    ['S16', STATUS_COPY.sending],
    ['M-O3', BANNER_COPY.syncAttention],
  ] as const)('%s', (id, forms) => {
    expect(doc15).toContain(row(id, forms));
  });

  it('records the forms as owner-approved', () => {
    expect(doc15).toContain('### 5.1 Count-aware sync counts (RT-646) — owner-approved 2026-10-17');
  });
});
