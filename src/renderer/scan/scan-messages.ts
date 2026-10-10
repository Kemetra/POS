/**
 * RT-239 (VNext A2) / RT-242 — cashier-facing scan and add notices. Arabic only.
 * Every string is verbatim from the freeze package message catalog (15 §5) or
 * existing app copy, except `SALE_FROZEN_MESSAGE`, which is marked as proposed
 * copy pending owner approval.
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

/** Unicode first-strong isolate: the code reads left to right inside Arabic copy. */
function isolateLtr(value: string): string {
  return `⁨${value}⁩`;
}

/** M-S3 — a scanned barcode that is not in the catalogue (inactive products included). */
export function scanNotFoundMessage(code: string): string {
  return `الباركود ${isolateLtr(code)} غير موجود في الكتالوج. امسح مرة أخرى أو ابحث بالاسم.`;
}

/**
 * RT-242 — the remaining scan and add outcomes. Existing app copy, Arabic only
 * (UX-12): the ambiguous and catalogue-unavailable texts are the ones the
 * search results already show; the add failure is the Arabic half of the
 * retired confirm dialog's error.
 */
export const SCAN_AMBIGUOUS_MESSAGE = 'تطابق أكثر من صنف مع الباركود.';
export const SCAN_CATALOGUE_UNAVAILABLE_MESSAGE = 'الكتالوج غير متاح حاليًا.';
export const SALE_ADD_FAILED_MESSAGE = 'تعذّرت الإضافة — حاول مرة أخرى';

/**
 * RT-242 — a scan or pick on a cart already handed to payment (not yet paid).
 * Proposed copy, pending owner approval: the catalogue (15 §5) has no row for it.
 */
export const SALE_FROZEN_MESSAGE = 'السلة مُسلّمة للدفع؛ لا تُضاف إليها أصناف.';
