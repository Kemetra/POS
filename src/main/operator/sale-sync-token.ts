import type { JwtHolder } from './jwt-holder.js';
import type { SessionManager } from './session-manager.js';

/**
 * Sale-sync credential read (016 envelope seam): the opaque operator ENVELOPE
 * held for the CURRENT session's backend session id, or null with no session.
 *
 * RT-117 (Z3): lock and unlock keep the same session and backend session id
 * and never touch the holder, so sale sync keeps its credential through an
 * inactivity lock and after a same-operator unlock.
 */
export function createSaleSyncTokenReader(
  sessionManager: Pick<SessionManager, 'getCurrent'>,
  envelopeHolder: Pick<JwtHolder, 'get'>,
): () => string | null {
  return () => {
    const sess = sessionManager.getCurrent();
    return sess === null ? null : envelopeHolder.get(sess.backend_session_id);
  };
}
