/**
 * RT-503 (VN-S10 S10-6) — frozen Arabic copy of the honest manager pages,
 * owner-approved in G-6 (docs/design/vnext/visual-acceptance/G6-Manager).
 */
export const HONEST_COPY = {
  audit: {
    title: 'سجل المراجعة',
    notice: 'سجل المراجعة لا يُعرض على هذا الجهاز.',
  },
  inventory: {
    title: 'المخزون',
    notice: 'إدارة المخزون غير متاحة على هذا الجهاز.',
    diagnosticsTitle: 'فحص الكتالوج',
    diagnosticsHint: 'حالة كتالوج الأصناف على هذا الجهاز، والبحث فيه.',
  },
  settings: {
    title: 'الإعدادات',
    notice: 'لا توجد إعدادات يمكن تغييرها على هذا الجهاز.',
  },
  forceFail: {
    title: 'إنهاء دفع معلّق',
    notice: 'هذه الصفحة تُفتح من دفع معلّق فقط.',
    action: 'المبيعات المعلقة',
  },
  checkoutOff: {
    title: 'الدفع',
    notice: 'الدفع غير مفعّل على هذا الجهاز.',
    action: 'العودة إلى البيع',
  },
} as const;

export const MANAGER_PATHS = {
  diagnostics: '/app/inventory/diagnostics',
  recovery: '/app/manager/recovery',
  cart: '/app/cart',
} as const;
