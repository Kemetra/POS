/**
 * RT-15 S2 / RT-197 — the single authorization choke point for the return flow.
 *
 * `current()` reads the live state once (flag, operator session on the live
 * paired terminal, manager/admin role, lock, operator envelope) and yields an
 * immutable AUTHORIZATION SNAPSHOT: the actor together with the envelope it
 * was admitted with (RT-197 A5/I1). Every send carries that snapshot's
 * envelope explicitly — nothing on a send path reads the live session or
 * token — so the credential on the wire is bound to the admitted actor by
 * data flow, not by a "read the token right after the recheck" convention.
 *
 * `recheck(snapshot)` compares the live state with the snapshot: the same
 * actor must still be authorized and the live envelope must still be the
 * snapshot's own. It runs at the commit points:
 *   • in submit, immediately before the journal insert;
 *   • in the dispatcher, immediately before every POST (submit and resolver
 *     alike — the resolver takes its snapshot at the start of each pass);
 * and, for disclosure only, after the awaited reads (no sale data or outcome
 * is handed to a session other than the admitted one).
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
  /** RT-15 S4: printed on the return slip as "Paid by" (as on a sale receipt). */
  readonly display_name?: string;
}

/** An actor that passed the gate: who, in which session, with which role, where. */
export interface AuthorizedActor extends ReturnActor {
  readonly role: Role;
  /** RT-15 S4: the operator's display name, for the slip; absent when unknown. */
  readonly displayName?: string;
}

/**
 * The immutable authorization snapshot taken at admission (frozen): the
 * authorized actor and the operator envelope it was admitted with (null when
 * none was present — such a snapshot can never send). Never logged, audited
 * or bridged: audits copy the actor fields explicitly.
 */
export interface AuthSnapshot extends AuthorizedActor {
  readonly envelope: string | null;
}

export type CurrentActor =
  | { readonly kind: 'ok'; readonly actor: AuthSnapshot }
  | {
      readonly kind: 'refused';
      readonly reason: LocalReturnRefusal;
      /** Who was refused, for the audit; null when nobody is signed in. */
      readonly actor: AuthorizedActor | null;
    };

export interface ReturnsAuthorizer {
  /**
   * The live actor (flag on, a session on a paired terminal, manager/admin,
   * unlocked) as an immutable snapshot with its envelope.
   */
  current(): CurrentActor;
  /**
   * Null while the snapshot's actor is still authorized right now and the live
   * envelope is still the snapshot's own; else why not (`offline` when an
   * envelope is missing, `session_changed` when it was replaced).
   */
  recheck(snapshot: AuthSnapshot): LocalReturnRefusal | null;
}

export interface ReturnsAuthorizerDeps {
  readonly isEnabled: () => boolean;
  /** The live operator session on the live paired terminal (null if either is absent). */
  readonly getSession: () => ReturnsSession | null;
  /** True while the operator session is inactivity-locked (RT-117). */
  readonly isSessionLocked: () => boolean;
  /**
   * The live opaque operator envelope, or null. Read ONLY here — when a
   * snapshot is taken and at a recheck — never on a send path.
   */
  readonly getEnvelope: () => string | null;
}

const RETURN_ROLES: ReadonlySet<Role> = new Set<Role>(['manager', 'admin']);

/** D-b: only a manager or admin may start (or resolve) a return. */
export function isReturnsRole(role: Role): boolean {
  return RETURN_ROLES.has(role);
}

function actorOf(session: ReturnsSession): AuthorizedActor {
  return {
    scope: Object.freeze({
      tenantId: session.tenant_id,
      branchId: session.branch_id,
      terminalId: session.terminal_id,
    }),
    operatorId: session.operator_id,
    operatorSessionId: session.operator_session_id,
    role: session.role,
    ...(session.display_name === undefined ? {} : { displayName: session.display_name }),
  };
}

/** A non-empty envelope, else null (an empty string cannot authenticate). */
function presentEnvelope(envelope: string | null): string | null {
  return envelope === null || envelope.length === 0 ? null : envelope;
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
    const envelope = presentEnvelope(deps.getEnvelope());
    return { kind: 'ok', actor: Object.freeze({ ...actor, envelope }) };
  }

  return {
    current,
    recheck(snapshot) {
      const live = current();
      if (live.kind === 'refused') return lostReason(live);
      if (!isSameActor(live.actor, snapshot)) return 'session_changed';
      // No envelope: the till cannot authenticate to Backend-Core at all.
      if (snapshot.envelope === null || live.actor.envelope === null) return 'offline';
      // The envelope was replaced: the snapshot's credential is no longer live.
      return live.actor.envelope === snapshot.envelope ? null : 'session_changed';
    },
  };
}
