/**
 * RT-424 (RT-251 doc 19 §5) — the Manager → Cashiers copy. Approved with the
 * G-3 references on 2026-10-12 (owner: «موافق على الشكل والنصوص»). The
 * cashier and terminal names are admin free text: the screen renders them in
 * `<bdi>` after these prefixes. No string interpolates a PIN, an id or a
 * refusal category (UX-12).
 */
export const CASHIERS_COPY = Object.freeze({
  /** M-K0. */
  title: 'إدارة الكاشير',
  /** M-K0b, followed by the terminal label. */
  subtitle: 'الرقم السري لكل كاشير على الجهاز',
  /** M-K0c. */
  listHeading: 'الكاشير في هذا الفرع',
  count: (n: number): string => `${String(n)} كاشير`,
  /** M-K0d. */
  loading: 'جارٍ تحميل القائمة…',
  /** M-K1 (D4). */
  unreachable: 'تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.',
  /** M-K1b. */
  refused: 'تعذّر تحميل قائمة الكاشير.',
  retry: 'إعادة المحاولة',
  empty: 'لا يوجد كاشير مسجّل في هذا الفرع.',
  /** M-K5. */
  badge: Object.freeze({ no_pin: 'بدون رقم سري', ready: 'جاهز', locked: 'مقفل' }),
  /** M-K6, followed by the time. */
  lockedUntil: 'حتى',
  /** M-K7. */
  action: Object.freeze({
    first_pin: 'تعيين أول رقم سري',
    change_pin: 'تغيير الرقم السري',
    unlock: 'فك القفل',
  }),
  save: 'حفظ',
  cancel: 'إلغاء',
  /** M-K8, followed by the cashier name. */
  dialogTitle: Object.freeze({
    first_pin: 'تعيين أول رقم سري لـ',
    change_pin: 'تغيير الرقم السري لـ',
  }),
  newPin: 'الرقم السري الجديد',
  confirmPin: 'تأكيد الرقم السري',
  hint: 'من 4 إلى 6 أرقام.',
  /** M-K3. */
  mismatch: 'الرقمان غير متطابقين.',
  /** M-K4. */
  wrongLength: 'الرقم السري من 4 إلى 6 أرقام.',
  /** M-K2 / M-K2b / M-K2c, followed by the cashier name and a full stop. */
  done: Object.freeze({
    first_pin: 'تم تعيين الرقم السري لـ',
    change_pin: 'تم تغيير الرقم السري لـ',
    unlock: 'تم فك القفل عن',
  }),
  /** M-K9. */
  failure: 'تعذّر تنفيذ العملية. حاول مرة أخرى.',
  /** M-K10, inside the first-PIN dialog. */
  notReady: 'لا يمكن تفعيل هذا الكاشير الآن. تواصل مع المشرف.',
});
