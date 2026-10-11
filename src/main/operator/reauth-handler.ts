import type { Logger } from 'pino';

import type { ReauthenticateRequest, ReauthenticateResponse } from '../../shared/bridge-api.js';
import type { OperatorRefusal, RefusalCategory } from '../../shared/audit/event-shape.js';

import {
  credentialSnapshotOf,
  freshCredentialBlocker,
  storeFreshCredential,
  type CredentialSnapshot,
} from './fresh-credential.js';
import type { JwtHolder } from './jwt-holder.js';
import type { OnlineCredentialVerifier } from './online-credential-verifier.js';
import type { SessionManager } from './session-manager.js';

/**
 * RT-358 (RT-247 plan §2.3) — `operator:reauthenticate`. A manager whose held
 * sign-in JWT expired proves their credentials again without leaving the
 * screen; the renderer then re-runs the refused action once.
 *
 *   • Manager / admin only, on an unlocked, unlatched session.
 *   • The shared `OnlineCredentialVerifier` checks the credentials: the same
 *     operator only (another person → the generic `invalid_input`), the lockout
 *     and the one-in-flight gate shared with the manager online unlock.
 *   • After the exchange the session is checked again (`freshCredentialBlocker`):
 *     ended / replaced / latched / revoked → `not_signed_in`, locked →
 *     `state_invalid`; nothing is stored.
 *   • Success stores the JWT for the active backend session with the one-shot
 *     mark. It refreshes the credential only: no new session, no backend
 *     session, no lifecycle hook, never `manager_signed_in_at` (Q1 = no).
 *
 * The identifier, password and JWT are never logged or returned.
 */

export interface ReauthHandlerDeps {
  sessionManager: Pick<SessionManager, 'getCurrent'>;
  verifier: Pick<OnlineCredentialVerifier, 'verify'>;
  jwtHolder: Pick<JwtHolder, 'set'>;
  isDeviceRevoked: () => boolean;
  /** Monotonic clock (ms) for the re-auth mark. Tests inject. */
  monoNowMs?: () => number;
  logger?: Logger;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export class ReauthHandler {
  constructor(private readonly deps: ReauthHandlerDeps) {}

  async reauthenticate(req: ReauthenticateRequest): Promise<ReauthenticateResponse> {
    const admitted = this.admit(req);
    if (admitted.kind === 'refused') return admitted;
    const { snapshot } = admitted;

    const verdict = await this.deps.verifier.verify(
      snapshot.operator_id,
      req.identifier,
      req.password,
    );
    if (verdict.kind === 'refused') return this.refused(verdict.category, verdict.stage);

    const afterExchange = this.blocker(snapshot);
    if (afterExchange !== null) return this.refused(afterExchange, 'session_changed');
    storeFreshCredential(this.deps.jwtHolder, snapshot, verdict.jwt, this.monoNow());
    this.deps.logger?.info({ event: 'operator.reauth.succeeded' }, 'operator re-authenticated');
    return { kind: 'reauthenticated' };
  }

  /** The checks before any credential is sent: a manager on a usable session, a well-formed request. */
  private admit(
    req: ReauthenticateRequest,
  ): { kind: 'admitted'; snapshot: CredentialSnapshot } | OperatorRefusal {
    const session = this.deps.sessionManager.getCurrent();
    if (session === null) return this.refused('not_signed_in', 'no_session');
    if (session.role === 'cashier') return this.refused('role_mismatch', 'role');
    const snapshot = credentialSnapshotOf(session);
    const atEntry = this.blocker(snapshot);
    if (atEntry !== null) return this.refused(atEntry, 'entry');
    if (!isNonEmptyString(req.identifier) || !isNonEmptyString(req.password)) {
      return this.refused('invalid_input', 'shape');
    }
    return { kind: 'admitted', snapshot };
  }

  private blocker(snapshot: CredentialSnapshot): RefusalCategory | null {
    return freshCredentialBlocker(
      this.deps.sessionManager,
      snapshot,
      'unlocked',
      this.deps.isDeviceRevoked,
    );
  }

  private monoNow(): number {
    return this.deps.monoNowMs?.() ?? performance.now();
  }

  private refused(category: RefusalCategory, stage: string): OperatorRefusal {
    this.deps.logger?.info(
      { event: 'operator.reauth.refused', category, stage },
      'operator re-auth refused',
    );
    return { kind: 'refused', category };
  }
}
