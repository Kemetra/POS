import type { ManagerApprovalRefusalReason } from '../../../shared/operator/manager-approval';
import type { RecoveryRefusalReason } from '../../../shared/operator/recovery';

/**
 * RT-441 (RT-116 §5) — manager recovery copy. Arabic, one message per outcome;
 * never an amount in a refusal, never another operator's identifier.
 */
export const RECOVERY_COPY = Object.freeze({
  title: 'المبيعات المعلقة',
  link: 'المبيعات المعلقة',
  recoveryMode: 'دخلت لإنهاء دفع معلّق على هذه الطرفية. لا يمكن البيع حتى يُكمَل الدفع أو يُلغى.',
  loading: 'جارٍ التحميل…',
  stuckTitle: 'دفع معلّق',
  noneStuck: 'لا يوجد دفع معلّق على هذه الطرفية.',
  heldTitle: 'مبيعات محفوظة لموظفين آخرين',
  noneHeld: 'لا توجد مبيعات محفوظة لموظفين آخرين.',
  owner: 'الموظف',
  someoneElse: 'موظف آخر',
  lines: 'عدد الأصناف',
  total: 'الإجمالي',
  cash: 'نقدي مدفوع',
  card: 'بطاقة مدفوعة',
  voucher: 'قسيمة مستخدمة',
  remaining: 'المتبقي',
  draft: 'مسودة',
  handedOff: 'في الدفع',
  parked: 'مؤجلة',
  complete: 'إكمال البيع',
  cancelPayment: 'إلغاء الدفع',
  cancelSale: 'إلغاء البيع',
  cashReceived: 'النقدية المستلمة للمتبقي',
  confirmCash: 'أرجعتُ النقدية المدفوعة للعميل',
  confirmCard: 'ألغيتُ دفع البطاقة على جهاز البطاقة',
  approvalTitle: 'تأكيد المدير',
  approvalBody: 'أدخل رقمك السري لتأكيد هذا الإجراء.',
  pinLabel: 'الرقم السري',
  approve: 'تأكيد',
  back: 'رجوع',
  noPin: 'لا يوجد لك رقم سري مدير مفعّل على هذه الطرفية. سجّله من شاشة الوردية، ثم عُد.',
  completed: 'اكتمل البيع.',
  change: 'الباقي للعميل',
  cancelledPayment: 'أُلغي الدفع وسُجّل الإرجاع.',
  cancelledSale: 'أُلغي البيع المحفوظ.',
  unavailable: 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.',
});

const REFUSALS: Readonly<Record<RecoveryRefusalReason | ManagerApprovalRefusalReason, string>> = {
  no_session: 'سجّل الدخول للمتابعة.',
  session_locked: 'الجهاز مقفل.',
  role_mismatch: 'هذه الشاشة للمدير فقط.',
  invalid_input: 'البيانات غير صحيحة.',
  not_found: 'لم يعد هذا البيع معلّقًا. حدّث القائمة.',
  approval_invalid: 'انتهى التأكيد أو لا يخص هذا الإجراء. أكّد مرة أخرى.',
  approval_stale: 'تغيّر البيع منذ التأكيد. حدّث القائمة وأكّد مرة أخرى.',
  approval_unavailable: 'الرقم السري غير صحيح أو غير مفعّل.',
  not_applicable: 'لا يحتاج هذا الإجراء إلى تأكيد.',
  confirmation_required: 'أكّد إرجاع المبلغ أولًا.',
  cash_insufficient: 'النقدية أقل من المتبقي.',
  payment_refused: 'رفض نظام الدفع الإجراء. أكّد مرة أخرى.',
  recovery_unavailable: 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.',
};

export function recoveryRefusalMessage(reason: string): string {
  return (REFUSALS as Record<string, string | undefined>)[reason] ?? RECOVERY_COPY.unavailable;
}
