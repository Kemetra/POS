import type { SaleVoidRefusalReason, SaleVoidState } from '../../../shared/sale-void/types';
import type { ManagerApprovalRefusalReason } from '../../../shared/operator/manager-approval';

/**
 * RT-530 — sale void copy. Arabic, one message per outcome. Never an approver
 * identity, never a credential; the only person named is the operator who
 * requested a void (the one whose sign-in sends it).
 */
export const VOID_COPY = Object.freeze({
  title: 'إلغاء بيع',
  link: 'إلغاء بيع',
  loading: 'جارٍ التحميل…',
  lookupHeading: 'البحث عن بيع',
  numberLabel: 'رقم البيع',
  search: 'بحث',
  saleHeading: 'البيع',
  saleNumber: 'رقم البيع',
  soldAt: 'وقت البيع',
  seller: 'البائع',
  total: 'إجمالي البيع',
  cash: 'نقدي في الدرج',
  voidAction: 'إلغاء هذا البيع',
  sameDayHint: 'يمكن إلغاء البيع في يوم بيعه فقط، وبتأكيد مدير آخر غيرك وغير بائع الفاتورة.',
  dialogTitle: 'تأكيد إلغاء البيع',
  dialogBody:
    'يلزم مدير آخر، ليس أنت وليس بائع الفاتورة، ليؤكد الإلغاء برقمه السري. يخرج نقد هذا البيع من الدرج.',
  managerLegend: 'المدير المؤكِّد',
  pinLabel: 'الرقم السري للمدير',
  approve: 'تأكيد الإلغاء',
  back: 'رجوع',
  noManagers: 'لا يوجد مدير مفعّل لتأكيد الإلغاء على هذه الطرفية.',
  requested: 'سُجّل طلب الإلغاء. يُرسل تلقائيًا عند اتصال مُقدِّمه بالإنترنت.',
  historyTitle: 'طلبات الإلغاء',
  noHistory: 'لا توجد طلبات إلغاء.',
  requestedAt: 'وقت الطلب',
  acknowledge: 'تم الاطلاع',
  attentionBanner: 'رفض الخادم طلب إلغاء بيع. افتح «إلغاء بيع» لمعرفة السبب.',
  attentionAction: 'عرض',
  unavailable: 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.',
});

const REFUSALS: Readonly<Record<SaleVoidRefusalReason | ManagerApprovalRefusalReason, string>> = {
  // Local refusals (nothing journaled).
  feature_disabled: 'إلغاء البيع غير مفعّل على هذه الطرفية.',
  no_session: 'سجّل الدخول للمتابعة.',
  session_locked: 'الجهاز مقفل.',
  invalid_input: 'البيانات غير صحيحة.',
  sale_not_found: 'لا يوجد بيع بهذا الرقم على هذه الطرفية.',
  // RT-741: a cashier asked for another operator's sale.
  role_denied: 'غير مسموح لك بعرض هذا البيع.',
  not_same_day: 'انتهى يوم هذا البيع، فلا يمكن إلغاؤه. استخدم المرتجعات.',
  already_voided: 'لهذا البيع طلب إلغاء بالفعل.',
  has_return: 'لهذا البيع مرتجع، فلا يمكن إلغاؤه.',
  no_operator_envelope: 'هذه الجلسة غير متصلة، فلا يمكن إرسال الإلغاء منها. سجّل الدخول متصلًا.',
  approval_invalid: 'انتهى التأكيد أو لا يخص هذا البيع. أكّد مرة أخرى.',
  approval_stale: 'تغيّر البيع منذ التأكيد. أعد البحث وأكّد مرة أخرى.',
  void_unavailable: 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.',
  // The approval itself: never says which part failed (RT-114 C3), but names
  // the four-eyes rule so the cashier knows another manager is needed.
  approval_unavailable:
    'تعذّر التأكيد: الرقم السري غير صحيح أو غير مفعّل، أو أن المؤكِّد هو طالب الإلغاء أو بائع الفاتورة. يجب أن يؤكد مدير آخر.',
  not_applicable: 'لا يحتاج هذا الإجراء إلى تأكيد.',
  // Backend-Core refusals (terminal, shown on the queued void).
  void_outside_business_day:
    'انتهى يوم البيع قبل إرسال الإلغاء، فرفضه الخادم. استخدم المرتجعات بدلًا منه.',
  void_approval_required: 'رفض الخادم الإلغاء: لا يوجد تأكيد مدير.',
  void_approval_invalid: 'رفض الخادم الإلغاء: التأكيد لا يطابق هذا البيع أو مبلغه.',
  void_requester_mismatch: 'رفض الخادم الإلغاء: طالب الإلغاء ليس المستخدم المسجّل لإرساله.',
  void_requester_not_eligible: 'رفض الخادم الإلغاء: طالب الإلغاء ليس من موظفي هذا الفرع.',
  void_self_approval:
    'رفض الخادم الإلغاء: المؤكِّد هو طالب الإلغاء أو بائع الفاتورة. يلزم مدير آخر.',
  void_approver_not_eligible: 'رفض الخادم الإلغاء: المؤكِّد ليس مديرًا مؤهلًا لهذا الفرع.',
  already_reversed: 'رفض الخادم الإلغاء: البيع ملغى أو له مرتجع بالفعل.',
  conflict: 'رفض الخادم الإلغاء: تعارض مع طلب سابق.',
  validation_error: 'رفض الخادم الإلغاء: بيانات غير صالحة.',
};

export function voidRefusalMessage(reason: string): string {
  return (REFUSALS as Record<string, string | undefined>)[reason] ?? VOID_COPY.unavailable;
}

const STATE_LABELS: Readonly<Record<SaleVoidState, string>> = {
  pending: 'طلب الإلغاء بانتظار الإرسال',
  unknown: 'تعذّر تأكيد الإرسال، وستُعاد المحاولة تلقائيًا',
  confirmed: 'تم الإلغاء',
  refused: 'رُفض الإلغاء',
};

export function voidStateLabel(state: SaleVoidState): string {
  return STATE_LABELS[state];
}

/** What a queued void is waiting for, in words; the requester is named, nobody else. */
export function voidWaitingMessage(
  waitingFor: 'sale_sync' | 'requester_sign_in',
  requesterName: string,
): string {
  return waitingFor === 'sale_sync'
    ? 'بانتظار مزامنة البيع مع الخادم'
    : `بانتظار تسجيل دخول ${requesterName} متصلًا لإرسال الإلغاء`;
}
