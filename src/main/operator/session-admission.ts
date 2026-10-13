import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import type { AuditEvent, OperatorRefusal } from '../../shared/audit/event-shape.js';
import type { Role } from '../../shared/operator/role.js';
import type { DatabaseHandle } from '../db/client.js';
import type { BackendClient } from './backend-client.js';
import { signOutAbandonedSession } from './pairing-epoch.js';
import type { SessionManager } from './session-manager.js';

/**
 * RT-444 (RT-116 S3, §4) — the sign-in admission guard.
 *
 * Every sign-in path (manager, cashier PIN, both takeover confirms) asks this
 * guard before it creates a session, twice:
 *
 *   • `check` — read-only, before the path's network call, so a refused
 *     operator never reaches the backend;
 *   • `admit` — synchronously right before `sessionManager.create()`. It
 *     re-checks and, when admitted, ENDS the session the terminal still holds
 *     (`superseded_at_lock`), so `onEnded` and the §3.3 rules run before the
 *     new session starts (RT-116 M15: `create()` used to replace it silently).
 *
 * The rule (§4 table), with U the operator signing in on this terminal T:
 *
 *   • T holds a `started` attempt with live tender (RT-116 M7: a line in
 *     `applying | applied | reversal_pending`) that U did not start:
 *       – a cashier → refused `terminal_has_unresolved_payment`;
 *       – a manager / admin → admitted IN RECOVERY MODE only (RT-441, §5.1):
 *         the session carries `recovery_of`, and every call but recovery is
 *         refused until that payment is completed or cancelled.
 *     That covers both the locked session of another operator with live
 *     tender and a stuck attempt left by an ended session.
 *   • otherwise → admitted: held carts and a zero-funds attempt never block,
 *     and U's own unresolved payment never blocks U.
 *   • an ACTIVE session on T → refused `state_invalid`. Sign-in is reachable
 *     only while signed out or locked; a second session never silently
 *     replaces a live one.
 *
 * A refusal names neither the other operator nor any amount (FR-013): the
 * response is the bare category, the log carries the stage only, and the
 * audit payload is empty.
 */

export interface AdmissionCandidate {
  /** The operator signing in: the same id the session will carry (M2). */
  operator_id: string;
  /** RT-441: a manager / admin is admitted in recovery mode, a cashier refused. */
  role: Role;
}

export type AdmissionVerdict =
  | { kind: 'admitted'; recovery_of?: string }
  | { kind: 'refused'; refusal: OperatorRefusal };

export interface SessionAdmission {
  /** Read-only: would `candidate` be admitted now? */
  check(candidate: AdmissionCandidate): AdmissionVerdict;
  /**
   * Re-check and, when admitted, end the session the terminal holds. Call
   * synchronously right before `sessionManager.create()`.
   */
  admit(candidate: AdmissionCandidate): AdmissionVerdict;
}

export interface SessionAdmissionDeps {
  db: DatabaseHandle;
  sessionManager: Pick<SessionManager, 'getCurrent' | 'end'>;
  /** The pairing row's real terminal_id, or null when unpaired. */
  resolveTerminalId: () => string | null;
  auditEmitter: { emit(event: AuditEvent): void };
  logger?: Pick<Logger, 'info' | 'error'>;
  uuid?: () => string;
  clock?: () => Date;
}

interface UnresolvedAttempt {
  payment_attempt_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  acting_operator_id: string;
}

type Get<T> = { get(...params: unknown[]): T | undefined };

const ADMITTED: AdmissionVerdict = { kind: 'admitted' };

/** The attempt's own operator signs back in to finish it. */
const ownsAttempt = (attempt: UnresolvedAttempt, candidate: AdmissionCandidate): boolean =>
  attempt.acting_operator_id === candidate.operator_id;

/** RT-441: a manager or admin is admitted past it, in recovery mode. */
const mayRecover = (candidate: AdmissionCandidate): boolean =>
  candidate.role === 'manager' || candidate.role === 'admin';

const refused = (category: OperatorRefusal['category']): AdmissionVerdict => ({
  kind: 'refused',
  refusal: { kind: 'refused', category },
});

export function createSessionAdmission(deps: SessionAdmissionDeps): SessionAdmission {
  const { db, sessionManager, resolveTerminalId, auditEmitter, logger } = deps;
  const uuid = deps.uuid ?? randomUUID;
  const now = (): string => (deps.clock?.() ?? new Date()).toISOString();

  // M6: at most one `started` attempt per terminal.
  const unresolvedStmt = (): Get<UnresolvedAttempt> =>
    db.prepare(
      `SELECT a.payment_attempt_id, a.tenant_id, a.branch_id, a.terminal_id, a.acting_operator_id
         FROM payment_attempts a
        WHERE a.terminal_id = ? AND a.state = 'started'
          AND EXISTS (
            SELECT 1 FROM payment_tender_lines l
             WHERE l.payment_attempt_id = a.payment_attempt_id
               AND l.state IN ('applying', 'applied', 'reversal_pending')
          )
        LIMIT 1`,
    ) as Get<UnresolvedAttempt>;

  function unresolvedAttempt(): UnresolvedAttempt | undefined {
    const terminal_id = resolveTerminalId();
    return terminal_id === null ? undefined : unresolvedStmt().get(terminal_id);
  }

  function auditRefusal(attempt: UnresolvedAttempt, candidate: AdmissionCandidate): void {
    try {
      auditEmitter.emit({
        event_id: uuid(),
        tenant_id: attempt.tenant_id,
        branch_id: attempt.branch_id,
        originating_terminal_id: attempt.terminal_id,
        acting_operator_id: candidate.operator_id,
        session_id: null,
        shift_id: null,
        action_category: 'operator.signin.refused_unresolved_payment',
        created_at: now(),
        approving_supervisor_id: null,
        payload: {},
      });
    } catch (err) {
      logger?.error({ err }, 'operator.signin.refused_unresolved_payment:audit_failed');
    }
  }

  const info = (fields: Record<string, string>, msg: string): void => {
    logger?.info(fields, msg);
  };

  function evaluate(candidate: AdmissionCandidate): AdmissionVerdict {
    if (sessionManager.getCurrent()?.lock_state === 'active') {
      info({ event: 'operator.admission.refused', stage: 'session_active' }, 'refused');
      return refused('state_invalid');
    }
    const attempt = unresolvedAttempt();
    if (attempt === undefined || ownsAttempt(attempt, candidate)) return ADMITTED;
    if (mayRecover(candidate)) {
      info({ event: 'operator.admission.recovery_mode' }, 'admitted in recovery mode');
      return { kind: 'admitted', recovery_of: attempt.payment_attempt_id };
    }
    info({ event: 'operator.admission.refused', stage: 'unresolved_payment' }, 'refused');
    auditRefusal(attempt, candidate);
    return refused('terminal_has_unresolved_payment');
  }

  return {
    check: evaluate,
    admit(candidate) {
      const verdict = evaluate(candidate);
      if (verdict.kind === 'admitted' && sessionManager.getCurrent() !== null) {
        sessionManager.end('superseded_at_lock');
      }
      return verdict;
    },
  };
}

/**
 * The call sites' seam: the refusal to return, or null to go on. Without a
 * guard (tests that do not exercise admission) every candidate is admitted.
 */
export function admissionRefusal(
  admission: SessionAdmission | undefined,
  step: 'check' | 'admit',
  candidate: AdmissionCandidate,
): OperatorRefusal | null {
  const verdict = admissionVerdict(admission, step, candidate);
  return verdict.kind === 'refused' ? verdict.refusal : null;
}

/** The full verdict, for `admit` right before `create()` (RT-441 `recovery_of`). */
export function admissionVerdict(
  admission: SessionAdmission | undefined,
  step: 'check' | 'admit',
  candidate: AdmissionCandidate,
): AdmissionVerdict {
  return admission === undefined ? ADMITTED : admission[step](candidate);
}

/** `create()` input fields for an admitted verdict (recovery mode, or nothing). */
export function recoveryFieldsOf(verdict: AdmissionVerdict): { recovery_of?: string } {
  return verdict.kind === 'admitted' && verdict.recovery_of !== undefined
    ? { recovery_of: verdict.recovery_of }
    : {};
}

export interface SupersededSessionSignOutDeps {
  sessionManager: Pick<SessionManager, 'onEnded'>;
  backend: Pick<BackendClient, 'signOut'>;
  /** The held provider JWT for a backend session id (`operator-identity`). */
  jwtFor: (backendSessionId: string) => string | null;
  /** Clear both credential seams for the ended backend session. */
  clearCredentials: (backendSessionId: string) => void;
  logger?: Logger;
}

/**
 * RT-444 (RT-116 §3.3) — a manager / admin session ended locally by a
 * superseding sign-in makes the same best-effort backend sign-out as an
 * explicit sign-out, and its credentials leave main-process memory. Without
 * it the backend session would linger, and that manager's next sign-in
 * anywhere would meet a stale takeover prompt (FR-013). A cashier session has
 * no backend session: its admission is ended by the admission keeper.
 */
export function registerSupersededSessionSignOut(deps: SupersededSessionSignOutDeps): void {
  deps.sessionManager.onEnded((record, cause) => {
    if (cause !== 'superseded_at_lock' || record.backend_session_id === '') return;
    const jwt = deps.jwtFor(record.backend_session_id);
    deps.clearCredentials(record.backend_session_id);
    signOutAbandonedSession(
      deps.backend,
      { session_id: record.backend_session_id, jwt },
      deps.logger,
    );
  });
}
