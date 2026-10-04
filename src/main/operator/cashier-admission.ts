import { randomUUID } from 'node:crypto';

import type { OperatorRefusal } from '../../shared/audit/event-shape.js';

import type {
  CashierAdmissionAdmitted,
  CashierAdmissionClient,
  CashierAdmissionResult,
} from './cashier-admission-client.js';
import type { SessionManager } from './session-manager.js';

/**
 * RT-113 P2 — shared pieces of the online cashier admission (10763 D2/D8;
 * owner decision 10844): the P1 grant seam, the outcome side effects and the
 * sign-in refusal mapping. Used by the cashier sign-in, the cashier takeover
 * and the heartbeat keeper.
 */

/** What P1 needs to write or refresh the sealed offline grant (10763 D3). */
export interface CashierAdmittedEvent {
  user_id: string;
  /** The session `operator_id` (provider subject; RT-116 seam 1). */
  operator_id: string;
  admission_id: string;
  display_name: string;
  offline_grace_seconds: number;
  server_time: string;
  /** Local receipt time (D4: expiry is computed from it, not `server_time`). */
  received_at: string;
}

/** D4: a 403 for that user, or a device 401, invalidates offline grants. */
export type CashierAdmissionInvalidation =
  | { reason: 'refused'; user_id: string }
  | { reason: 'device_unauthorized' };

/**
 * P1 SEAM — the offline grant store (RT113-P1) plugs in here. P2 ships only
 * the no-op below: no grant is written, refreshed or invalidated yet.
 */
export interface OfflineGrantSeam {
  /** Every `admitted` (sign-in, takeover, heartbeat): write or refresh the grant. */
  onCashierAdmitted(event: CashierAdmittedEvent): void;
  /** A 403 for the user or a device 401: invalidate before any further admission. */
  onCashierAdmissionInvalidated(event: CashierAdmissionInvalidation): void;
}

export const NOOP_OFFLINE_GRANT_SEAM: OfflineGrantSeam = Object.freeze({
  onCashierAdmitted: (): void => undefined,
  onCashierAdmissionInvalidated: (): void => undefined,
});

export interface CashierAdmissionDeps {
  client: CashierAdmissionClient;
  /** Defaults to {@link NOOP_OFFLINE_GRANT_SEAM}. */
  grantSeam?: OfflineGrantSeam;
  /**
   * The device-revoked handling for a device 401 (RT-138 L6 / 10763 D8):
   * production wires `LifecycleCascade.notifyTerminalRevoked()`, which ends a
   * running session `terminal_session_terminated`.
   */
  onDeviceRevoked?: () => void;
  /** Defaults to {@link newAdmissionIdempotencyKey}. */
  newIdempotencyKey?: () => string;
  /** Defaults to the wall clock. */
  now?: () => Date;
  /**
   * Codex P2 4179771036 — the monotonic clock (ms) that anchors the admission
   * deadline. Defaults to `performance.now()`; never the wall clock, which can
   * jump.
   */
  monotonicNow?: () => number;
}

/** The monotonic clock of {@link CashierAdmissionDeps.monotonicNow}. */
export function monotonicNowMs(deps: CashierAdmissionDeps): number {
  return (deps.monotonicNow ?? (() => performance.now()))();
}

/** An online admission outcome; `admitted` also says when its request was SENT. */
export type OnlineAdmissionResult =
  | Exclude<CashierAdmissionResult, { kind: 'admitted' }>
  | (CashierAdmissionAdmitted & { requested_at_ms: number });

/** A fresh contract-valid key (16–128 printable ASCII); carries no secret. */
export function newAdmissionIdempotencyKey(): string {
  return `pos-cashier-adm-${randomUUID()}`;
}

export function nextIdempotencyKey(deps: CashierAdmissionDeps): string {
  return (deps.newIdempotencyKey ?? newAdmissionIdempotencyKey)();
}

/**
 * The P1 grant seam for one outcome: `admitted` writes or refreshes the grant;
 * a 403 invalidates that user's grant; a device 401 invalidates every grant.
 * Nothing else (including `no_token`) touches the seam. Never throws.
 */
export function notifyGrantSeam(
  deps: CashierAdmissionDeps,
  result: CashierAdmissionResult,
  who: { user_id: string; operator_id: string },
): void {
  const seam = deps.grantSeam ?? NOOP_OFFLINE_GRANT_SEAM;
  try {
    if (result.kind === 'admitted') {
      seam.onCashierAdmitted({
        user_id: who.user_id,
        operator_id: who.operator_id,
        admission_id: result.admission_id,
        display_name: result.display_name,
        offline_grace_seconds: result.offline_grace_seconds,
        server_time: result.server_time,
        received_at: (deps.now ?? (() => new Date()))().toISOString(),
      });
    } else if (result.kind === 'refused') {
      seam.onCashierAdmissionInvalidated({ reason: 'refused', user_id: who.user_id });
    } else if (result.kind === 'device_unauthorized') {
      seam.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' });
    }
  } catch {
    // The grant seam must never break sign-in or the heartbeat.
  }
}

/**
 * Side effects of one sign-in or takeover admission outcome: the P1 grant
 * seam, and on a device 401 the immediate device-revoked handling. (The
 * heartbeat does NOT use this: it debounces a 401 and defers the end to the
 * safe point, review F1/F3.) Never throws.
 */
export function reportAdmissionOutcome(
  deps: CashierAdmissionDeps,
  result: CashierAdmissionResult,
  who: { user_id: string; operator_id: string },
): void {
  notifyGrantSeam(deps, result, who);
  if (result.kind !== 'device_unauthorized') return;
  try {
    deps.onDeviceRevoked?.();
  } catch {
    // Best-effort.
  }
}

/** Call the admission resource for an online sign-in or takeover and report the outcome. */
export async function admitCashierOnline(
  deps: CashierAdmissionDeps,
  req: { user_id: string; operator_id: string; takeover: boolean; idempotency_key: string },
): Promise<OnlineAdmissionResult> {
  // Stamped BEFORE the request goes out: the server's TTL runs from no
  // earlier than this, so a deadline from it is conservative under latency.
  const requested_at_ms = monotonicNowMs(deps);
  const result = await deps.client.admit({
    mode: 'online',
    user_id: req.user_id,
    takeover: req.takeover,
    idempotency_key: req.idempotency_key,
  });
  reportAdmissionOutcome(deps, result, req);
  return result.kind === 'admitted' ? { ...result, requested_at_ms } : result;
}

const REFUSE_INVALID: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };
const REFUSE_NO_CONN: OperatorRefusal = { kind: 'refused', category: 'no_connection' };
const REFUSE_RATE_LIMITED: OperatorRefusal = { kind: 'refused', category: 'rate_limited' };

/**
 * Sign-in / takeover refusal for a non-`admitted` outcome. Generic by design
 * (NFR-003 / PR-2): the operator never learns the cause of a 403 or 401. A
 * missing local device token (`no_token`) is `invalid_input`, as an unpaired
 * terminal is.
 * An unreachable or failing Backend-Core (transport, 5xx) is `no_connection`,
 * never a credential refusal.
 */
export function refusalForAdmission(
  result: Exclude<CashierAdmissionResult, { kind: 'admitted' }>,
): OperatorRefusal {
  switch (result.kind) {
    case 'no_connection':
    case 'unavailable':
      return REFUSE_NO_CONN;
    case 'rate_limited':
      return REFUSE_RATE_LIMITED;
    default:
      return REFUSE_INVALID;
  }
}

const REFUSE_STATE_INVALID: OperatorRefusal = { kind: 'refused', category: 'state_invalid' };

/**
 * Codex P2 4179701431 — the keeper arms when a cashier session is created, and
 * the sign-in and takeover handlers still await after that (the forced-close
 * dismiss read, the takeover audit). A short-TTL heartbeat can latch or end
 * the new session meanwhile. Call this after EVERY such await: it returns null
 * while `session_id` is still the current, unlatched session, else the refusal
 * to answer instead of a stale `signed_in`.
 *
 * The category follows the sign-in mapping of the outcome that lost the
 * authority: a 403 or device revocation is the generic `invalid_input` (no
 * cause shown); a takeover elsewhere, or any other change of session, is
 * `state_invalid`.
 */
export function refusalIfSessionLost(
  sessionManager: Pick<SessionManager, 'getCurrent' | 'getLastEndCause'>,
  session_id: string,
): OperatorRefusal | null {
  const current = sessionManager.getCurrent();
  const stillCurrent = current !== null && current.id === session_id;
  if (stillCurrent && current.authority_latch === undefined) return null;
  const cause = stillCurrent ? current.authority_latch : endCauseIfEnded(sessionManager, current);
  return cause === 'account_disabled_mid_session' || cause === 'terminal_session_terminated'
    ? REFUSE_INVALID
    : REFUSE_STATE_INVALID;
}

/** The last end cause, when the session ended (none current); a replaced session has none. */
function endCauseIfEnded(
  sessionManager: Pick<SessionManager, 'getLastEndCause'>,
  current: ReturnType<SessionManager['getCurrent']>,
): string | null {
  return current === null ? sessionManager.getLastEndCause() : null;
}
