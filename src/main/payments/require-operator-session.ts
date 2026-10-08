/**
 * T130 — `requireOperatorSession` payments wrapper.
 *
 * Single entry point used by every 006 `payments.*` and `tender.*` bridge
 * handler to authenticate + authorise the caller and (optionally) bind
 * the request to a `payment_attempts` row. Delegates the role-mismatch
 * decision to 004's `role-enforcement` semantics (CLAUDE.md "trust
 * internal code, validate at boundaries").
 *
 * Returns a closed-set refusal reason from `RefusalReason` per
 * `specs/006-payments-tender/contracts/bridge-api.md` §"Bridge gating":
 *
 *   no session                                   → no_session
 *   wrong role                                   → role_denied
 *   tenant/branch/terminal mismatch              → tenant_isolation
 *   attempt's operator_session_id ≠ active       → wrong_owner
 *   attempt in terminal state                    → attempt_terminal
 *
 * Isolation is checked BEFORE ownership so an out-of-scope probe of a
 * guessed `payment_attempt_id` collapses to `tenant_isolation` regardless
 * of which operator owns the row — closes the existence side-channel that
 * `wrong_owner` would otherwise leak across tenant/branch/terminal.
 *
 * The factor-distinguishing reason lives in the bridge payload for
 * diagnostic logging only; the renderer maps each reason to a single
 * generic copy string (NFR-003 / FR-022). Constitution §VIII —
 * `operator_id` comes from Clerk-backed 004 session metadata.
 */

import type { Role } from '../../shared/operator/role.js';
import type { PaymentAttemptState, RefusalReason } from '../../shared/payments/types.js';

/**
 * Minimal projection of 004's `OperatorSession` consumed by the wrapper.
 * Constitution §VIII — `operator_id` is a Clerk user id; `operator_session_id`
 * is the locally-issued session id; the tuple (tenant_id, branch_id,
 * terminal_id) flows from the device-token scope and the active session.
 */
export interface OperatorSessionForPayments {
  readonly role: Role;
  readonly operator_id: string;
  readonly operator_session_id: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly terminal_id: string;
  /**
   * Human-readable operator name from the live 004 session record. Carried
   * here so `payment.settled` can persist it into the audit payload for
   * 008's session-independent finalize worker (T094b). Required: the live
   * session always has it (Clerk-derived at sign-in), and the downstream
   * `sales.selling_operator_display_name` column is NOT NULL.
   */
  readonly display_name: string;
  /**
   * RT-224 step 2 — the provider-neutral `users.id` of an ADMITTED cashier
   * session (RT-113 P2); absent for manager/admin sessions. Main-only: it reaches
   * only the `payment.settled` audit payload (`selling_user_id`), never the bridge.
   */
  readonly user_id?: string;
}

/**
 * Projection of a `payment_attempts` row sufficient for ownership +
 * isolation + terminal-state checks. The full row is queried main-side
 * by the bridge handler; only these fields are needed for gating.
 */
export interface PaymentAttemptForGating {
  readonly operator_session_id: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly terminal_id: string;
  readonly state: PaymentAttemptState;
}

export interface RequireOperatorSessionInput {
  readonly session: OperatorSessionForPayments | null;
  readonly allowedRoles: readonly Role[];
  /**
   * Optional — when the call carries a `payment_attempt_id`, the wrapper
   * also enforces ownership (session_id match), tenant/branch/terminal
   * isolation, and the non-terminal-state precondition.
   */
  readonly attempt?: PaymentAttemptForGating;
}

export type RequireOperatorSessionResult =
  | {
      kind: 'ok';
      session: OperatorSessionForPayments;
      attempt?: PaymentAttemptForGating;
    }
  | { kind: 'refused'; reason: RefusalReason };

export function requireOperatorSession(
  input: RequireOperatorSessionInput,
): RequireOperatorSessionResult {
  const { session, allowedRoles, attempt } = input;
  if (session === null) {
    return { kind: 'refused', reason: 'no_session' };
  }
  if (!allowedRoles.includes(session.role)) {
    return { kind: 'refused', reason: 'role_denied' };
  }
  if (attempt !== undefined) {
    if (
      attempt.tenant_id !== session.tenant_id ||
      attempt.branch_id !== session.branch_id ||
      attempt.terminal_id !== session.terminal_id
    ) {
      return { kind: 'refused', reason: 'tenant_isolation' };
    }
    if (attempt.operator_session_id !== session.operator_session_id) {
      return { kind: 'refused', reason: 'wrong_owner' };
    }
    if (attempt.state !== 'started') {
      return { kind: 'refused', reason: 'attempt_terminal' };
    }
    return { kind: 'ok', session, attempt };
  }
  return { kind: 'ok', session };
}
