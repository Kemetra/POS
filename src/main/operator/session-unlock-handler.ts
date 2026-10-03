import type { Logger } from 'pino';

import type { UnlockSessionRequest, UnlockSessionResponse } from '../../shared/bridge-api.js';
import type { OperatorRefusal, RefusalCategory } from '../../shared/audit/event-shape.js';

import type { ClerkExchanger } from './clerk-client.js';
import type { SessionManager } from './session-manager.js';

/**
 * RT-117 (RT-116 §2.4) — same-operator unlock of the CURRENT locked session.
 *
 *   • cashier       → `{ method: 'pin' }`, checked by the existing 004 local PIN
 *                     verifier (lockout rules unchanged). Works offline.
 *   • manager/admin → `{ method: 'online_credential' }` — interim online re-auth
 *                     (owner decision Z3). The exchanged identity must equal the
 *                     locked session's operator. Replaced by the RT-114 credential.
 *
 * Unlock never creates a session, never calls the backend sign-in, and never
 * fires the session lifecycle hooks: `SessionManager.unlock` flips the state of
 * the SAME session. The backend session id — and with it the sale-sync
 * envelope keyed on it — is untouched.
 *
 * Brute-force protection (§A4 M1 / M2):
 *   • single-flight — one verification at a time; a concurrent call is refused
 *     `rate_limited`, so parallel PIN attempts cannot race the 004 lockout
 *     counter (read → Argon2 → write);
 *   • the online-credential path has a main-side limiter mirroring the 004 PIN
 *     lockout (5 failures → 5 min). A network failure never counts.
 *
 * Refusals are generic (NFR-003). Credentials are never logged (P11).
 */

export interface SessionUnlockHandlerDeps {
  sessionManager: SessionManager;
  /** 004 local PIN check for this terminal's cashier; null on a match. */
  verifyCashierPin: (operator_id: string, pin: string) => Promise<OperatorRefusal | null>;
  clerk: ClerkExchanger;
  now?: () => Date;
  logger?: Logger;
}

/** Same thresholds as the 004 PIN lockout (`pin-lockout.ts`). */
const MAX_ONLINE_FAILURES = 5;
const ONLINE_LOCKOUT_MS = 5 * 60_000;

interface OnlineFailures {
  operator_id: string;
  count: number;
  locked_until_ms: number | null;
}

function refuse(category: RefusalCategory): OperatorRefusal {
  return { kind: 'refused', category };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export class SessionUnlockHandler {
  private inFlight = false;
  private onlineFailures: OnlineFailures | null = null;

  constructor(private readonly deps: SessionUnlockHandlerDeps) {}

  async unlock(req: UnlockSessionRequest): Promise<UnlockSessionResponse> {
    if (this.inFlight) return this.refused('rate_limited', 'concurrent');
    this.inFlight = true;
    try {
      return await this.unlockOnce(req);
    } finally {
      this.inFlight = false;
    }
  }

  private async unlockOnce(req: UnlockSessionRequest): Promise<UnlockSessionResponse> {
    const { sessionManager } = this.deps;
    const session = sessionManager.getCurrent();
    if (session === null) return this.refused('not_signed_in', 'no_session');
    if (session.lock_state !== 'locked') return this.refused('state_invalid', 'not_locked');

    const verdict =
      session.role === 'cashier'
        ? await this.verifyCashier(session.operator_id, req)
        : await this.verifyOnline(session.operator_id, req);
    if (verdict !== null) return verdict;

    // The session must still be the same locked session after the await.
    const after = sessionManager.getCurrent();
    if (after?.id !== session.id || after.lock_state !== 'locked') {
      return this.refused('state_invalid', 'session_changed');
    }
    sessionManager.unlock(this.now().toISOString());
    this.deps.logger?.info({ event: 'operator.session.unlocked' }, 'session unlocked');
    return { kind: 'unlocked' };
  }

  private async verifyCashier(
    operator_id: string,
    req: UnlockSessionRequest,
  ): Promise<OperatorRefusal | null> {
    if (req.method !== 'pin' || !isNonEmptyString(req.pin)) {
      return this.refused('invalid_input', 'shape');
    }
    const result = await this.deps.verifyCashierPin(operator_id, req.pin);
    return result === null ? null : this.refused(result.category, 'pin');
  }

  private async verifyOnline(
    operator_id: string,
    req: UnlockSessionRequest,
  ): Promise<OperatorRefusal | null> {
    if (req.method !== 'online_credential' || !hasOnlineCredential(req)) {
      return this.refused('invalid_input', 'shape');
    }
    if (this.isOnlineLockedOut(operator_id)) return this.refused('rate_limited', 'online_lockout');

    const exchange = await this.deps.clerk.exchange({
      identifier: req.identifier,
      password: req.password,
    });
    if (exchange.kind === 'no_connection') return this.refused('no_connection', 'clerk');
    if (exchange.kind !== 'ok' || exchange.operator_id !== operator_id) {
      this.recordOnlineFailure(operator_id);
      return this.refused('invalid_input', 'identity');
    }
    this.onlineFailures = null;
    return null;
  }

  /** True while the operator's online backoff is active; an expired one resets. */
  private isOnlineLockedOut(operator_id: string): boolean {
    const f = this.onlineFailures;
    if (f?.operator_id !== operator_id || f.locked_until_ms === null) return false;
    if (this.now().getTime() < f.locked_until_ms) return true;
    this.onlineFailures = null;
    return false;
  }

  private recordOnlineFailure(operator_id: string): void {
    const prior = this.onlineFailures?.operator_id === operator_id ? this.onlineFailures.count : 0;
    const count = prior + 1;
    this.onlineFailures = {
      operator_id,
      count,
      locked_until_ms:
        count >= MAX_ONLINE_FAILURES ? this.now().getTime() + ONLINE_LOCKOUT_MS : null,
    };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private refused(category: RefusalCategory, stage: string): OperatorRefusal {
    this.deps.logger?.info(
      { event: 'operator.session.unlock_refused', category, stage },
      'session unlock refused',
    );
    return refuse(category);
  }
}

function hasOnlineCredential(req: UnlockSessionRequest & { method: 'online_credential' }): boolean {
  return isNonEmptyString(req.identifier) && isNonEmptyString(req.password);
}
