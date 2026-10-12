/**
 * RT-244 (VNext W1-D) — the sign-in screen's Arabic copy, as approved by the
 * owner with the G-1 references on 2026-10-11 (RT-246; the copy table in
 * docs/design/vnext/visual-acceptance/G1-Entry-screens/G1-Spec.html).
 *
 * Role nouns follow UX-12: «الكاشير» / «المدير». No string interpolates user
 * input. The refusal copy itself stays in ui/operator/messages.ts (P11: one
 * generic message per category).
 */
export const SIGN_IN_COPY = Object.freeze({
  title: 'تسجيل الدخول',
  subtitle: 'كل عمليات الوردية تُسجَّل باسمك.',
  rosterHeading: 'الكاشير في هذا الفرع',
  pinHeading: 'الرقم السري',
  cashierRole: 'الكاشير',
  managerEntry: 'دخول المدير',
  managerHeading: 'دخول المدير',
  back: 'رجوع',
  submit: 'دخول',
  signingIn: 'جارٍ تسجيل الدخول…',
  pinPrompt: 'اختر اسمك من القائمة لإدخال الرقم السري.',
  /** The roster could not be fetched because the terminal is offline (`no_connection`). */
  rosterOffline: 'تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.',
  /** Any other roster refusal: no connection hint. */
  rosterRefused: 'تعذّر تحميل قائمة الكاشير.',
  /** Shown in the PIN column while there is no roster to pick from. */
  pinPromptNoRoster: 'لا يمكن إدخال الرقم السري قبل تحميل القائمة.',
  /** The roster loaded and holds no cashier: a fact, not a fault. */
  rosterEmpty: 'لا يوجد كاشير مسجّل في هذا الفرع.',
  pinPromptEmptyRoster: 'الدخول بالرقم السري يحتاج كاشيرًا مسجّلًا في هذا الفرع.',
  terminal: 'الجهاز',
});

/**
 * RT-244 PR2 — the Ready card (M-F1) and the pairing card (G-1 §6 item 4), as
 * approved with the G-1 references. The pairing outcome copy lives in
 * routes/pairing/messages.ts.
 */
export const READY_COPY = Object.freeze({
  title: 'الجهاز مرتبط وجاهز.',
  terminal: 'الجهاز',
  continue: 'متابعة',
});

export const PAIRING_COPY = Object.freeze({
  title: 'ربط الجهاز',
  hint: 'أدخل رمز الربط الظاهر في لوحة الإدارة.',
  field: 'رمز الربط',
  submit: 'ربط الجهاز',
  submitting: 'جارٍ الربط…',
});

/**
 * The roster tile's badge: the first letter of the name. Two letters
 * (`slice(0, 2)`) break Arabic letter joining.
 */
export function nameInitial(displayName: string): string {
  const trimmed = displayName.trim();
  return Array.from(trimmed)[0] ?? '';
}
