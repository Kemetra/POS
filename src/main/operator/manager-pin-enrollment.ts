/**
 * RT-17 slice 4 part 2 — a signed-in manager enrols (or replaces) their local
 * PIN (option A, Jira RT-17 comment 10943): the manager signs in online, the
 * POS keeps their `users.id` from the sign-in response (`manager_user_id`,
 * main-only), and the manager sets a PIN that later approves a variance
 * offline.
 *
 * Admission, in order, before anything is hashed or written
 * (`ManagerPinRefusedError` otherwise; the reason is closed-set, never a value):
 *   1. `POS_PULSE_FEATURE_SHIFT_CASHUP` on — else `feature_disabled`;
 *   2. an operator session — else `no_session`;
 *   3. unlocked — else `session_locked`;
 *   4. a manager or admin — else `not_manager`;
 *   5. with a `users.id` captured from its online sign-in — else
 *      `no_manager_identity`;
 *   6. a PIN of 6–8 ASCII digits — else `invalid_pin`. Longer than the
 *      cashier's 4–6: the approver is found by the PIN alone among the
 *      terminal's managers (`manager-pin-store.ts`);
 *   7. a usable pairing (its RT-215 epoch; null while unpaired or revoked) —
 *      else `no_session`.
 *
 * The record's scope is the paired terminal's (tenant, branch, terminal),
 * which must be the session's own tenant and branch (else `no_session`). The
 * pairing read and the hashing are awaited, so the admission is checked again
 * right before the write: the flag, the same session (its id) for the same
 * manager, unlocked, and the same pairing epoch. A sign-out, a takeover, a
 * lock, a revocation or a re-pair in between writes nothing.
 *
 * Nothing comes from the caller but the PIN; it is consumed by the hashing and
 * never logged, stored or echoed.
 */
import { MANAGER_PIN_PATTERN } from '../../shared/shift-cashup/types.js';
import type { Role } from '../../shared/operator/role.js';
import type { ManagerPinScope, ManagerPinStore } from './manager-pin-store.js';
import type { OperatorSessionRecord } from './session-manager.js';

export type ManagerPinRefusalReason =
  | 'feature_disabled'
  | 'no_session'
  | 'session_locked'
  | 'not_manager'
  | 'no_manager_identity'
  | 'invalid_pin';

/** An enrolment refused before anything was written. Names the reason only. */
export class ManagerPinRefusedError extends Error {
  readonly reason: ManagerPinRefusalReason;

  constructor(reason: ManagerPinRefusalReason) {
    super(`manager PIN enrolment refused: ${reason}`);
    this.name = 'ManagerPinRefusedError';
    this.reason = reason;
  }
}

/** The live operator session as the enrolment needs it (main-only). */
export interface ManagerIdentity {
  operatorSessionId: string;
  role: Role;
  /** The `users.id` captured from a manager / admin online sign-in. */
  userId?: string;
  tenantId: string;
  branchId: string;
}

/** `ManagerIdentity` of the live session, or null without one. */
export function managerIdentityOf(record: OperatorSessionRecord | null): ManagerIdentity | null {
  if (record === null) return null;
  return {
    operatorSessionId: record.id,
    role: record.role,
    ...(record.manager_user_id === undefined ? {} : { userId: record.manager_user_id }),
    tenantId: record.tenant_id,
    branchId: record.branch_id,
  };
}

export interface ManagerPinEnrollmentDeps {
  /** `POS_PULSE_FEATURE_SHIFT_CASHUP`, read per call. */
  isEnabled: () => boolean;
  getManager: () => ManagerIdentity | null;
  isSessionLocked: () => boolean;
  /** The current pairing's scope; null while unpaired or needing a re-pair. */
  pairedScope: () => Promise<ManagerPinScope | null>;
  /** `PairingStore.getPairingEpoch` — null while unpaired or revoked. */
  pairingEpoch: () => string | null;
  store: Pick<ManagerPinStore, 'seal' | 'save'>;
  /** ISO-8601 instants. */
  now: () => string;
}

export interface ManagerPinEnrollment {
  enroll(input: { managerPin: string }): Promise<void>;
}

/** An admitted manager: the session and its captured users.id. */
interface Admitted {
  manager: ManagerIdentity;
  userId: string;
}

function refuse(reason: ManagerPinRefusalReason): never {
  throw new ManagerPinRefusedError(reason);
}

function isManagerPin(value: unknown): value is string {
  return typeof value === 'string' && MANAGER_PIN_PATTERN.test(value);
}

/** The paired scope when it is the manager's own tenant and branch, else null. */
function ownScope(scope: ManagerPinScope | null, manager: ManagerIdentity): ManagerPinScope | null {
  if (scope === null) return null;
  const own = scope.tenantId === manager.tenantId && scope.branchId === manager.branchId;
  return own ? scope : null;
}

export function createManagerPinEnrollment(deps: ManagerPinEnrollmentDeps): ManagerPinEnrollment {
  /** Steps 1–5 of the module header. */
  function admit(): Admitted {
    if (!deps.isEnabled()) refuse('feature_disabled');
    const manager = deps.getManager() ?? refuse('no_session');
    if (deps.isSessionLocked()) refuse('session_locked');
    if (manager.role === 'cashier') refuse('not_manager');
    const userId = manager.userId ?? refuse('no_manager_identity');
    return { manager, userId };
  }

  /** After the awaits: the same session, same manager, same pairing. */
  function recheck(input: { admitted: Admitted; epoch: string }): void {
    const live = admit();
    const sameSession = live.manager.operatorSessionId === input.admitted.manager.operatorSessionId;
    if (!sameSession || live.userId !== input.admitted.userId) refuse('no_session');
    if (deps.pairingEpoch() !== input.epoch) refuse('no_session');
  }

  return {
    async enroll(input) {
      const admitted = admit();
      if (!isManagerPin(input.managerPin)) refuse('invalid_pin');
      const epoch = deps.pairingEpoch() ?? refuse('no_session');
      const scope = ownScope(await deps.pairedScope(), admitted.manager) ?? refuse('no_session');
      const sealed = await deps.store.seal(input.managerPin);
      recheck({ admitted, epoch });
      deps.store.save({ scope, userId: admitted.userId, sealed, now: deps.now() });
    },
  };
}
