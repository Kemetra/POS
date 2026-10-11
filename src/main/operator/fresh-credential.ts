import type { RefusalCategory } from '../../shared/audit/event-shape.js';

import type { JwtHolder } from './jwt-holder.js';
import type { OperatorSessionRecord, SessionManager } from './session-manager.js';

/**
 * RT-358 (RT-247 plan §2.3, Q2) — storing a JWT freshly exchanged by a re-auth
 * or a manager online unlock. Both await the credential exchange, so the
 * session is checked again AFTER it, and the JWT (with its one-shot mark) is
 * stored only when every check passes:
 *   • the same session (id, backend session id, operator) is still current —
 *     a late success must never repopulate credentials for an ended session;
 *   • it is not latched, and the device is not revoked (a confirmed revocation
 *     can keep the same session latched until its safe point);
 *   • the lock state is the one the operation expects: re-auth expects the
 *     session still UNLOCKED, an online unlock expects it still LOCKED.
 *
 * Storing the JWT adds no local authority: it only changes which credential
 * the next `operator-identity` request presents, which the backend checks.
 * `manager_signed_in_at` is never touched (owner decision Q1 = no).
 */

export interface CredentialSnapshot {
  id: string;
  backend_session_id: string;
  operator_id: string;
}

export type ExpectedLock = 'locked' | 'unlocked';

export function credentialSnapshotOf(session: OperatorSessionRecord): CredentialSnapshot {
  return {
    id: session.id,
    backend_session_id: session.backend_session_id,
    operator_id: session.operator_id,
  };
}

function revoked(isDeviceRevoked: () => boolean): boolean {
  try {
    return isDeviceRevoked();
  } catch {
    return true; // fail closed
  }
}

/** The current session is the snapshot's: same id, backend session and operator. */
function isSnapshotSession(
  current: OperatorSessionRecord | null,
  snapshot: CredentialSnapshot,
): current is OperatorSessionRecord {
  return (
    current?.id === snapshot.id &&
    current.backend_session_id === snapshot.backend_session_id &&
    current.operator_id === snapshot.operator_id
  );
}

/** Null when the snapshot session may receive the fresh credential. */
export function freshCredentialBlocker(
  sessionManager: Pick<SessionManager, 'getCurrent'>,
  snapshot: CredentialSnapshot,
  expected: ExpectedLock,
  isDeviceRevoked: () => boolean,
): RefusalCategory | null {
  const current = sessionManager.getCurrent();
  if (!isSnapshotSession(current, snapshot)) return 'not_signed_in';
  if (current.authority_latch !== undefined || revoked(isDeviceRevoked)) return 'not_signed_in';
  const locked = current.lock_state === 'locked';
  if (locked !== (expected === 'locked')) return 'state_invalid';
  return null;
}

/** Store the fresh JWT with the one-shot "just re-authenticated" mark. */
export function storeFreshCredential(
  jwtHolder: Pick<JwtHolder, 'set'>,
  snapshot: CredentialSnapshot,
  jwt: string,
  monoNowMs: number,
): void {
  jwtHolder.set(snapshot.backend_session_id, jwt, { reauthenticatedAtMs: monoNowMs });
}
