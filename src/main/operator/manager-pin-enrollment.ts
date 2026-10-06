/**
 * RT-17 slice 4 part 2 — a signed-in manager enrols (or replaces) their local
 * PIN (option A, Jira RT-17 comment 10943): the manager signs in online, the
 * POS keeps their `users.id` and the local time of that sign-in
 * (`manager_user_id`, `manager_signed_in_at`, main-only), and the manager sets
 * a PIN that later approves a variance offline.
 *
 * Admission, in order, before anything is hashed or written
 * (`ManagerPinRefusedError` otherwise; the reason is closed-set, never a value):
 *   1. `POS_PULSE_FEATURE_SHIFT_CASHUP` on — else `feature_disabled`;
 *   2. an operator session — else `no_session`;
 *   3. unlocked — else `session_locked`;
 *   4. a manager or admin — else `not_manager`;
 *   5. with a `users.id` captured from its online sign-in — else
 *      `no_manager_identity`;
 *   6. review round 1 P2-2 (step-up): within `MANAGER_ENROL_STEP_UP_MS` (2
 *      minutes) of that online sign-in — else `reauth_required` (sign in
 *      again, online);
 *   7. a PIN (and a current PIN, when given) of 6–8 ASCII digits — else
 *      `invalid_pin`; and not a weak PIN (round 1: one digit repeated, a
 *      repeated block, an ascending or descending run, or a short list of
 *      common PINs) — else `pin_too_weak`;
 *   8. a usable pairing (its RT-215 epoch; null while unpaired or revoked) —
 *      else `no_session`.
 *
 * The record's scope is the paired terminal's (tenant, branch, terminal),
 * which must be the session's own tenant and branch (else `no_session`). A
 * PIN replacement needs the current PIN, verified by the store with lockout
 * (`current_pin_required` / `current_pin_invalid` / `current_pin_locked`).
 * The pairing read and the hashing are awaited, so the admission is checked
 * again after them, and once more inside the store right before the write: the
 * flag, the same session (its id) for the same manager, unlocked, still in the
 * step-up window, and the same pairing epoch.
 *
 * `createManagerOnlineRefresh` (round 1 P2-1): each online manager / admin
 * sign-in on this terminal refreshes that manager's record (`last_online_at`);
 * a record expires 30 days after it (`manager-pin-store.ts`).
 *
 * Nothing comes from the caller but the PINs; they are consumed by the
 * hashing and the store, and never logged, stored or echoed.
 */
import { MANAGER_PIN_PATTERN } from '../../shared/shift-cashup/types.js';
import type { Role } from '../../shared/operator/role.js';
import type { ManagerPinScope, ManagerPinStore } from './manager-pin-store.js';
import type { OperatorSessionRecord } from './session-manager.js';

/** Enrolment is allowed this long after the manager's online sign-in. */
export const MANAGER_ENROL_STEP_UP_MS = 2 * 60 * 1000;

export type ManagerPinRefusalReason =
  | 'feature_disabled'
  | 'no_session'
  | 'session_locked'
  | 'not_manager'
  | 'no_manager_identity'
  | 'reauth_required'
  | 'invalid_pin'
  | 'pin_too_weak'
  | 'current_pin_required'
  | 'current_pin_invalid'
  | 'current_pin_locked';

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
  displayName: string;
  /** The local time of that online sign-in. */
  signedInAt?: string;
  tenantId: string;
  branchId: string;
}

/** `ManagerIdentity` of the live session, or null without one. */
export function managerIdentityOf(record: OperatorSessionRecord | null): ManagerIdentity | null {
  if (record === null) return null;
  const { manager_user_id: userId, manager_signed_in_at: signedInAt } = record;
  return {
    operatorSessionId: record.id,
    role: record.role,
    ...(userId === undefined ? {} : { userId }),
    displayName: record.display_name,
    ...(signedInAt === undefined ? {} : { signedInAt }),
    tenantId: record.tenant_id,
    branchId: record.branch_id,
  };
}

/** Common PINs that are neither a repeat nor a run (round 1, kept short). */
const COMMON_PINS: ReadonlySet<string> = new Set([
  '112233',
  '11223344',
  '123321',
  '12344321',
  '147258',
  '147258369',
  '159753',
  '102030',
  '258456',
  '852456',
]);

/** True when every step between neighbouring digits is `step` (mod 10). */
function isRun(pin: string, step: 1 | 9): boolean {
  const digits = Array.from(pin, Number);
  return digits.slice(1).every((digit, i) => digit === ((digits[i] ?? 0) + step) % 10);
}

/** Round 1: a PIN a cashier could guess first. Assumes 6–8 ASCII digits. */
export function isWeakManagerPin(pin: string): boolean {
  if (/^(\d{1,4})\1+$/.test(pin)) return true;
  if (isRun(pin, 1) || isRun(pin, 9)) return true;
  return COMMON_PINS.has(pin);
}

function isManagerPin(value: unknown): value is string {
  return typeof value === 'string' && MANAGER_PIN_PATTERN.test(value);
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
  store: Pick<ManagerPinStore, 'seal' | 'enrol'>;
  /** ISO-8601 instants. */
  now: () => string;
}

export interface ManagerPinEnrollment {
  enroll(input: { managerPin: string; currentPin?: string }): Promise<void>;
}

/** An admitted manager: the session, its captured users.id and sign-in time. */
interface Admitted {
  manager: ManagerIdentity;
  userId: string;
  signedInAt: string;
}

function refuse(reason: ManagerPinRefusalReason): never {
  throw new ManagerPinRefusedError(reason);
}

/** No session, a session replaced, or no usable pairing (unpaired, revoked, re-paired). */
function noSession(): never {
  refuse('no_session');
}

/** The paired scope when it is the manager's own tenant and branch, else null. */
function ownScope(scope: ManagerPinScope | null, manager: ManagerIdentity): ManagerPinScope | null {
  if (scope === null) return null;
  const own = scope.tenantId === manager.tenantId && scope.branchId === manager.branchId;
  return own ? scope : null;
}

/** Steps 7: the new PIN, and the current one when given. */
function requireStrongPins(input: { managerPin: string; currentPin?: string }): void {
  const { managerPin, currentPin } = input;
  const pins = currentPin === undefined ? [managerPin] : [managerPin, currentPin];
  if (!pins.every(isManagerPin)) refuse('invalid_pin');
  if (isWeakManagerPin(managerPin)) refuse('pin_too_weak');
}

const STORE_REFUSALS = {
  current_pin_required: 'current_pin_required',
  current_pin_invalid: 'current_pin_invalid',
  current_pin_locked: 'current_pin_locked',
} as const;

export function createManagerPinEnrollment(deps: ManagerPinEnrollmentDeps): ManagerPinEnrollment {
  /** Step 6: still within the step-up window of the online sign-in. */
  function isWithinStepUp(signedInAt: string | undefined): signedInAt is string {
    if (signedInAt === undefined) return false;
    const elapsed = Date.parse(deps.now()) - Date.parse(signedInAt);
    return elapsed >= 0 && elapsed <= MANAGER_ENROL_STEP_UP_MS;
  }

  /** Steps 1–6 of the module header. */
  function admit(): Admitted {
    if (!deps.isEnabled()) refuse('feature_disabled');
    const manager = deps.getManager() ?? noSession();
    if (deps.isSessionLocked()) refuse('session_locked');
    if (manager.role === 'cashier') refuse('not_manager');
    const userId = manager.userId ?? refuse('no_manager_identity');
    const { signedInAt } = manager;
    if (!isWithinStepUp(signedInAt)) refuse('reauth_required');
    return { manager, userId, signedInAt };
  }

  /** Step 8: the usable pairing's epoch, and its scope — the manager's own. */
  async function pairingOf(
    manager: ManagerIdentity,
  ): Promise<{ epoch: string; scope: ManagerPinScope }> {
    const epoch = deps.pairingEpoch();
    const scope = epoch === null ? null : ownScope(await deps.pairedScope(), manager);
    if (epoch === null || scope === null) noSession();
    return { epoch, scope };
  }

  /** After an await: the same session, same manager, same pairing. */
  function recheck(input: { admitted: Admitted; epoch: string }): void {
    const live = admit();
    const { admitted } = input;
    const same =
      live.manager.operatorSessionId === admitted.manager.operatorSessionId &&
      live.userId === admitted.userId &&
      deps.pairingEpoch() === input.epoch;
    if (!same) noSession();
  }

  return {
    async enroll(input) {
      const admitted = admit();
      requireStrongPins(input);
      const { epoch, scope } = await pairingOf(admitted.manager);
      const sealed = await deps.store.seal(input.managerPin);
      const guard = (): void => {
        recheck({ admitted, epoch });
      };
      guard();
      const outcome = await deps.store.enrol({
        scope,
        userId: admitted.userId,
        displayName: admitted.manager.displayName,
        sealed,
        ...(input.currentPin === undefined ? {} : { currentPin: input.currentPin }),
        now: deps.now(),
        onlineAt: admitted.signedInAt,
        guard,
      });
      if (outcome.kind !== 'enrolled') refuse(STORE_REFUSALS[outcome.kind]);
    },
  };
}

export interface ManagerOnlineRefreshDeps {
  store: Pick<ManagerPinStore, 'touchOnline'>;
  /** The current pairing's terminal; null while unpaired. */
  currentTerminalId: () => string | null;
}

/**
 * Round 1 P2-1 — a session-start listener: an online manager / admin sign-in
 * (a session with a captured `users.id`) refreshes that manager's record on
 * the current terminal. Other sessions, or an unpaired terminal, touch nothing.
 */
export function createManagerOnlineRefresh(
  deps: ManagerOnlineRefreshDeps,
): (record: OperatorSessionRecord) => void {
  return (record) => {
    const { manager_user_id: userId, manager_signed_in_at: at } = record;
    if (userId === undefined || at === undefined) return;
    const terminalId = deps.currentTerminalId();
    if (terminalId === null) return;
    deps.store.touchOnline({
      scope: { tenantId: record.tenant_id, branchId: record.branch_id, terminalId },
      userId,
      at,
    });
  };
}
