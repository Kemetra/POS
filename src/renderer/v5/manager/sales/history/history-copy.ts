/**
 * RT-542 — the store-wide sales history copy (RT-534 comment 12047, data-source
 * matrix; OD-534-1..8). Never says the store view is complete; the local
 * fallback always says "this device only"; ERP state is operational only, never
 * a tax claim; an unrecorded fact says so instead of being guessed. Free-text
 * names render in `<bdi>`; no string interpolates an id or a refusal reason.
 */
import type {
  SaleHistoryErpState,
  SaleHistoryRefusalReason,
  SaleHistoryUnsyncedRow,
} from '../../../../../shared/sale-history/types';

export const HISTORY_COPY = Object.freeze({
  heading: 'سجل مبيعات المتجر',
  from: 'من',
  to: 'إلى',
  today: 'اليوم',
  yesterday: 'أمس',
  show: 'عرض',
  loading: 'جارٍ التحميل…',
  loadMore: 'المزيد',
  retry: 'إعادة المحاولة',
  receivedUpTo: (time: string): string =>
    `ما استلمه الخادم حتى ${time}. قد توجد مبيعات لم تصل بعد من أجهزة أخرى.`,
  ownSalesOnly: 'مبيعاتك أنت فقط، من كل أجهزة المتجر.',
  deviceOnly: 'مبيعات هذا الجهاز فقط — عرض غير مكتمل لمبيعات المتجر.',
  offlineNoConnection: 'لا يوجد اتصال بالشبكة الآن.',
  offlineNoCredential: 'هذا الدخول لا يتيح قراءة سجل المتجر من الخادم.',
  offlineServerUnavailable: 'الخادم لا يستجيب الآن.',
  unsyncedHeading: 'مبيعات على هذا الجهاز لم تصل إلى الخادم بعد',
  unsyncedTruncated: 'وتوجد مبيعات أخرى لم تُرسل بعد.',
  empty: 'لا توجد مبيعات في هذه الفترة.',
  // RT-553 — the store zone differs from this terminal's fixed zone; selling goes on.
  zoneMismatchTitle: 'منطقة التوقيت للمتجر تختلف عن منطقة هذا الجهاز.',
  zoneStore: 'منطقة المتجر في الخادم:',
  zoneTerminal: 'منطقة هذا الجهاز:',
  zoneUnreadable: 'غير مقروءة',
  zoneMismatchBody:
    'قد تختلف أيام البيع وأرقام الإيصالات على هذا الجهاز عن أيام الخادم. يمكنك متابعة البيع كالمعتاد، وأبلغ الدعم الفني لتصحيح الإعداد.',
  columns: {
    number: 'رقم البيع',
    time: 'الوقت',
    operator: 'الكاشير',
    device: 'الجهاز',
    total: 'الإجمالي',
    status: 'الحالة',
  },
  notRecorded: 'غير مسجل',
  currentName: '(الاسم الحالي)',
  voided: 'ملغي',
  returnedPartial: 'مرتجع جزئيًا',
  returnedFull: 'مرتجع بالكامل',
  open: 'التفاصيل',
  close: 'إغلاق',
  detailHeading: 'تفاصيل البيع',
  lines: 'الأصناف',
  lineOrderNotRecorded: 'ترتيب الأصناف الأصلي غير مسجل لهذا البيع.',
  tenders: 'الدفع',
  tenderUnknown: 'طريقة الدفع غير مسجلة لهذا البيع.',
  cash: 'نقدي',
  card: 'بطاقة',
  change: 'الباقي',
  headerNotRecorded: 'بيانات رأس الإيصال غير مسجلة لهذا البيع.',
  returns: 'المرتجعات',
  voidedAt: 'أُلغي في',
  erpHeading: 'الترحيل إلى نظام الحسابات',
  erpNote: 'حالة تشغيلية فقط، وليست إثباتًا ضريبيًا.',
  reprintDuplicate: 'طباعة نسخة طبق الأصل',
  reprintRecord: 'طباعة سجل البيع',
  recordNote: 'سجل البيع ليس نسخة من الإيصال.',
  duplicateIncomplete: 'لا تتوفر نسخة طبق الأصل: بيانات الإيصال الأصلي غير مكتملة.',
  duplicateVoided: 'البيع ملغي: يُطبع له سجل بيع عليه علامة «ملغي» فقط.',
  printing: 'جارٍ الإرسال للطابعة…',
  sent: (copy: number): string => `أُرسلت النسخة رقم ${String(copy)} للطابعة.`,
});

const ERP_COPY: Readonly<Record<SaleHistoryErpState, string>> = {
  posted: 'مُرحّل',
  pending: 'بانتظار الترحيل',
  failed: 'تعذّر الترحيل',
  unknown: 'غير معروفة',
};

export function erpCopy(state: SaleHistoryErpState): string {
  return ERP_COPY[state];
}

const SYNC_COPY: Readonly<Record<SaleHistoryUnsyncedRow['sync'], string>> = {
  not_started: 'لم يُرسل بعد',
  pending: 'قيد الإرسال',
  dead_letter: 'رفضه الخادم',
};

export function syncCopy(sync: SaleHistoryUnsyncedRow['sync']): string {
  return SYNC_COPY[sync];
}

const REFUSAL_COPY: Partial<Record<SaleHistoryRefusalReason, string>> = {
  role_denied: 'ليست لديك صلاحية عرض هذا السجل.',
  server_refused: 'رفض الخادم هذا الطلب لهذا الدخول.',
  range_too_wide: 'الفترة أطول من 31 يومًا. اختر فترة أقصر.',
  invalid_request: 'تاريخ غير صحيح.',
  continuation_failed: 'تعذّر تحميل المزيد. الصفوف المعروضة صحيحة.',
  cursor_rejected: 'انتهى هذا التصفح. اعرض الفترة من جديد.',
  sale_not_found: 'لم يُعثر على هذا البيع.',
  session_changed: 'تغيّر الدخول أثناء الطلب. حاول مرة أخرى.',
  duplicate_unavailable: 'لا يمكن طباعة نسخة طبق الأصل لهذا البيع.',
  not_yet_printed: 'لم يُطبع الإيصال الأصلي لهذا البيع على هذا الجهاز.',
  printer_unavailable: 'تعذّرت الطباعة. تحقق من الطابعة وحاول مرة أخرى.',
  busy: 'طباعة هذا البيع جارية بالفعل.',
};

/** Generic copy for a refusal (no factor-distinguishing detail). */
export function refusalCopy(reason: SaleHistoryRefusalReason): string {
  return REFUSAL_COPY[reason] ?? 'تعذّر إتمام الطلب. حاول مرة أخرى.';
}
