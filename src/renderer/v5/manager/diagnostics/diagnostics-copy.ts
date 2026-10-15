import type { ArabicPluralForms } from '../../../../shared/formatters/arabic-plural';

/**
 * RT-503 (VN-S10 S10-6) — frozen Arabic copy of the read-only diagnostics page,
 * owner-approved in G-6. Raw bridge states never reach the screen.
 */
export const SEARCH_RESULT_FORMS: ArabicPluralForms = {
  zero: 'لا توجد نتائج',
  one: 'نتيجة واحدة',
  two: 'نتيجتان',
  few: '{n} نتائج',
  many: '{n} نتيجة',
  other: '{n} نتيجة',
};

export const DIAGNOSTICS_COPY = {
  title: 'فحص الكتالوج',
  sub: 'للقراءة فقط. لا يغيّر شيئًا في الكتالوج.',
  unavailable: 'غير متاح',
  loading: '…',
  device: {
    heading: 'هذا الجهاز',
    tenant: 'المستأجر',
    branch: 'الفرع',
    terminal: 'الجهاز',
    label: 'اسم الجهاز',
    notPaired: 'الجهاز غير مقترن.',
  },
  sync: {
    heading: 'مزامنة الكتالوج',
    lastUpdated: 'آخر تحديث',
    refresh: 'تحديث الآن',
    neverSynced: 'لم يُحدَّث بعد',
    emptySynced: 'حُدِّث ولا توجد أصناف',
  },
  refresh: {
    started: 'بدأ التحديث.',
    already_running: 'التحديث جارٍ بالفعل.',
    refused: 'تعذّر بدء التحديث.',
  },
  counts: {
    heading: 'البيانات المحلية',
    products: 'الأصناف',
    barcodes: 'الباركود والأسماء البديلة',
  },
  search: {
    heading: 'بحث في الكتالوج المحلي',
    label: 'ابحث بالاسم أو الباركود',
    none: 'لا توجد نتائج',
  },
} as const;
