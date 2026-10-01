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

function refuse(category: RefusalCategory): OperatorRefusal {
  return { kind: 'refused', category };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export class SessionUnlockHandler {
  constructor(private readonly deps: SessionUnlockHandlerDeps) {}

  async unlock(req: UnlockSessionRequest): Promise<UnlockSessionResponse> {
    const { sessionManager } = this.deps;
    const session = sessionManager.getCurrent();
    if (session === null) return this.refused('not_signed_in', 'no_session');
    if (session.lock_state !== 'locked') return this.refused('state_invalid', 'not_locked');

    const verdict = await this.verify(session.role, session.operator_id, req);
    if (verdict !== null) return verdict;

    // The session must still be the same locked session after the await.
    const after = sessionManager.getCurrent();
    if (after?.id !== session.id || after.lock_state !== 'locked') {
      return this.refused('state_invalid', 'session_changed');
    }
    sessionManager.unlock((this.deps.now?.() ?? new Date()).toISOString());
    this.deps.logger?.info({ event: 'operator.session.unlocked' }, 'session unlocked');
    return { kind: 'unlocked' };
  }

  private async verify(
    role: string,
    operator_id: string,
    req: UnlockSessionRequest,
  ): Promise<OperatorRefusal | null> {
    const method = (req as { method?: unknown }).method;
    if (role === 'cashier') {
      if (method !== 'pin' || !isNonEmptyString((req as { pin?: unknown }).pin)) {
        return this.refused('invalid_input', 'shape');
      }
      const result = await this.deps.verifyCashierPin(operator_id, (req as { pin: string }).pin);
      return result === null ? null : this.refused(result.category, 'pin');
    }

    const r = req as { identifier?: unknown; password?: unknown };
    if (
      method !== 'online_credential' ||
      !isNonEmptyString(r.identifier) ||
      !isNonEmptyString(r.password)
    ) {
      return this.refused('invalid_input', 'shape');
    }
    const exchange = await this.deps.clerk.exchange({
      identifier: r.identifier,
      password: r.password,
    });
    if (exchange.kind === 'no_connection') return this.refused('no_connection', 'clerk');
    if (exchange.kind !== 'ok' || exchange.operator_id !== operator_id) {
      return this.refused('invalid_input', 'identity');
    }
    return null;
  }

  private refused(category: RefusalCategory, stage: string): OperatorRefusal {
    this.deps.logger?.info(
      { event: 'operator.session.unlock_refused', category, stage },
      'session unlock refused',
    );
    return refuse(category);
  }
}
