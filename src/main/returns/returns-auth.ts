/**
 * RT-15 S2 — the single authorization choke point for the return flow.
 *
 * `current()` reads the live state once (flag, operator session on the live
 * paired terminal, manager/admin role, lock) and yields the authorized actor.
 * `recheck(actor)` re-reads it and requires the SAME actor to still be
 * authorized, with an operator envelope present. It runs:
 *   • in submit, after every await and immediately before the journal insert;
 *   • in the dispatcher, immediately before every network send (submit and
 *     resolver alike — the resolver passes the actor its pass started with).
 * So a lock, sign-out, switch to a cashier, unpairing or flag-off that happens
 * while a request is awaited can never lead to a write under the wrong (or no)
 * authorization.
 */
import type { Role } from '../../shared/operator/role.js';
import type { LocalReturnRefusal } from '../../shared/returns/types.js';
import type { ReturnActor } from './returns-audit.js';
import type { ReturnScope } from './returns-repository.js';

/** The operator session as the return flow needs it (main-only). */
export interface ReturnsSession {
  readonly role: Role;
  readonly operator_id: string;
  readonly operator_session_id: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly terminal_id: string;
}

/** An actor that passed the gate: who, in which session, with which role, where. */
export interface AuthorizedActor extends ReturnActor {
  readonly role: Role;
}

export type CurrentActor =
  | { readonly kind: 'ok'; readonly actor: AuthorizedActor }
  | {
      readonly kind: 'refused';
      readonly reason: LocalReturnRefusal;
      /** Who was refused, for the audit; null when nobody is signed in. */
      readonly actor: AuthorizedActor | null;
    };

export interface ReturnsAuthorizer {
  /** The live actor: flag on, a session on a paired terminal, manager/admin, unlocked. */
  current(): CurrentActor;
  /**
   * Null while `actor` is still authorized right now and an envelope is
   * present; else why not (`offline` when only the envelope is missing).
   */
  recheck(actor: AuthorizedActor): LocalReturnRefusal | null;
}

export interface ReturnsAuthorizerDeps {
  readonly isEnabled: () => boolean;
  /** The live operator session on the live paired terminal (null if either is absent). */
  readonly getSession: () => ReturnsSession | null;
  /** True while the operator session is inactivity-locked (RT-117). */
  readonly isSessionLocked: () => boolean;
  /** True when an operator envelope is present (a send can authenticate). */
  readonly hasEnvelope: () => boolean;
}

const RETURN_ROLES: ReadonlySet<Role> = new Set<Role>(['manager', 'admin']);

/** D-b: only a manager or admin may start (or resolve) a return. */
export function isReturnsRole(role: Role): boolean {
  return RETURN_ROLES.has(role);
}

function actorOf(session: ReturnsSession): AuthorizedActor {
  return {
    scope: {
      tenantId: session.tenant_id,
      branchId: session.branch_id,
      terminalId: session.terminal_id,
    },
    operatorId: session.operator_id,
    operatorSessionId: session.operator_session_id,
    role: session.role,
  };
}

function scopeKey(scope: ReturnScope): string {
  return `${scope.tenantId}|${scope.branchId}|${scope.terminalId}`;
}

/** Same operator, same session, same terminal scope. */
function isSameActor(a: AuthorizedActor, b: AuthorizedActor): boolean {
  if (a.operatorId !== b.operatorId) return false;
  if (a.operatorSessionId !== b.operatorSessionId) return false;
  return scopeKey(a.scope) === scopeKey(b.scope);
}

/** Why the live actor is no longer the authorized one, for a refused live read. */
function lostReason(live: CurrentActor & { kind: 'refused' }): LocalReturnRefusal {
  return live.reason === 'no_session' ? 'session_changed' : live.reason;
}

export function createReturnsAuthorizer(deps: ReturnsAuthorizerDeps): ReturnsAuthorizer {
  function current(): CurrentActor {
    if (!deps.isEnabled()) return { kind: 'refused', reason: 'feature_disabled', actor: null };
    const session = deps.getSession();
    if (session === null) return { kind: 'refused', reason: 'no_session', actor: null };
    const actor = actorOf(session);
    if (!isReturnsRole(session.role)) return { kind: 'refused', reason: 'role_denied', actor };
    if (deps.isSessionLocked()) return { kind: 'refused', reason: 'session_changed', actor };
    return { kind: 'ok', actor };
  }

  return {
    current,
    recheck(actor) {
      const live = current();
      if (live.kind === 'refused') return lostReason(live);
      if (!isSameActor(live.actor, actor)) return 'session_changed';
      // No envelope: the till cannot authenticate to Backend-Core at all.
      return deps.hasEnvelope() ? null : 'offline';
    },
  };
}
