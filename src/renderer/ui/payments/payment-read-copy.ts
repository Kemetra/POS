import type { PaymentAttemptRendererView, RefusalReason } from '../../../shared/payments/types.js';

/**
 * RT-340 / RT-341 — the payment lines Checkout shows after main has been read
 * back, so each says no more than main has shown (I-7, UX-07).
 */

/** A settle refused for a reason a retry may clear (main still holds the attempt open). */
export const CONFIRM_RETRY_COPY = 'تعذّر إتمام عملية الدفع. يرجى المحاولة مرة أخرى.';

/** RT-340 — the attempt ended without settling (cancelled, failed or force-failed elsewhere). */
export const CONFIRM_ENDED_COPY =
  'انتهت عملية الدفع هذه دون أن تكتمل. اختر طريقة دفع للبدء من جديد.';

/** M-P26 — this session may not settle the attempt; no retry from here can succeed. */
export const CONFIRM_NOT_ALLOWED_COPY =
  'لا يمكن إتمام هذا الدفع من هذه الجلسة. اطلب من المدير مراجعته.';

/** M-P28 — main has no session (it ended); signing in again is the way on, not a manager. */
export const CONFIRM_NO_SESSION_COPY = 'انتهت الجلسة. سجّل الدخول من جديد ثم أكمل الدفع.';

/** M-P15 — money is on the attempt but its state could not be read. */
export const TENDER_READ_FAILED_COPY =
  'تم تسجيل المبلغ، لكن تعذّر تحديث حالة الدفع. لا تكرر الدفع.';

/** RT-341 — main started the attempt but it could not be read; nothing is recorded on it yet. */
export const START_READ_FAILED_COPY =
  'بدأت عملية الدفع، لكن تعذّر تحديث حالتها. اضغط «إعادة المحاولة».';

const SESSION_REFUSALS: ReadonlySet<RefusalReason> = new Set([
  'no_session',
  'role_denied',
  'wrong_owner',
  'tenant_isolation',
]);

/**
 * A settle refused by main's session gate tells nothing about the attempt, and
 * `payments.read` passes the same gate, so a read-back cannot help: it would
 * only offer a retry that never succeeds.
 */
export function confirmNeedsReadBack(reason: RefusalReason | null): boolean {
  return reason === null || !SESSION_REFUSALS.has(reason);
}

/** Main's read shows money still owed on the attempt (applied lines below its subtotal). */
export function moneyStillDue(attempt: PaymentAttemptRendererView): boolean {
  let applied = 0;
  for (const line of attempt.tender_lines) {
    if (line.state === 'applied' && Number.isSafeInteger(line.amount_applied_minor)) {
      applied += line.amount_applied_minor;
    }
  }
  return applied < attempt.envelope_subtotal_minor;
}

/**
 * The line for a settle main refused (or whose answer was lost: `null`) while
 * the attempt is still open. `tender_underpaid` gets none when the refreshed
 * projection shows money owed: it blocks the commit and gives its own reason.
 * If the read still shows the sale covered, the commit stays offered, so the
 * refusal must not be silent; a re-read may yet reconcile the two.
 */
export function confirmRefusalCopy(reason: RefusalReason | null, stillDue: boolean): string | null {
  if (reason === 'tender_underpaid') return stillDue ? null : CONFIRM_RETRY_COPY;
  if (reason === 'no_session') return CONFIRM_NO_SESSION_COPY;
  if (reason !== null && SESSION_REFUSALS.has(reason)) return CONFIRM_NOT_ALLOWED_COPY;
  return CONFIRM_RETRY_COPY;
}
