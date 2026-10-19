/**
 * RT-500 (VN-S10 S10-3) — the Sales lookup copy. Approved with the G-6
 * references on 2026-10-15 (G6-Spec.html, the copy table). The operator and
 * terminal names are free text: the screen renders them in `<bdi>`. No string
 * interpolates an id or a refusal reason, and none claims the receipt was
 * printed: the printer only ever receives it («أُرسل»).
 */
export const SALES_COPY = Object.freeze({
  title: 'المبيعات',
  findHeading: 'البحث عن بيع',
  saleNumber: 'رقم البيع',
  search: 'بحث',
  searching: 'جارٍ البحث…',
  notFound: 'لم يُعثر على بيع بهذا الرقم.',
  // RT-741 (owner decision 2026-10-19): another operator's sale is "not allowed".
  notAllowed: 'غير مسموح لك بعرض هذا البيع.',
  preview: 'معاينة الإيصال',
  // RT-659 — the preview dialog (G6P-Receipt-Preview, owner option A, 2026-10-17).
  // Loading and failed are the 008 preview's own words; «الإيصال» names the slip region.
  previewSlip: 'الإيصال',
  previewLoading: 'جارٍ التحضير',
  previewFailed: 'تعذّرت معاينة الإيصال',
  previewClose: 'إغلاق',
  reprint: 'إعادة طباعة الإيصال',
  reprinting: 'جارٍ إعادة الطباعة…',
  reprintSent: 'أُرسل الإيصال للطابعة.',
  // RT-249 (D1) — the cashier's quick reprint of their own last sale, on the Sale.
  reprintLast: 'إعادة طباعة آخر إيصال',
  reprintFailed: 'تعذّرت إعادة طباعة الإيصال. حاول مرة أخرى.',
  // RT-541 / RT-534 comment 12023: every local history answer is this
  // device's sales only (`coverage: 'this_device_only'`); never "the store".
  deviceOnlyHistory: 'مبيعات هذا الجهاز فقط — عرض غير مكتمل لمبيعات المتجر.',
  // RT-541 lines state for a sale finalized before lines were recorded.
  linesNotRecorded: 'لم تُسجَّل أصناف هذا البيع.',
});
