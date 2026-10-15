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
  preview: 'معاينة الإيصال',
  reprint: 'إعادة طباعة الإيصال',
  reprinting: 'جارٍ إعادة الطباعة…',
  reprintSent: 'أُرسل الإيصال للطابعة.',
  reprintFailed: 'تعذّرت إعادة طباعة الإيصال. حاول مرة أخرى.',
});
