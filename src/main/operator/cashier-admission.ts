import { randomUUID } from 'node:crypto';

import type { OperatorRefusal } from '../../shared/audit/event-shape.js';

import type { CashierAdmissionClient, CashierAdmissionResult } from './cashier-admission-client.js';

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
}

/** A fresh contract-valid key (16–128 printable ASCII); carries no secret. */
export function newAdmissionIdempotencyKey(): string {
  return `pos-cashier-adm-${randomUUID()}`;
}

export function nextIdempotencyKey(deps: CashierAdmissionDeps): string {
  return (deps.newIdempotencyKey ?? newAdmissionIdempotencyKey)();
}

/**
 * Apply the side effects of one admission outcome: the P1 grant seam and the
 * device-revoked handling. A throwing seam or handler never breaks the caller.
 */
export function reportAdmissionOutcome(
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
  if (result.kind === 'device_unauthorized') {
    try {
      deps.onDeviceRevoked?.();
    } catch {
      // Same: best-effort.
    }
  }
}

/** Call the admission resource for an online sign-in or takeover and report the outcome. */
export async function admitCashierOnline(
  deps: CashierAdmissionDeps,
  req: { user_id: string; operator_id: string; takeover: boolean; idempotency_key: string },
): Promise<CashierAdmissionResult> {
  const result = await deps.client.admit({
    mode: 'online',
    user_id: req.user_id,
    takeover: req.takeover,
    idempotency_key: req.idempotency_key,
  });
  reportAdmissionOutcome(deps, result, req);
  return result;
}

const REFUSE_INVALID: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };
const REFUSE_NO_CONN: OperatorRefusal = { kind: 'refused', category: 'no_connection' };
const REFUSE_RATE_LIMITED: OperatorRefusal = { kind: 'refused', category: 'rate_limited' };

/**
 * Sign-in / takeover refusal for a non-`admitted` outcome. Generic by design
 * (NFR-003 / PR-2): the operator never learns the cause of a 403 or 401.
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
