import type { OperatorRefusal, RefusalCategory } from '../../shared/audit/event-shape.js';

import type { JwtHolder } from './jwt-holder.js';
import { jwtExpiry } from './jwt-expiry.js';
import type { OperatorSessionRecord, SessionManager } from './session-manager.js';

/**
 * RT-358 (RT-247 plan §2.1, §2.4) — the shared rules for a manager request
 * that presents the held `operator-identity` JWT (the roster for first-PIN
 * provisioning, the stuck-shifts list).
 *
 *   • `stillActive(snapshot)` — the session the request started under is still
 *     the current one, unlocked and not latched. Called at entry and after
 *     every await, so a privileged action never runs behind the lock screen,
 *     on a latched session, or for an operator who signed out meanwhile.
 *   • `prepare(snapshot)` — immediately before sending: re-check the session,
 *     read the JWT, CONSUME the one-shot re-auth mark, and refuse
 *     `reauth_required` without sending when `exp` is already past. The marked
 *     request skips that pre-check: a clock ahead of Clerk must not trap the
 *     manager in a prompt loop.
 *   • `onUnauthenticated(snapshot, marked)` — a 401. Backend-Core's 401 is
 *     deliberately generic, so: unmarked → `reauth_required`; marked (a JWT
 *     exchanged within the mark TTL was refused) → the authority is gone, so
 *     end THAT session and clear its credentials (fail closed). A 401 for a
 *     session that already changed touches nothing.
 *
 * The JWT is never logged and never returned to the renderer.
 */

export interface SessionSnapshot {
  id: string;
  backend_session_id: string;
}

export function snapshotOf(session: OperatorSessionRecord): SessionSnapshot {
  return { id: session.id, backend_session_id: session.backend_session_id };
}

export interface OperatorIdentityCallDeps {
  sessionManager: Pick<SessionManager, 'getCurrent' | 'endIfCurrent'>;
  jwtHolder: Pick<JwtHolder, 'get' | 'consumeMark' | 'clear'>;
  /** Clears the sale-sync envelope of an ended session (production wires the envelope holder). */
  clearEnvelope?: (backendSessionId: string) => void;
  /** Wall clock (ms) for the `exp` check. */
  nowMs?: () => number;
  /** Monotonic clock (ms) for the re-auth mark. */
  monoNowMs?: () => number;
}

export type PreparedCall = { kind: 'send'; jwt: string; marked: boolean };

function refuse(category: RefusalCategory): OperatorRefusal {
  return { kind: 'refused', category };
}

export class OperatorIdentityCall {
  constructor(private readonly deps: OperatorIdentityCallDeps) {}

  stillActive(snapshot: SessionSnapshot): OperatorRefusal | null {
    const current = this.deps.sessionManager.getCurrent();
    if (current?.id !== snapshot.id || current.backend_session_id !== snapshot.backend_session_id) {
      return refuse('not_signed_in');
    }
    if (current.lock_state === 'locked' || current.authority_latch !== undefined) {
      return refuse('state_invalid');
    }
    return null;
  }

  prepare(snapshot: SessionSnapshot): PreparedCall | OperatorRefusal {
    const inactive = this.stillActive(snapshot);
    if (inactive !== null) return inactive;
    const id = snapshot.backend_session_id;
    const jwt = this.deps.jwtHolder.get(id) ?? '';
    if (jwt === '') return refuse('not_signed_in');
    const marked = this.deps.jwtHolder.consumeMark(id, this.monoNow());
    if (!marked && jwtExpiry(jwt, this.now()) === 'expired') return refuse('reauth_required');
    return { kind: 'send', jwt, marked };
  }

  onUnauthenticated(snapshot: SessionSnapshot, marked: boolean): OperatorRefusal {
    // A session that ended, changed, locked or latched while the request was
    // in flight gets the same answer as after any other await, and nothing
    // more: no re-auth prompt behind the lock, and no fail-closed end either
    // (a latched session ends at its own safe point; a locked one is decided
    // by its next request after unlock).
    const inactive = this.stillActive(snapshot);
    if (inactive !== null) return inactive;
    if (!marked) return refuse('reauth_required');
    const ended = this.deps.sessionManager.endIfCurrent(
      snapshot.id,
      'account_disabled_mid_session',
    );
    if (ended !== null) {
      this.deps.jwtHolder.clear(snapshot.backend_session_id);
      this.deps.clearEnvelope?.(snapshot.backend_session_id);
    }
    return refuse('not_signed_in');
  }

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private monoNow(): number {
    return this.deps.monoNowMs?.() ?? performance.now();
  }
}
