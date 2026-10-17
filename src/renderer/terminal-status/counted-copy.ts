import {
  arabicPluralCategory,
  type ArabicPluralForms,
} from '../../shared/formatters/arabic-plural';

/** A counted sentence split around its count, so the count can be its own LTR run. */
export interface CountedParts {
  readonly before: string;
  /** Null when the form names the count in words («عملية واحدة»). */
  readonly count: number | null;
  readonly after: string;
}

const SLOT = '{n}';

/**
 * RT-646 — the sentence for `n`'s Arabic plural category (the RT-258 ICU `ar`
 * rules), split at `{n}`. The count stays a number: the view renders it as an
 * isolated LTR run with Western digits (doc 15 §5 rule 2).
 */
export function countedParts(n: number, forms: ArabicPluralForms): CountedParts {
  const template = forms[arabicPluralCategory(n)] ?? forms.other;
  const at = template.indexOf(SLOT);
  if (at === -1) return { before: template, count: null, after: '' };
  return { before: template.slice(0, at), count: n, after: template.slice(at + SLOT.length) };
}

/** The parts as one string (tests, and anywhere a plain name is needed). */
export function countedText(parts: CountedParts): string {
  return `${parts.before}${parts.count === null ? '' : String(parts.count)}${parts.after}`;
}
