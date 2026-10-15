/**
 * RT-499 (VN-S10 S10-2) — the manager home copy, frozen with the G-6 references
 * (docs/design/vnext/visual-acceptance/G6-Manager, owner-approved 2026-10-15).
 * No string carries a figure: the home has no metrics contract, so it shows
 * links to the manager screens and nothing else.
 */
export const HOME_COPY = Object.freeze({
  title: 'لوحة المتابعة',
  shift: Object.freeze({ title: 'حالة الوردية', description: 'حالة وردية هذا الجهاز.' }),
  cashiers: Object.freeze({
    title: 'إدارة الكاشير',
    description: 'الرقم السري لكل كاشير على هذا الجهاز.',
  }),
  recovery: Object.freeze({
    title: 'المبيعات المعلقة',
    description: 'دفع معلّق، أو مبيعات محفوظة لموظفين آخرين.',
  }),
  /** D-10-2: the first entry point to the stuck-shifts screen. */
  stuckShifts: Object.freeze({
    title: 'الورديات العالقة',
    description: 'ورديات بقيت مفتوحة ويجب إغلاقها.',
  }),
  /** A cashier who opens the route directly. */
  cashierRefusal: 'لوحة المتابعة متاحة للمدير فقط.',
  backToSale: 'العودة إلى البيع',
});
