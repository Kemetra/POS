/**
 * RT-239 (VNext A2) — cashier-facing scan notices, verbatim from the freeze
 * package message catalog (15 §5). Arabic only; nothing here is invented.
 */

/** The three kinds of field that must never receive a scan. */
export type RefuseKind = 'amount' | 'pin' | 'reference';

/** M-S5 — a scan reached a money, PIN or card-reference field. */
export const SCAN_REFUSED_MESSAGE: Readonly<Record<RefuseKind, string>> = {
  amount: 'لا يُقبل المسح في حقل المبلغ. أدخل المبلغ بالأرقام.',
  pin: 'لا يُقبل المسح في حقل الرقم السري. أدخل الرقم السري بالأرقام.',
  reference: 'لا يُقبل المسح في حقل المرجع. اكتب المرجع من إيصال جهاز البطاقات.',
};

/** M-S6 — a scan arrived while a dialog was open. */
export const SCAN_DIALOG_OPEN_MESSAGE = 'أغلق النافذة أولاً ثم امسح الصنف.';

/** M-S1 (unavailable) — no screen is currently accepting scans. */
export const SCAN_UNAVAILABLE_MESSAGE = 'المسح غير متاح';

/** M-S7 — a scan on a completed sale. */
export const SCAN_SALE_COMPLETE_MESSAGE = 'هذا البيع مكتمل. اضغط «بيع جديد» ثم امسح الصنف.';
