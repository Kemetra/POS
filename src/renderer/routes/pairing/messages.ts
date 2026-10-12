import type { PairingOutcome } from '../../../shared/pairing-types';

/**
 * 002-terminal-pairing T043 + T051 + T057 + T074 — operator-facing
 * messages for all documented pairing outcomes.
 *
 * T043/T051/T057 landed copy for US3/US4/US5 outcomes.
 * T074 (Phase Final) adds friendly, action-oriented copy for the two
 * remaining categories: `network_error` and `unknown_error`.
 *
 * RT-244 (VNext W1-D): the copy is the owner-approved Arabic of the G-1
 * references (RT-246, docs/design/vnext/18-g1-entry-screens.md §6 items 4 and
 * 8). The nine failure outcomes map to distinct strings; `success` reuses the
 * "other" copy, because the form navigates before it could ever render. The
 * two "Check again" strings below have no approved Arabic yet and stay
 * English, rendered as `lang="en"` by `RevocationRecheck`.
 *
 * Security: nothing in this module reads the `pairing_code` or any
 * device-side identity. Copy is fixed and includes no user-supplied
 * substitutions — there is no place a secret could be interpolated.
 */

/** Message for `outcome: 'invalid_code'` (HTTP 400 INVALID_CODE). */
export const INVALID_CODE_MESSAGE = 'الرمز غير صحيح. تحقق منه وحاول مرة أخرى.';

/** Message for `outcome: 'expired_code'` (HTTP 410 EXPIRED_CODE). */
export const EXPIRED_CODE_MESSAGE = 'انتهت صلاحية الرمز. أنشئ رمزًا جديدًا.';

/** Message for `outcome: 'already_paired'` (HTTP 409 ALREADY_PAIRED). */
export const ALREADY_PAIRED_MESSAGE = 'هذا الرمز مُستخدم من قبل.';

/**
 * Message for `outcome: 'branch_mismatch'` (HTTP 409 BRANCH_MISMATCH).
 * Per the 2026-05-03 clarification (Option B), recovery is admin-driven
 * — the operator's action is to escalate, not to retry the same code.
 * Copy is from `contracts/pairing-http.md` § Failure responses.
 */
export const BRANCH_MISMATCH_MESSAGE = 'الجهاز مسجّل لفرع آخر. اطلب من المشرف فكّه.';

/**
 * Message for `outcome: 'rate_limited'` (HTTP 429 RATE_LIMITED). Pairs
 * with the disabled-submit timer in `PairingForm`: the message stays
 * visible while the button is disabled; both clear when the timer
 * expires (button re-enables; the message persists until the next
 * submit). Copy MUST open with «محاولات كثيرة» so the operator-recognisable
 * family is stable across copy edits and matches the sign-in lockout copy —
 * pinned in PairingForm.test.tsx (T056).
 */
export const RATE_LIMITED_MESSAGE = 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.';

/**
 * Message for `outcome: 'network_error'` (T074).
 * Action-oriented: names the operator's recovery step (check network).
 * Matches spec edge-case copy: "no connection — check the network and try again".
 */
export const NETWORK_ERROR_MESSAGE = 'لا يوجد اتصال. تحقق من الشبكة وحاول مرة أخرى.';

/**
 * Message for `outcome: 'unknown_error'` (T074).
 * Honest fallback: does not alarm but invites retry.
 */
export const UNKNOWN_ERROR_MESSAGE = 'تعذّر الربط. حاول مرة أخرى.';

/**
 * The `success` arm's fallback, which the form never observes (it navigates
 * away first), so it reuses the approved "other" copy rather than inventing a
 * string no operator sees.
 */
export const GENERIC_FAILURE_MESSAGE = UNKNOWN_ERROR_MESSAGE;

/**
 * Message for `outcome: 'session_active'` (RT-215 review F3): pairing is
 * refused while an operator session is alive; the code was not used.
 */
export const SESSION_ACTIVE_MESSAGE = 'أنهِ البيع الحالي وسجّل الخروج قبل ربط الجهاز مرة أخرى.';

/**
 * Message for `outcome: 'terminal_already_paired'` (RT-215 rev546b S-1): the
 * terminal is already paired; pairing is only a recovery step.
 */
export const TERMINAL_ALREADY_PAIRED_MESSAGE = 'هذا الجهاز مربوط بالفعل.';

/**
 * Client-side validation copy for an empty / whitespace-only submit.
 * Surfaces visibly via `role="status"` so the operator sees a reason
 * instead of a silent no-op (T045).
 */
export const EMPTY_INPUT_MESSAGE = 'أدخل رمز الربط.';

/**
 * RT-215 10897-A — the "Check again" on a device-revoked terminal: the server
 * still refuses the device credential (401). Recovery stays a new pairing code.
 */
export const RECHECK_STILL_REVOKED_MESSAGE =
  'Still revoked — the server still refuses this terminal. Enter a new pairing code from the admin portal.';

/** RT-215 10897-A — the "Check again" got no answer (network, server error): still revoked. */
export const RECHECK_UNREACHABLE_MESSAGE = 'Couldn’t reach the server — try again.';

/**
 * Resolve a `PairingOutcome` to its operator-facing message.
 *
 * Covers all ten `PairingOutcome` values:
 *   - US3: invalid_code / expired_code / already_paired
 *   - US4: branch_mismatch
 *   - US5: rate_limited
 *   - T074: network_error / unknown_error
 *   - RT-215: session_active / terminal_already_paired
 *   - success: generic fallback (form navigates before this is rendered)
 */
/**
 * Exhaustive by type: adding a `PairingOutcome` without a message fails the
 * typecheck. `success` maps to the generic fallback — the form navigates on
 * success and the form unmounts, so it is never observed.
 */
const MESSAGE_FOR: Readonly<Record<PairingOutcome, string>> = {
  invalid_code: INVALID_CODE_MESSAGE,
  expired_code: EXPIRED_CODE_MESSAGE,
  already_paired: ALREADY_PAIRED_MESSAGE,
  branch_mismatch: BRANCH_MISMATCH_MESSAGE,
  rate_limited: RATE_LIMITED_MESSAGE,
  success: GENERIC_FAILURE_MESSAGE,
  network_error: NETWORK_ERROR_MESSAGE,
  unknown_error: UNKNOWN_ERROR_MESSAGE,
  session_active: SESSION_ACTIVE_MESSAGE,
  terminal_already_paired: TERMINAL_ALREADY_PAIRED_MESSAGE,
};

export function messageFor(outcome: PairingOutcome): string {
  return MESSAGE_FOR[outcome];
}
