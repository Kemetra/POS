import type {
  ShiftCashupRefusal,
  ShiftMovementReasonCode,
} from '../../../shared/shift-cashup/types';

/**
 * RT-17 slice 4 part 3 — the shift screens' Arabic copy.
 *
 * One message per typed refusal (the closed `SHIFT_CASHUP_REFUSALS` set),
 * each saying what is true and what to do, with no interpolated input: no
 * amount, no bound, no reason token, no identifier. A reason outside the set
 * (main never sends one) falls back to the generic line.
 */
const REFUSAL_COPY: Readonly<Record<ShiftCashupRefusal, string>> = Object.freeze({
  feature_disabled: 'إدارة الوردية غير مفعّلة على هذا الجهاز.',
  no_session: 'لا توجد جلسة تشغيل صالحة على هذا الجهاز. سجّل الدخول من جديد.',
  session_locked: 'الجلسة مقفلة. افتحها ثم حاول مجددًا.',
  no_cashier_identity: 'تُفتح الوردية وتُسجَّل حركاتها وتُغلق من جلسة كاشير فقط.',
  invalid_input: 'البيانات غير صالحة. راجع المبلغ والسبب والملاحظة.',
  shift_already_open: 'توجد وردية مفتوحة على هذا الجهاز بالفعل.',
  shift_not_open: 'لا توجد وردية مفتوحة على هذا الجهاز.',
  clock_regressed: 'ساعة الجهاز أقدم من آخر عملية وردية مسجَّلة. صحّح الوقت ثم حاول.',
  drawer_activity_pending:
    'على هذا الجهاز صرف مرتجع أو بيع لم يكتمل بعد. أكمله ثم حاول مجددًا. لم يُسجَّل شيء.',
  pay_out_not_accepted: 'لم يُقبل السحب، ولم يُسجَّل شيء. راجع المدير.',
  variance_approval_required: 'العدّ يحتاج موافقة مدير قبل إغلاق الوردية.',
  approver_invalid: 'لم تُقبل موافقة المدير. تحقّق من اسم المدير ورقمه السري.',
  approver_locked:
    'رقم هذا المدير مقفل مؤقتًا بعد محاولات خاطئة. حاول بعد بضع دقائق أو اختر مديرًا آخر.',
  approver_is_closer: 'لا يعتمد من يغلق الوردية فرقَ عدّه بنفسه. اختر مديرًا آخر.',
  approval_stale: 'تغيّر نشاط الدرج أثناء الموافقة. عُدّ النقد من جديد ثم أعد الإغلاق.',
  not_manager: 'حفظ الرقم السري متاح لمدير أو مسؤول نظام سجّل دخوله عبر الإنترنت.',
  reauth_required:
    'انتهت مهلة التحقق. سجّل الخروج ثم سجّل الدخول من جديد، واحفظ الرقم السري خلال دقيقتين.',
  pin_too_weak: 'الرقم السري سهل التخمين (تكرار أو تسلسل أو رقم شائع). اختر رقمًا آخر.',
  current_pin_required: 'لديك رقم سري محفوظ على هذا الجهاز. أدخل الرقم الحالي لتغييره.',
  current_pin_invalid: 'الرقم السري الحالي غير صحيح.',
  current_pin_locked: 'الرقم السري الحالي مقفل مؤقتًا بعد محاولات خاطئة. حاول بعد بضع دقائق.',
  cashup_unavailable: 'تعذّر حساب الوردية من سجلات هذا الجهاز، ولم يُسجَّل شيء. راجع الدعم.',
  unavailable: 'تعذّر تنفيذ الطلب على هذا الجهاز. حاول مرة أخرى.',
});

/** Screen titles and shared lines. */
const GENERAL_COPY = {
  title: 'الوردية',
  managerTitle: 'حالة الوردية',
  unknownRefusal: 'تعذّر تنفيذ الطلب، ولم يُسجَّل شيء.',
  bridgeMissing: 'الوردية غير متاحة في هذه النسخة من التطبيق.',
  loading: 'جارٍ تحميل حالة الوردية…',
  retry: 'إعادة المحاولة',
  refresh: 'تحديث',
  refreshFailed: 'تعذّر تحديث حالة الوردية. ما سُجّل أعلاه محفوظ.',
  cancel: 'إلغاء',
  invalidAmount: 'أدخل مبلغًا صحيحًا بخانتين عشريتين على الأكثر.',
} as const;

/** The "shift required" gate (frame notice). */
const GATE_COPY = {
  gateBanner: 'لا توجد وردية مفتوحة على هذا الجهاز. افتح وردية بمبلغ الافتتاح قبل البيع.',
  gateAction: 'فتح الوردية',
  manageShift: 'إدارة الوردية',
  managerLink: 'حالة الوردية',
} as const;

/** Opening a shift. */
const OPEN_COPY = {
  openHeading: 'فتح وردية',
  floatLabel: 'مبلغ الافتتاح في الدرج',
  openCommit: 'فتح الوردية',
  opened: 'فُتحت الوردية.',
  goToSale: 'الذهاب إلى البيع',
} as const;

/** The open shift's summary (never the expected cash). */
const OPEN_SHIFT_COPY = {
  openSince: 'وردية مفتوحة منذ',
  floatRow: 'مبلغ الافتتاح',
  payInsRow: 'إجمالي الإيداعات',
  payOutsRow: 'إجمالي السحوبات',
} as const;

/** Pay-in / pay-out. */
const MOVEMENT_COPY = {
  payIn: 'إيداع نقدي',
  payOut: 'سحب نقدي',
  amountLabel: 'المبلغ',
  reasonLabel: 'السبب',
  noteLabel: 'ملاحظة (اختياري، دون بيانات شخصية)',
  record: 'تسجيل',
  recordedIn: 'سُجّل الإيداع.',
  recordedOut: 'سُجّل السحب.',
} as const;

/** The blind-count close. */
const CLOSE_COPY = {
  closeHeading: 'إغلاق الوردية',
  blindHint: 'عُدّ النقد في الدرج وأدخله. لا يظهر المبلغ المتوقع قبل تسجيل العدّ.',
  countLabel: 'النقد المعدود في الدرج',
  closeCommit: 'تسجيل العدّ وإغلاق الوردية',
  closed: 'أُغلقت الوردية.',
  varianceLabel: 'فرق العدّ المعتمد',
} as const;

/** The manager approval of a variance. */
const APPROVAL_COPY = {
  approvalTitle: 'موافقة المدير',
  approvalBody: 'لا يُغلق هذا العدّ إلا بموافقة مدير مسجَّل على هذا الجهاز، برقمه السري.',
  managerLegend: 'المدير',
  pinLabel: 'الرقم السري للمدير',
  approveCommit: 'اعتماد وإغلاق',
  loadingManagers: 'جارٍ تحميل المديرين…',
  noManagers:
    'لا يوجد مدير برقم سري على هذا الجهاز. يحفظ المدير رقمه من شاشة حالة الوردية بعد تسجيل دخوله.',
} as const;

/** Manager PIN enrolment. */
const ENROL_COPY = {
  enrollHeading: 'الرقم السري للمدير على هذا الجهاز',
  enrollHint:
    'يُستخدم لاعتماد فرق العدّ عند إغلاق الوردية. احفظه خلال دقيقتين من تسجيل دخولك عبر الإنترنت.',
  newPinLabel: 'الرقم السري الجديد (6 إلى 8 أرقام)',
  confirmPinLabel: 'تأكيد الرقم السري',
  currentPinLabel: 'الرقم السري الحالي (عند التغيير فقط)',
  enrollCommit: 'حفظ الرقم السري',
  enrolled: 'حُفظ الرقم السري لهذا الجهاز.',
  pinMismatch: 'الرقمان غير متطابقين.',
  pinShape: 'الرقم السري من 6 إلى 8 أرقام.',
} as const;

/** The manager's status panel. */
const STATUS_COPY = {
  statusHeading: 'حالة الوردية على هذا الجهاز',
  noOpenShift: 'لا توجد وردية مفتوحة.',
  queueHeading: 'وقائع الوردية غير المؤكَّدة على الخادم',
  queuePending: 'بانتظار الإرسال',
  queueWaiting: 'بانتظار إعادة المحاولة',
  queueBlocked: 'متوقفة',
  queueEnvelope: 'بانتظار مسار المدير',
  strandedHeading: 'خارج إقران هذا الجهاز',
  strandedFacts: 'وقائع غير مرسلة',
  strandedShifts: 'ورديات مفتوحة',
  pendingHeading: 'نشاط درج لم يكتمل',
  pendingRefunds: 'صرف مرتجعات',
  pendingSales: 'مبيعات لم تكتمل',
  probeHeading: 'محاولات مرفوضة في الوردية المفتوحة (منذ آخر تشغيل)',
  probePayOut: 'سحب غير مقبول',
  probeVariance: 'إغلاق بفرق دون موافقة',
  probeApprover: 'موافقة مدير غير مقبولة',
} as const;

/** Every UI line of the shift screens, composed from the per-area records. */
export const SHIFT_COPY = Object.freeze({
  ...GENERAL_COPY,
  ...GATE_COPY,
  ...OPEN_COPY,
  ...OPEN_SHIFT_COPY,
  ...MOVEMENT_COPY,
  ...CLOSE_COPY,
  ...APPROVAL_COPY,
  ...ENROL_COPY,
  ...STATUS_COPY,
});

export const MOVEMENT_REASON_LABELS: Readonly<Record<ShiftMovementReasonCode, string>> =
  Object.freeze({
    bank_drop: 'إيداع بنكي',
    float_top_up: 'تزويد الفكة',
    petty_expense: 'مصروف نثري',
    other: 'أخرى',
  });

/** The user message for a typed refusal; anything outside the closed set is generic. */
export function shiftRefusalMessage(reason: ShiftCashupRefusal): string {
  return Object.hasOwn(REFUSAL_COPY, reason) ? REFUSAL_COPY[reason] : SHIFT_COPY.unknownRefusal;
}
