import type { CashierPinState } from '../../../shared/bridge-api.js';

/**
 * RT-424 (D-M1) — the Manager → Cashiers screen copy, exactly as approved with
 * the G-3 references on 2026-10-12 (doc 19 §5, D4 and D5; the copy table in
 * docs/design/vnext/visual-acceptance/G3-Cashiers/G3-Spec.html).
 *
 * UX-12: the fixed verbs (حفظ / إلغاء) and the term «الكاشير». No string
 * interpolates a PIN, an id or a refusal category. A cashier name is admin
 * free text, so the screen renders it in `<bdi>` between a `before` and an
 * `after` part instead of building one string.
 */
export const CASHIERS_COPY = Object.freeze({
  /** M-K0 */
  title: 'إدارة الكاشير',
  /** M-K0b — the terminal label follows in `<bdi>`. */
  subtitle: 'الرقم السري لكل كاشير على الجهاز',
  /** M-K0c */
  listHeading: 'الكاشير في هذا الفرع',
  /** M-K0d */
  loading: 'جارٍ تحميل القائمة…',
  /** M-K1 (approved, D4): the roster is unreachable (`no_connection`). */
  rosterOffline: 'تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.',
  /** M-K1b: any other refusal. */
  rosterRefused: 'تعذّر تحميل قائمة الكاشير.',
  retry: 'إعادة المحاولة',
  /** The roster loaded and holds no cashier: the same fact as on sign-in. */
  empty: 'لا يوجد كاشير مسجّل في هذا الفرع.',
  /** M-K7 */
  setFirstPin: 'تعيين أول رقم سري',
  changePin: 'تغيير الرقم السري',
  unlock: 'فك القفل',
  save: 'حفظ',
  cancel: 'إلغاء',
  /** M-K8 */
  newPinLabel: 'الرقم السري الجديد',
  confirmPinLabel: 'تأكيد الرقم السري',
  pinHint: 'من 4 إلى 6 أرقام.',
  /** M-K3 */
  mismatch: 'الرقمان غير متطابقين.',
  /** M-K4 */
  wrongLength: 'الرقم السري من 4 إلى 6 أرقام.',
  /** M-K9 */
  genericFailure: 'تعذّر تنفيذ العملية. حاول مرة أخرى.',
  /** M-K10: provisioning refused `not_ready`, inline in the dialog. */
  notReady: 'لا يمكن تفعيل هذا الكاشير الآن. تواصل مع المشرف.',
});

/** M-K0c: «‹n› كاشير», Western digits. */
export function cashierCount(n: number): string {
  return `${String(n)} كاشير`;
}

/** M-K5: the badge text per state. */
export const PIN_STATE_LABEL: Readonly<Record<CashierPinState, string>> = Object.freeze({
  no_pin: 'بدون رقم سري',
  ready: 'جاهز',
  locked: 'مقفل',
});

/** A sentence around one cashier name: `before` <bdi>name</bdi> `after`. */
export interface NamedSentence {
  before: string;
  after: string;
}

/** M-K8 dialog titles. */
export const DIALOG_TITLE: Readonly<Record<'first' | 'change', NamedSentence>> = Object.freeze({
  first: { before: 'تعيين أول رقم سري لـ ', after: '' },
  change: { before: 'تغيير الرقم السري لـ ', after: '' },
});

/** M-K2, M-K2b, M-K2c success notices. */
export const SUCCESS_SENTENCE: Readonly<Record<'first' | 'change' | 'unlock', NamedSentence>> =
  Object.freeze({
    first: { before: 'تم تعيين الرقم السري لـ ', after: '.' },
    change: { before: 'تم تغيير الرقم السري لـ ', after: '.' },
    unlock: { before: 'تم فك القفل عن ', after: '.' },
  });

/** M-K6: «حتى HH:MM» in local time, Western digits, 24-hour. */
export function lockedUntilText(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `حتى ${hh}:${mm}`;
}

/** The cashier PIN rule (`PIN_RE` in main's pin-management.ts): 4–6 digits. */
export const CASHIER_PIN_RE = /^\d{4,6}$/;

/** The row badge: the first letter of the name (two letters break Arabic joining). */
export { nameInitial } from '../entry/entry-copy.js';
