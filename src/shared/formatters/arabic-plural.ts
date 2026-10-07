/**
 * Arabic plural-category selection (UX-12, RT-258).
 *
 * Arabic has six plural categories (zero / one / two / few / many / other).
 * Counted copy must therefore be a FULL template per category, not a number
 * glued to one noun form. `pluralAr` selects the template with
 * `Intl.PluralRules('ar')` (3-10 → few, 11-99 → many, 100+ → other) and fills
 * `{n}` with Western digits.
 *
 * No DOM / Electron dependencies, so it is safe from both main and renderer.
 * Prefer a noun-first dense counter («الأصناف: 3») where a sentence is not
 * needed; use this where a sentence is.
 */

export type ArabicPluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export interface ArabicPluralForms {
  /** Optional — falls back to `other` when absent. */
  readonly zero?: string;
  readonly one: string;
  readonly two: string;
  readonly few: string;
  readonly many: string;
  readonly other: string;
}

const RULES = new Intl.PluralRules('ar');
/** Western digits (UX-12), grouped thousands. */
const NUMBER = new Intl.NumberFormat('ar-EG-u-nu-latn');

/** The ICU `ar` plural category of `n`. */
export function arabicPluralCategory(n: number): ArabicPluralCategory {
  return RULES.select(n);
}

/**
 * Pick the template for `n`'s plural category and substitute every `{n}` with
 * the Western-digit count. A form may omit `{n}` by design («عملية واحدة»).
 */
export function pluralAr(n: number, forms: ArabicPluralForms): string {
  const template = forms[arabicPluralCategory(n)] ?? forms.other;
  return template.replaceAll('{n}', NUMBER.format(n));
}
