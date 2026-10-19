import type { JwtHolder } from './jwt-holder.js';
import type { SessionManager } from './session-manager.js';

/**
 * RT-554 (b) — the credential of a manager's FORCED close: the opaque operator
 * ENVELOPE (016 seam) of the CURRENT session, but only when that session is a
 * manager or admin. The contract accepts a forced close on the manager-envelope
 * path only, so a cashier session's envelope is never offered for it (the row
 * stays queued until a manager signs in). Like sale sync, it survives an
 * inactivity lock: the lock keeps the session and its backend session id.
 *
 * Read in-process per send; never bridged, never logged.
 */
export function createManagerEnvelopeReader(
  sessionManager: Pick<SessionManager, 'getCurrent'>,
  envelopeHolder: Pick<JwtHolder, 'get'>,
): () => string | null {
  return () => {
    const session = sessionManager.getCurrent();
    if (session === null) return null;
    if (session.role !== 'manager' && session.role !== 'admin') return null;
    return envelopeHolder.get(session.backend_session_id);
  };
}
