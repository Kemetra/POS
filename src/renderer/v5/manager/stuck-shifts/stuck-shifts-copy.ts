import type { ForcedCloseReason } from '../../../../shared/audit/payload-schemas';

/**
 * RT-502 (VN-S10 S10-5) — the stuck-shifts and forced-close copy, frozen with
 * the G-6 references (owner-approved 2026-10-15, G6-Spec.html copy table).
 * The cashier name is free text: the screen renders it in `<bdi>` after these
 * prefixes. No string names an amount (FR-024 blind close), an id or a
 * refusal category (UX-12). The re-auth copy is RT-358's, unchanged, and lives
 * in `ui/operator/messages`.
 */
export const STUCK_SHIFTS_COPY = Object.freeze({
  /** Under the screen title (the route's ScreenSection renders the <h1>). */
  subtitle: 'وردية بقيت مفتوحة لكاشير لم يُغلقها. لا تُعرض أي مبالغ.',
  listHeading: 'الورديات المفتوحة',
  loading: 'جارٍ تحميل الورديات…',
  empty: 'لا توجد ورديات عالقة.',
  unreachable: 'تعذّر تحميل الورديات العالقة. تحقق من الاتصال.',
  retry: 'إعادة المحاولة',
  /** An empty cashier name. */
  unnamed: 'كاشير بلا اسم',
  /** Followed by the duration. */
  openFor: 'مفتوحة منذ',
  lessThanMinute: 'أقل من دقيقة',
  /** The row action and the dialog's commit. */
  close: 'إغلاق الوردية',
  /** The dialog title, followed by the cashier name. */
  dialogTitle: 'إغلاق وردية',
  reasonLegend: 'السبب',
  note: 'ملاحظة (اختياري)',
  cancel: 'إلغاء',
  /** `state_invalid`: the only refusal that re-reads the list. */
  changed: 'تغيّرت حالة هذه الوردية. تم تحديث القائمة.',
  /** Any other refusal: the list is not re-read. */
  failed: 'تعذّر إغلاق هذه الوردية. حاول مرة أخرى.',
  /** The five FORCED_CLOSE_REASONS, in enum order. */
  reasons: Object.freeze({
    takeover_supersession: 'دخل موظف آخر على الجهاز',
    cashier_no_show: 'الكاشير غير موجود',
    cashier_illness: 'الكاشير مريض',
    terminal_failure: 'عطل في الجهاز',
    other: 'سبب آخر',
  } satisfies Record<ForcedCloseReason, string>),
});
