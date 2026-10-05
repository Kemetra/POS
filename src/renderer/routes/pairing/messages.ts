import type { PairingOutcome } from '../../../shared/pairing-types';

/**
 * 002-terminal-pairing T043 + T051 + T057 + T074 — operator-facing
 * messages for all documented pairing outcomes.
 *
 * T043/T051/T057 landed copy for US3/US4/US5 outcomes.
 * T074 (Phase Final) adds friendly, action-oriented copy for the two
 * remaining categories: `network_error` and `unknown_error`.
 *
 * All ten `PairingOutcome` values now map to a distinct string.
 * The `success` outcome maps to the generic fallback — the form
 * navigates before that string is ever rendered.
 *
 * Security: nothing in this module reads the `pairing_code` or any
 * device-side identity. Copy is fixed and includes no user-supplied
 * substitutions — there is no place a secret could be interpolated.
 */

/** Message for `outcome: 'invalid_code'` (HTTP 400 INVALID_CODE). */
export const INVALID_CODE_MESSAGE = 'Code not recognised — check and try again.';

/** Message for `outcome: 'expired_code'` (HTTP 410 EXPIRED_CODE). */
export const EXPIRED_CODE_MESSAGE = 'Code expired — generate a new one.';

/** Message for `outcome: 'already_paired'` (HTTP 409 ALREADY_PAIRED). */
export const ALREADY_PAIRED_MESSAGE = 'This code has already been used.';

/**
 * Message for `outcome: 'branch_mismatch'` (HTTP 409 BRANCH_MISMATCH).
 * Per the 2026-05-03 clarification (Option B), recovery is admin-driven
 * — the operator's action is to escalate, not to retry the same code.
 * Copy is from `contracts/pairing-http.md` § Failure responses.
 */
export const BRANCH_MISMATCH_MESSAGE =
  'Terminal registered to another branch — ask admin to release it.';

/**
 * Message for `outcome: 'rate_limited'` (HTTP 429 RATE_LIMITED). Pairs
 * with the disabled-submit timer in `PairingForm`: the message stays
 * visible while the button is disabled; both clear when the timer
 * expires (button re-enables; the message persists until the next
 * submit). Copy MUST contain the phrase "too many attempts" so the
 * operator-recognisable family is stable across copy edits — pinned
 * by the case-insensitive regex in PairingForm.test.tsx (T056).
 */
export const RATE_LIMITED_MESSAGE = 'Too many attempts — wait a moment and try again.';

/**
 * Generic failure copy for the `success` outcome, which the form never
 * observes (it navigates away first). Kept as the exhaustive-switch
 * fallback so `messageFor` is total over `PairingOutcome` without a
 * misleading "success" string. T074 landed per-category copy for
 * `network_error` and `unknown_error`; this string now only covers the
 * `success` arm and any future-unknown outcome categories.
 */
export const GENERIC_FAILURE_MESSAGE = 'Pairing failed — try again.';

/**
 * Message for `outcome: 'network_error'` (T074).
 * Action-oriented: names the operator's recovery step (check network).
 * Matches spec edge-case copy: "no connection — check the network and try again".
 */
export const NETWORK_ERROR_MESSAGE = 'No connection — check your network and try again.';

/**
 * Message for `outcome: 'unknown_error'` (T074).
 * Honest fallback: does not alarm but invites retry.
 */
export const UNKNOWN_ERROR_MESSAGE = 'Pairing failed — please try again.';

/**
 * Message for `outcome: 'session_active'` (RT-215 review F3): pairing is
 * refused while an operator session is alive; the code was not used.
 */
export const SESSION_ACTIVE_MESSAGE =
  'Finish the current sale and sign out before pairing this terminal again.';

/**
 * Message for `outcome: 'terminal_already_paired'` (RT-215 rev546b S-1): the
 * terminal is already paired; pairing is only a recovery step.
 */
export const TERMINAL_ALREADY_PAIRED_MESSAGE = 'This terminal is already paired.';

/**
 * Client-side validation copy for an empty / whitespace-only submit.
 * Surfaces visibly via `role="status"` so the operator sees a reason
 * instead of a silent no-op (T045).
 */
export const EMPTY_INPUT_MESSAGE = 'Enter a pairing code.';

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
 * success and the message region unmounts, so it is never observed.
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
