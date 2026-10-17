import type { ArabicPluralForms } from '../../shared/formatters/arabic-plural';

/**
 * RT-646 — the counted sync copy has one full sentence per Arabic plural
 * category (doc 15 §5.1): words for 1 and 2, a Western digit from 3. The dual
 * is genitive after «إرسال». A count of 0 cannot reach these, so there is no
 * zero form; 100+ («other») reads as 11+.
 */
function counted(forms: Omit<ArabicPluralForms, 'other' | 'zero'>): ArabicPluralForms {
  return { ...forms, other: forms.many };
}

/**
 * RT-604 (VN-S6 S6-3) — the indicator's cashier copy. Each string is verbatim
 * from its approved source; `status-mapping.test.ts` (and, for the counted
 * forms, `counted-copy.test.ts`) checks them against the documents, so the
 * copy cannot drift. No other indicator copy exists.
 */
export const STATUS_COPY = {
  /** M-O4, doc 15 §M-O: healthy, only from a real signal. */
  online: 'متصل',
  /** U3, doc 24 §4.1: `offline`, and `degraded` shown as offline (D-6-2). */
  offline: 'غير متصل',
  /** U7, doc 24 §4.1: the new string approved with D-6-2. */
  checking: 'جارٍ التحقق من الاتصال',
  /** U2, doc 24 §4.1: dead letter, or a pending sale older than 24 h (D-6-5). */
  syncAttention: 'تحتاج مراجعة',
  /** S16, doc 15 §5.1 (RT-646): «جارٍ إرسال ‹n› عمليات…», count-aware. */
  sending: counted({
    one: 'جارٍ إرسال عملية واحدة…',
    two: 'جارٍ إرسال عمليتين…',
    few: 'جارٍ إرسال {n} عمليات…',
    many: 'جارٍ إرسال {n} عملية…',
  }),
  /** M-O2, doc 15 §5.1 (RT-646): «‹n› عمليات بانتظار الإرسال», count-aware. */
  waiting: counted({
    one: 'عملية واحدة بانتظار الإرسال',
    two: 'عمليتان بانتظار الإرسال',
    few: '{n} عمليات بانتظار الإرسال',
    many: '{n} عملية بانتظار الإرسال',
  }),
  /** D-6-7, doc 24 §4.2: only while the last print failed. */
  printerFailed: 'فشل آخر إيصال',
} as const;

/**
 * RT-605 (VN-S6 S6-4) — the two status banners in the notices stack, from
 * doc 15 §M-O (D-6-11); M-O3's count-aware forms are RT-646 (§5.1).
 * `status-banners.test.ts` and `counted-copy.test.ts` check them against doc
 * 15. No list of online-only actions (D-6-9).
 */
export const BANNER_COPY = {
  /** M-O1, warning: `offline`, and `degraded` shown as offline (D-6-2). */
  offline: 'غير متصل — البيع محفوظ على هذا الجهاز وسيُرسَل عند عودة الاتصال.',
  /** M-O3, danger, doc 15 §5.1 (RT-646): «تعذّر إرسال ‹n› عمليات. راجع المدير.», count-aware. */
  syncAttention: counted({
    one: 'تعذّر إرسال عملية واحدة. راجع المدير.',
    two: 'تعذّر إرسال عمليتين. راجع المدير.',
    few: 'تعذّر إرسال {n} عمليات. راجع المدير.',
    many: 'تعذّر إرسال {n} عملية. راجع المدير.',
  }),
} as const;
