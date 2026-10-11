import type { Logger } from 'pino';

import type { UnlockSessionRequest, UnlockSessionResponse } from '../../shared/bridge-api.js';
import type { OperatorRefusal, RefusalCategory } from '../../shared/audit/event-shape.js';

import type { ClerkExchanger } from './clerk-client.js';
import {
  credentialSnapshotOf,
  freshCredentialBlocker,
  storeFreshCredential,
} from './fresh-credential.js';
import type { JwtHolder } from './jwt-holder.js';
import { OnlineCredentialVerifier } from './online-credential-verifier.js';
import type { OperatorSessionRecord, SessionManager } from './session-manager.js';

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
 *   • the online-credential path goes through the `OnlineCredentialVerifier`
 *     (RT-358), shared with `operator:reauthenticate`: one limiter mirroring
 *     the 004 PIN lockout (5 failures → 5 min, a network failure never counts)
 *     and one in-flight gate for every online attempt.
 *
 * RT-358 (RT-247 Q2 = yes) — the online unlock already exchanges a fresh JWT;
 * it now stores it (with the one-shot re-auth mark) instead of discarding it,
 * so a manager who just unlocked is not asked for the password again minutes
 * later. It is stored only when the post-exchange check passes for a session
 * still LOCKED (same session, not latched, device not revoked); otherwise the
 * unlock refuses and stores nothing. No local authority is refreshed.
 *
 * Refusals are generic (NFR-003). Credentials are never logged (P11).
 */

export interface SessionUnlockHandlerDeps {
  sessionManager: SessionManager;
  /** 004 local PIN check for this terminal's cashier; null on a match. */
  verifyCashierPin: (operator_id: string, pin: string) => Promise<OperatorRefusal | null>;
  clerk: ClerkExchanger;
  /** RT-358 — the online check shared with re-auth. Built from `clerk` when omitted. */
  onlineVerifier?: OnlineCredentialVerifier;
  /** RT-358 Q2 — where the unlock's fresh JWT is stored. Omitted → not stored. */
  jwtHolder?: Pick<JwtHolder, 'set'>;
  /** RT-358 Q2 — a revoked device never receives a fresh credential. */
  isDeviceRevoked?: () => boolean;
  /** RT-358 — monotonic clock (ms) for the re-auth mark. Tests inject. */
  monoNowMs?: () => number;
  now?: () => Date;
  logger?: Logger;
}

interface LockedSession {
  kind: 'locked';
  session: OperatorSessionRecord;
}

/** A verified credential; `jwt` only on the online path. */
interface Verified {
  kind: 'verified';
  jwt?: string;
}

function refuse(category: RefusalCategory): OperatorRefusal {
  return { kind: 'refused', category };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export class SessionUnlockHandler {
  private inFlight = false;
  private readonly online: OnlineCredentialVerifier;

  constructor(private readonly deps: SessionUnlockHandlerDeps) {
    this.online =
      deps.onlineVerifier ??
      new OnlineCredentialVerifier({
        clerk: deps.clerk,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
  }

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
    const precheck = this.currentLockedSession();
    if (precheck.kind === 'refused') return precheck;
    const { session } = precheck;

    const verdict = await this.verify(session, req);
    if (verdict.kind === 'refused') return verdict;

    // The session must still be the same locked session after the await.
    if (!this.isStillLocked(session.id)) return this.refused('state_invalid', 'session_changed');
    if (verdict.jwt !== undefined) {
      const blocked = this.storeOnlineJwt(session, verdict.jwt);
      if (blocked !== null) return blocked;
    }
    this.deps.sessionManager.unlock(this.now().toISOString());
    this.deps.logger?.info({ event: 'operator.session.unlocked' }, 'session unlocked');
    return { kind: 'unlocked' };
  }

  /** RT-358 Q2 — store the online unlock's JWT, or refuse when the session may not get it. */
  private storeOnlineJwt(session: OperatorSessionRecord, jwt: string): OperatorRefusal | null {
    const snapshot = credentialSnapshotOf(session);
    const blocker = freshCredentialBlocker(
      this.deps.sessionManager,
      snapshot,
      'locked',
      this.deps.isDeviceRevoked ?? (() => false),
    );
    if (blocker !== null) return this.refused(blocker, 'session_changed');
    if (this.deps.jwtHolder !== undefined) {
      const mono = this.deps.monoNowMs?.() ?? performance.now();
      storeFreshCredential(this.deps.jwtHolder, snapshot, jwt, mono);
    }
    return null;
  }

  private currentLockedSession(): OperatorRefusal | LockedSession {
    const session = this.deps.sessionManager.getCurrent();
    if (session === null) return this.refused('not_signed_in', 'no_session');
    if (session.lock_state !== 'locked') return this.refused('state_invalid', 'not_locked');
    return { kind: 'locked', session };
  }

  private verify(
    session: OperatorSessionRecord,
    req: UnlockSessionRequest,
  ): Promise<OperatorRefusal | Verified> {
    return session.role === 'cashier'
      ? this.verifyCashier(session.operator_id, req)
      : this.verifyOnline(session.operator_id, req);
  }

  private isStillLocked(session_id: string): boolean {
    const after = this.deps.sessionManager.getCurrent();
    return after?.id === session_id && after.lock_state === 'locked';
  }

  private async verifyCashier(
    operator_id: string,
    req: UnlockSessionRequest,
  ): Promise<OperatorRefusal | Verified> {
    if (req.method !== 'pin' || !isNonEmptyString(req.pin)) {
      return this.refused('invalid_input', 'shape');
    }
    const result = await this.deps.verifyCashierPin(operator_id, req.pin);
    return result === null ? { kind: 'verified' } : this.refused(result.category, 'pin');
  }

  private async verifyOnline(
    operator_id: string,
    req: UnlockSessionRequest,
  ): Promise<OperatorRefusal | Verified> {
    if (req.method !== 'online_credential' || !hasOnlineCredential(req)) {
      return this.refused('invalid_input', 'shape');
    }
    const verdict = await this.online.verify(operator_id, req.identifier, req.password);
    if (verdict.kind === 'refused') return this.refused(verdict.category, verdict.stage);
    return { kind: 'verified', jwt: verdict.jwt };
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
