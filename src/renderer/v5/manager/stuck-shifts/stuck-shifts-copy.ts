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
  /** `state_invalid`: the list is read again (with `not_closable_here`, the only refusals that do). */
  changed: 'تغيّرت حالة هذه الوردية. تم تحديث القائمة.',
  /**
   * `not_closable_here` (RT-554): this terminal does not hold the shift (it was
   * opened on another device; Backend-Core resolves a shift only for the device
   * that opened it), or the cash-up is off here. The shift is closed by cash-up
   * on the device that opened it. The list is re-read (a shift closed meanwhile on
   * its opening terminal then leaves it). Owner-approved copy, 2026-10-19 (RT-554).
   */
  notClosableHere:
    'لا يمكن الإغلاق الإجباري لهذه الوردية من هنا. تُغلق بجرد الدرج على الجهاز الذي فتحها.',
  /**
   * RT-554 (b), the manager's blind count: an input only. The hint names no
   * amount and promises nothing about what is (not) shown.
   */
  countHint: 'عُدّ النقد في الدرج وأدخل ما عددته.',
  /** `close_blocked`: parked sales or drawer cash in flight on this terminal. */
  closeBlocked:
    'لا يمكن إغلاق الوردية الآن: توجد مبيعات معلّقة أو حركة نقدية جارية على هذا الجهاز. أنهِها ثم أعد المحاولة.',
  /**
   * `delivery: queued` and `closed_here_unsent`: closed on this terminal, not at
   * the server yet. It promises nothing about when (a stuck earlier fact can hold it).
   */
  queuedNotice: 'أُغلقت الوردية على هذا الجهاز ولم تصل إلى الخادم بعد.',
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
