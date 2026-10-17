/**
 * RT-604 (VN-S6 S6-3) — the indicator's cashier copy. Each string is verbatim
 * from its approved source; `status-mapping.test.ts` checks them against the
 * documents, so the copy cannot drift. No other indicator copy exists.
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
  /** S16, doc 15: «جارٍ إرسال N عملية…», around the count. */
  sending: { before: 'جارٍ إرسال ', after: ' عملية…' },
  /** M-O2, doc 15: «‹n› عمليات بانتظار الإرسال», after the count. */
  waiting: { before: '', after: ' عمليات بانتظار الإرسال' },
  /** D-6-7, doc 24 §4.2: only while the last print failed. */
  printerFailed: 'فشل آخر إيصال',
} as const;

/**
 * RT-605 (VN-S6 S6-4) — the two status banners in the notices stack, verbatim
 * from doc 15 §M-O (D-6-11: M-O3 stays as frozen). `status-banners.test.ts`
 * checks them against doc 15. No list of online-only actions (D-6-9).
 */
export const BANNER_COPY = {
  /** M-O1, warning: `offline`, and `degraded` shown as offline (D-6-2). */
  offline: 'غير متصل — البيع محفوظ على هذا الجهاز وسيُرسَل عند عودة الاتصال.',
  /** M-O3, danger: «تعذّر إرسال ‹n› عمليات. راجع المدير.», around the count. */
  syncAttention: { before: 'تعذّر إرسال ', after: ' عمليات. راجع المدير.' },
} as const;
