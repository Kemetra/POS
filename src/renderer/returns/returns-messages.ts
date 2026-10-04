import type { ReturnState, ReturnsRefusalReason } from '../../shared/returns/types.js';

/**
 * RT-15 S3 — the return flow's Arabic copy (AC10).
 *
 * One message per refusal reason, each saying what is true and what to do,
 * with no interpolated input. A reason main adds later without copy here
 * falls back to a generic line rather than rendering nothing.
 */
const REFUSAL_COPY: Readonly<Record<ReturnsRefusalReason, string>> = Object.freeze({
  // Backend-Core answers.
  over_return: 'الكمية المطلوبة تتجاوز ما بقي قابلًا للإرجاع على الخادم. لم يُسجَّل المرتجع.',
  already_reversed: 'هذا البيع أُلغي أو عُكس على الخادم، فلا يمكن إرجاعه.',
  conflict: 'رفض الخادم المرتجع لتعارضه مع عملية أخرى على البيع نفسه.',
  return_tender_mismatch: 'لم يطابق مبلغ الاسترداد النقدي إجمالي الخادم. لم يُسجَّل المرتجع.',
  validation_error: 'رفض الخادم بيانات المرتجع لأنها غير صالحة.',
  unauthorized: 'لم يقبل الخادم صلاحية هذه الجلسة. سجّل الدخول من جديد ثم حاول.',
  returns_unavailable: 'المرتجعات غير متاحة على الخادم لهذا البيع حاليًا.',
  // Decided on the till.
  feature_disabled: 'المرتجعات غير مفعّلة على هذا الجهاز.',
  no_session: 'لا توجد جلسة تشغيل. سجّل الدخول للمتابعة.',
  role_denied: 'المرتجعات متاحة للمدير أو مسؤول النظام فقط.',
  invalid_input: 'بيانات الطلب غير صالحة. راجع رقم البيع والكميات.',
  sale_not_found: 'لا يوجد بيع بهذا الرقم على هذا الجهاز.',
  sale_not_synced: 'لم يُرسَل هذا البيع إلى الخادم بعد، فلا يمكن إرجاعه الآن.',
  card_tender_blocked: 'دُفع هذا البيع ببطاقة كليًا أو جزئيًا، والاسترداد هنا نقدي فقط.',
  sale_voided: 'هذا البيع ملغى، فلا يمكن إرجاعه.',
  nothing_returnable: 'أُرجعت كل أصناف هذا البيع من قبل.',
  line_not_returnable: 'أحد الأصناف المختارة لم يعد قابلًا للإرجاع. ابحث عن البيع من جديد.',
  quantity_out_of_range:
    'إحدى الكميات خارج المسموح الآن. ابحث عن البيع من جديد لرؤية الكميات الحالية.',
  amount_not_payable: 'لا يمكن صرف مبلغ هذه الأصناف نقدًا بدقة. اختر كميات أخرى.',
  unresolved_return_exists:
    'لهذا البيع مرتجع سابق لم تتأكد نتيجته بعد. تحقّق منه في سجل المرتجعات أولًا.',
  offline: 'تعذّر الوصول إلى الخادم. المرتجعات تحتاج اتصالًا مباشرًا.',
  tender_unknown: 'لا يثبت أن هذا البيع دُفع نقدًا بالكامل، فلا يُسترد نقدًا.',
  sale_mismatch: 'بيانات البيع على الخادم لا تطابق هذا الجهاز. لا يمكن إرجاعه من هنا.',
  session_changed: 'تغيّرت جلسة التشغيل أثناء الطلب، فلم تُعرض النتيجة.',
});

/** Non-refusal outcomes and notices; each distinct from every refusal line. */
export const OUTCOME_COPY = Object.freeze({
  confirmed: 'تم تسجيل المرتجع على الخادم.',
  replayed: 'هذا المرتجع مسجَّل من قبل على الخادم، ولم يُسجَّل مرة ثانية.',
  unconfirmed: 'النتيجة غير مؤكدة. لا تعتبر المرتجع مكتملًا حتى يتأكد.',
  stillUnconfirmed: 'ما زالت النتيجة غير مؤكدة. حاول التحقق مرة أخرى لاحقًا.',
  mayBeRecorded: 'قد يكون المرتجع سُجّل. راجع سجل المرتجعات أدناه قبل أي محاولة جديدة.',
  submitFailed: 'لم تُعرف نتيجة الطلب. راجع سجل المرتجعات أدناه قبل أي محاولة جديدة.',
  callFailed: 'تعذّر إكمال الطلب على هذا الجهاز. حاول مرة أخرى.',
  unknownReason: 'تعذّر تنفيذ الطلب.',
  bridgeMissing: 'المرتجعات غير متاحة في هذه النسخة من التطبيق.',
  historyEmpty: 'لا توجد مرتجعات مسجَّلة على هذا الجهاز.',
});

export function refusalMessage(reason: ReturnsRefusalReason): string {
  return reason in REFUSAL_COPY ? REFUSAL_COPY[reason] : OUTCOME_COPY.unknownReason;
}

const STATE_LABELS: Readonly<Record<ReturnState, string>> = Object.freeze({
  pending: 'قيد الإرسال',
  confirmed: 'مسجَّل على الخادم',
  paid_out: 'صُرف نقدًا',
  refused: 'مرفوض',
  unknown: 'غير مؤكد',
});

export function stateLabel(state: ReturnState): string {
  return STATE_LABELS[state];
}
