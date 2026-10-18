/**
 * RT-17 slice 4 part 2 — the local manager PIN store (option A, Jira RT-17
 * comment 10943; [GATED] migration 0044).
 *
 * The secret is the cashier PIN's: an Argon2id PHC string (`hashPin`) sealed
 * with safeStorage (`sealPinMaterial`), checked by the cashier verifier
 * (`verifyPinWithWindow`: 5 failures → 5 minutes).
 *
 * Review round 1 (Codex P1 4193622781, review P2-1/P2-2/P2-5, nits 6/7/9):
 *   • Keyed, never by PIN alone: each record has an opaque handle
 *     (`manager_ref`, a random UUID, never the users.id). `verify` checks the
 *     PIN against that ONE record in the scope, with its own lockout — one
 *     Argon2 per attempt. An unknown handle is `invalid` (nothing counted).
 *     Two managers may share a PIN; neither can approve as the other.
 *   • Expiry (P2-1): a record is valid for `MANAGER_ONLINE_VALIDITY_MS` (30
 *     days) after the manager's last online manager / admin sign-in on this
 *     terminal (`last_online_at`: set at enrolment, refreshed by
 *     `touchOnline`). An expired record answers `expired` before any check,
 *     and is not listed. Review round 2 (Codex P2 4194169617): a last
 *     sign-in in the future — the clock corrected backwards since — is
 *     expired too, never longer-lived (as the enrolment step-up, elapsed must
 *     be ≥ 0). The next online sign-in at the corrected time makes it valid.
 *   • `list` gives the scope's valid records as { managerRef, displayName }:
 *     the approver picker. No users.id leaves this module except the one
 *     `verify` returns to main.
 *   • `enrol` (P2-2): creates the manager's record, or replaces its PIN only
 *     after verifying the current one (with lockout): `current_pin_required`,
 *     `current_pin_invalid`, `current_pin_locked`. The caller's `guard` runs
 *     right before the write (a throw writes nothing). A replacement keeps the
 *     handle and clears the lockout.
 *   • Serialised (nit 9): every `verify` and `enrol` runs one at a time, so
 *     concurrent attempts cannot share a failure count and an enrolment never
 *     interleaves with an attempt. An attempt's lockout write is also guarded
 *     on the secret it checked (nit 7), so it never lands on a newer one.
 *
 * RT-438 (MA-1, RT-114 C3/C4 on this credential; migration 0047):
 *   • Policy per action kind (`manager-approval-policy.ts`): `verify` and
 *     `list` take the window to check against. Without one they use the
 *     RT-17 variance's (30 days, no age limit), so RT-17 is unchanged.
 *   • Disable: a third consecutive lockout (no success between them) sets
 *     `disabled_at`. A disabled record answers `revoked` before any check and
 *     is not listed; a success resets the count.
 *   • Revoke: `revoke` marks a record revoked (self, another manager, or
 *     `ineligible` for MA-3). Same treatment as disabled.
 *   • A new enrolment over a disabled or revoked record needs no current PIN
 *     (the manager is signed in online with the step-up) and clears all four
 *     lifecycle columns in place; the handle is kept.
 *   • `onEvent` reports enrolled / revoked / locked_out / disabled to the
 *     composition root, which audits them. Ids only, never a PIN or a hash.
 *
 * No logger: the PIN and the hashes cannot reach a log from this module
 * (PR-1). Nothing here is ever sent to the renderer.
 */
import { randomUUID } from 'node:crypto';

import type { DatabaseHandle } from '../db/client.js';
import type { SafeStorageLike } from '../secrets/safe-storage.js';
import { hashPin, type PinRow, type PinVerifyResult } from './pin-credential.js';
import { verifyPinWithWindow } from './pin-lockout.js';
import { sealPinMaterial, unsealPinMaterial, type SealedPinMaterial } from './pin-seal.js';
import { SHIFT_VARIANCE_POLICY, type ManagerCredentialPolicy } from './manager-approval-policy.js';

export type { SealedPinMaterial };

/** A record is valid this long after the manager's last online sign-in here (RT-17 variance). */
export const MANAGER_ONLINE_VALIDITY_MS = SHIFT_VARIANCE_POLICY.onlineValidityMs;

/** RT-114 C3: the consecutive lockout that disables the record. */
export const MANAGER_PIN_DISABLE_AFTER_LOCKOUTS = 3;

/** RT-438 — why a record was revoked (0047's closed set). */
export type ManagerPinRevokeReason = 'self' | 'other_manager' | 'ineligible';

/** RT-438 — a lifecycle fact for the audit trail: ids only, never a PIN or a hash. */
/**
 * RT-438 (review) — the operator session that started a credential operation,
 * captured by the caller BEFORE any async PIN work: the audit names who
 * acted, never whichever session is current when the event lands.
 */
export interface CredentialActor {
  operatorId: string;
  sessionId: string;
}

export interface ManagerCredentialEvent {
  kind: 'enrolled' | 'revoked' | 'locked_out' | 'disabled';
  scope: ManagerPinScope;
  userId: string;
  managerRef: string;
  at: string;
  revokeReason?: ManagerPinRevokeReason;
  /** Who started the operation; absent for a system one (the system actor). */
  actor?: CredentialActor;
}

/** Where a manager PIN is enrolled and verified: the paired terminal. */
export interface ManagerPinScope {
  tenantId: string;
  branchId: string;
  terminalId: string;
}

export type ManagerPinVerdict =
  | { kind: 'verified'; userId: string }
  | { kind: 'invalid' }
  | { kind: 'locked' }
  | { kind: 'expired' }
  // RT-438: disabled by repeated lockouts, or revoked. Re-enrol online.
  | { kind: 'revoked' };

/** An approver the picker may offer: the opaque handle and the name only. */
export interface EnrolledManager {
  managerRef: string;
  displayName: string;
}

export interface EnrolManagerPinInput {
  scope: ManagerPinScope;
  /** The manager's `users.id` (stored lower-cased). */
  userId: string;
  displayName: string;
  sealed: SealedPinMaterial;
  /** The current PIN; required to replace an existing record's PIN. */
  currentPin?: string;
  /** ISO-8601 instant of the enrolment. */
  now: string;
  /** The manager's online sign-in instant (the record's `last_online_at`). */
  onlineAt: string;
  /** The session enrolling, for the audit. */
  actor?: CredentialActor;
  /** Runs synchronously right before the write; a throw writes nothing. */
  guard: () => void;
}

export type EnrolManagerPinOutcome =
  | { kind: 'enrolled' }
  | { kind: 'current_pin_required' }
  | { kind: 'current_pin_invalid' }
  | { kind: 'current_pin_locked' };

export interface VerifyManagerPinInput {
  scope: ManagerPinScope;
  managerRef: string;
  pin: string;
  now: string;
  /** RT-438: the window to check; the RT-17 variance's when omitted. */
  policy?: ManagerCredentialPolicy;
  /** The session presenting the PIN, for the audit of a lockout. */
  actor?: CredentialActor;
}

/**
 * RT-438 — which record to revoke, and who asks. A manager revoking their own
 * record is `self`, anyone else's `other_manager`; without a requester (the
 * MA-3 revalidation) it is `ineligible`.
 */
export interface RevokeManagerPinInput {
  scope: ManagerPinScope;
  target: { managerRef: string } | { userId: string };
  requesterUserId: string | null;
  now: string;
  /** The session revoking, for the audit. */
  actor?: CredentialActor;
  /**
   * Runs synchronously right before the write, after any earlier queued PIN
   * work has settled; a throw writes nothing (as for `enrol`).
   */
  guard?: () => void;
}

export type RevokeManagerPinOutcome =
  | { kind: 'revoked'; reason: ManagerPinRevokeReason }
  | { kind: 'not_found' };

export interface ManagerPinStore {
  /** Hash (Argon2id) and seal a PIN for `enrol`. The PIN is not kept. */
  seal(pin: string): Promise<SealedPinMaterial>;
  enrol(input: EnrolManagerPinInput): Promise<EnrolManagerPinOutcome>;
  verify(input: VerifyManagerPinInput): Promise<ManagerPinVerdict>;
  list(input: {
    scope: ManagerPinScope;
    now: string;
    policy?: ManagerCredentialPolicy;
    /** RT-441: only this manager's record (the signed-in manager, for recovery). */
    userId?: string;
  }): EnrolledManager[];
  /** RT-438: revoke a record in scope; a record already revoked or disabled is `not_found`. */
  revoke(input: RevokeManagerPinInput): Promise<RevokeManagerPinOutcome>;
  /** An online manager / admin sign-in on this terminal at `at`. */
  touchOnline(input: { scope: ManagerPinScope; userId: string; at: string }): void;
}

export interface ManagerPinStoreDeps {
  db: Pick<DatabaseHandle, 'prepare'>;
  safeStorage: SafeStorageLike;
  /** RT-438: lifecycle facts for the audit trail. A throw is the caller's to contain. */
  onEvent?: (event: ManagerCredentialEvent) => void;
}

interface StoredRow {
  user_id: string;
  manager_ref: string;
  display_name: string;
  pin_hash: Uint8Array;
  pin_salt: Uint8Array;
  failed_attempt_count: number;
  lockout_until: string | null;
  enrolled_at: string;
  last_online_at: string;
  lockout_count: number;
  disabled_at: string | null;
  revoked_at: string | null;
}

type Run = { run(...params: unknown[]): { changes: number } };
type Get = { get(...params: unknown[]): StoredRow | undefined };
type All = { all(...params: unknown[]): StoredRow[] };

/** One record's attempt: the scope, the record as read, the PIN tried and when. */
interface Attempt {
  scope: ManagerPinScope;
  row: StoredRow;
  pin: string;
  now: string;
  actor: CredentialActor | undefined;
}

const COLUMNS = `user_id, manager_ref, display_name, pin_hash, pin_salt,
                 failed_attempt_count, lockout_until, enrolled_at, last_online_at,
                 lockout_count, disabled_at, revoked_at`;
const IN_SCOPE = 'tenant_id = ? AND branch_id = ? AND terminal_id = ?';

const SELECT_BY_REF = `SELECT ${COLUMNS} FROM manager_pin_records
                        WHERE ${IN_SCOPE} AND manager_ref = ?`;
const SELECT_BY_USER = `SELECT ${COLUMNS} FROM manager_pin_records
                         WHERE ${IN_SCOPE} AND user_id = ?`;
const SELECT_SCOPE = `SELECT ${COLUMNS} FROM manager_pin_records
                       WHERE ${IN_SCOPE} ORDER BY display_name, manager_ref`;

const UPSERT = `
  INSERT INTO manager_pin_records
    (tenant_id, branch_id, terminal_id, user_id, manager_ref, display_name, pin_hash, pin_salt,
     failed_attempt_count, lockout_until, enrolled_at, last_online_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
  ON CONFLICT (tenant_id, branch_id, terminal_id, user_id) DO UPDATE SET
    display_name = excluded.display_name,
    pin_hash = excluded.pin_hash,
    pin_salt = excluded.pin_salt,
    failed_attempt_count = 0,
    lockout_until = NULL,
    enrolled_at = excluded.enrolled_at,
    last_online_at = excluded.last_online_at,
    lockout_count = 0,
    disabled_at = NULL,
    revoked_at = NULL,
    revoke_reason = NULL`;

/** Nit 7: only on the secret the attempt checked. RT-438: with the lockout count. */
const SET_LOCKOUT = `
  UPDATE manager_pin_records
     SET failed_attempt_count = ?, lockout_until = ?, lockout_count = ?,
         disabled_at = COALESCE(disabled_at, ?)
   WHERE ${IN_SCOPE} AND user_id = ? AND pin_hash = ?`;

const REVOKE = `UPDATE manager_pin_records SET revoked_at = ?, revoke_reason = ?
                 WHERE ${IN_SCOPE} AND manager_ref = ?
                   AND revoked_at IS NULL AND disabled_at IS NULL`;

const TOUCH_ONLINE = `UPDATE manager_pin_records SET last_online_at = ?
                       WHERE ${IN_SCOPE} AND user_id = ?`;

const CURRENT_PIN_REFUSAL = {
  locked_out: { kind: 'current_pin_locked' },
  no_match: { kind: 'current_pin_invalid' },
} as const;

function scopeParams(scope: ManagerPinScope): [string, string, string] {
  return [scope.tenantId, scope.branchId, scope.terminalId];
}

/** True while `now` is at or after `from` and at most `windowMs` after it (round 2). */
function isWithin(from: string, now: string, windowMs: number): boolean {
  const elapsed = Date.parse(now) - Date.parse(from);
  return elapsed >= 0 && elapsed <= windowMs;
}

/**
 * True while the record is inside the policy's windows: from the last online
 * sign-in (round 2: one in the future is not current) and, RT-438, from when
 * the PIN was set.
 */
function isCurrent(row: StoredRow, now: string, policy: ManagerCredentialPolicy): boolean {
  if (!isWithin(row.last_online_at, now, policy.onlineValidityMs)) return false;
  return policy.maxAgeMs === null || isWithin(row.enrolled_at, now, policy.maxAgeMs);
}

/** RT-438: neither disabled by lockouts nor revoked. */
function isActive(row: StoredRow): boolean {
  return row.disabled_at === null && row.revoked_at === null;
}

function verdictOf(row: StoredRow, result: PinVerifyResult | null): ManagerPinVerdict {
  if (result?.kind === 'match') return { kind: 'verified', userId: row.user_id };
  return result?.kind === 'locked_out' ? { kind: 'locked' } : { kind: 'invalid' };
}

export function createManagerPinStore(deps: ManagerPinStoreDeps): ManagerPinStore {
  const { db, safeStorage } = deps;

  function report(
    kind: ManagerCredentialEvent['kind'],
    input: {
      scope: ManagerPinScope;
      row: Pick<StoredRow, 'user_id' | 'manager_ref'>;
      at: string;
      actor: CredentialActor | undefined;
    },
    revokeReason?: ManagerPinRevokeReason,
  ): void {
    deps.onEvent?.({
      kind,
      scope: input.scope,
      userId: input.row.user_id,
      managerRef: input.row.manager_ref,
      at: input.at,
      ...(revokeReason === undefined ? {} : { revokeReason }),
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    });
  }
  let queue: Promise<unknown> = Promise.resolve();

  /** Runs `task` after every earlier `verify` / `enrol` has settled. */
  function serialised<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }

  /** The record's unsealed PIN row, or null when its seal does not open. */
  function unsealed(row: StoredRow): PinRow | null {
    try {
      const raw = unsealPinMaterial(
        { pin_hash: Buffer.from(row.pin_hash), pin_salt: Buffer.from(row.pin_salt) },
        safeStorage,
      );
      return {
        ...raw,
        failed_attempt_count: row.failed_attempt_count,
        lockout_until: row.lockout_until,
      };
    } catch {
      return null;
    }
  }

  function setLockout(
    input: Attempt & {
      failed: number;
      until: string | null;
      lockouts: number;
      disabledAt: string | null;
    },
  ): void {
    (db.prepare(SET_LOCKOUT) as Run).run(
      input.failed,
      input.until,
      input.lockouts,
      input.disabledAt,
      ...scopeParams(input.scope),
      input.row.user_id,
      input.row.pin_hash,
    );
  }

  /**
   * A failure that starts a lockout counts one more consecutive lockout; the
   * third disables the record (RT-114 C3). Reported for the audit trail.
   */
  function recordFailure(
    input: Attempt,
    result: { newFailedCount: number; newLockoutUntil: string | null },
  ): void {
    const startsLockout = result.newLockoutUntil !== null;
    const lockouts = startsLockout ? input.row.lockout_count + 1 : input.row.lockout_count;
    const disables = startsLockout && lockouts >= MANAGER_PIN_DISABLE_AFTER_LOCKOUTS;
    setLockout({
      ...input,
      failed: result.newFailedCount,
      until: result.newLockoutUntil,
      lockouts,
      disabledAt: disables ? input.now : null,
    });
    const fact = { scope: input.scope, row: input.row, at: input.now, actor: input.actor };
    if (startsLockout) report('locked_out', fact);
    if (disables) report('disabled', fact);
  }

  /**
   * One record's attempt with the cashier verifier; the lockout state is
   * persisted (on the checked secret only). Null when the seal does not open.
   */
  async function attempt(input: Attempt): Promise<PinVerifyResult | null> {
    const pinRow = unsealed(input.row);
    if (pinRow === null) return null;
    const result = await verifyPinWithWindow(input.pin, pinRow);
    if (result.kind === 'match') {
      setLockout({ ...input, failed: 0, until: null, lockouts: 0, disabledAt: null });
    }
    if (result.kind === 'no_match') recordFailure(input, result);
    return result;
  }

  async function verifyOne(input: VerifyManagerPinInput): Promise<ManagerPinVerdict> {
    const { scope } = input;
    const row = (db.prepare(SELECT_BY_REF) as Get).get(...scopeParams(scope), input.managerRef);
    if (row === undefined) return { kind: 'invalid' };
    if (!isActive(row)) return { kind: 'revoked' };
    if (!isCurrent(row, input.now, input.policy ?? SHIFT_VARIANCE_POLICY)) {
      return { kind: 'expired' };
    }
    return verdictOf(
      row,
      await attempt({ scope, row, pin: input.pin, now: input.now, actor: input.actor }),
    );
  }

  /** P2-2: a replacement needs the record's current PIN. Null when it may go ahead. */
  async function replacementRefusal(input: {
    scope: ManagerPinScope;
    row: StoredRow;
    currentPin: string | undefined;
    now: string;
    actor: CredentialActor | undefined;
  }): Promise<EnrolManagerPinOutcome | null> {
    // RT-438: a disabled or revoked record is re-enrolled without its old PIN;
    // the manager is signed in online with the step-up (the caller's guard).
    if (!isActive(input.row)) return null;
    const { currentPin } = input;
    if (currentPin === undefined) return { kind: 'current_pin_required' };
    const result = await attempt({
      scope: input.scope,
      row: input.row,
      pin: currentPin,
      now: input.now,
      actor: input.actor,
    });
    if (result === null) return { kind: 'current_pin_invalid' };
    return result.kind === 'match' ? null : CURRENT_PIN_REFUSAL[result.kind];
  }

  async function enrolOne(input: EnrolManagerPinInput): Promise<EnrolManagerPinOutcome> {
    const { scope } = input;
    const userId = input.userId.toLowerCase();
    const existing = (db.prepare(SELECT_BY_USER) as Get).get(...scopeParams(scope), userId);
    const refusal =
      existing === undefined
        ? null
        : await replacementRefusal({
            scope,
            row: existing,
            currentPin: input.currentPin,
            now: input.now,
            actor: input.actor,
          });
    if (refusal !== null) return refusal;
    input.guard();
    (db.prepare(UPSERT) as Run).run(
      ...scopeParams(scope),
      userId,
      randomUUID(),
      input.displayName,
      input.sealed.pin_hash,
      input.sealed.pin_salt,
      input.now,
      input.onlineAt,
    );
    const enrolled = (db.prepare(SELECT_BY_USER) as Get).get(...scopeParams(scope), userId);
    if (enrolled !== undefined) {
      report('enrolled', { scope, row: enrolled, at: input.now, actor: input.actor });
    }
    return { kind: 'enrolled' };
  }

  function targetRow(input: RevokeManagerPinInput): StoredRow | undefined {
    const { scope, target } = input;
    return 'managerRef' in target
      ? (db.prepare(SELECT_BY_REF) as Get).get(...scopeParams(scope), target.managerRef)
      : (db.prepare(SELECT_BY_USER) as Get).get(...scopeParams(scope), target.userId.toLowerCase());
  }

  function revokeOne(input: RevokeManagerPinInput): RevokeManagerPinOutcome {
    const { scope } = input;
    const row = targetRow(input);
    if (row === undefined || !isActive(row)) return { kind: 'not_found' };
    const reason = revokeReasonOf(row, input.requesterUserId);
    const { changes } = (db.prepare(REVOKE) as Run).run(
      input.now,
      reason,
      ...scopeParams(scope),
      row.manager_ref,
    );
    if (changes !== 1) return { kind: 'not_found' };
    report('revoked', { scope, row, at: input.now, actor: input.actor }, reason);
    return { kind: 'revoked', reason };
  }

  return {
    async seal(pin) {
      return sealPinMaterial(await hashPin(pin), safeStorage);
    },

    enrol(input) {
      return serialised(() => enrolOne(input));
    },

    verify(input) {
      return serialised(() => verifyOne(input));
    },

    list(input) {
      const policy = input.policy ?? SHIFT_VARIANCE_POLICY;
      const rows = (db.prepare(SELECT_SCOPE) as All).all(...scopeParams(input.scope));
      return rows
        .filter((row) => isActive(row) && isCurrent(row, input.now, policy))
        .filter((row) => input.userId === undefined || row.user_id === input.userId.toLowerCase())
        .map((row) => ({ managerRef: row.manager_ref, displayName: row.display_name }));
    },

    revoke(input) {
      // Review (Codex P2 / CodeRabbit): the guard runs after earlier queued
      // PIN work has settled, right before the write.
      return serialised(() => {
        input.guard?.();
        return Promise.resolve(revokeOne(input));
      });
    },

    touchOnline(input) {
      (db.prepare(TOUCH_ONLINE) as Run).run(
        input.at,
        ...scopeParams(input.scope),
        input.userId.toLowerCase(),
      );
    },
  };
}

/**
 * RT-215 decision 5 — on a re-pair, delete the manager PIN records of every
 * other terminal (they can never be used again: every lookup is keyed on the
 * current terminal). Returns the number deleted; throws on an empty terminal
 * id, which would otherwise match every record.
 */
export function purgeOtherTerminalManagerPinRecords(
  db: Pick<DatabaseHandle, 'prepare'>,
  currentTerminalId: string,
): number {
  if (currentTerminalId.length === 0) {
    throw new Error('purgeOtherTerminalManagerPinRecords: terminal id is required');
  }
  const stmt = db.prepare('DELETE FROM manager_pin_records WHERE terminal_id <> ?') as Run;
  return stmt.run(currentTerminalId).changes;
}

function revokeReasonOf(row: StoredRow, requesterUserId: string | null): ManagerPinRevokeReason {
  if (requesterUserId === null) return 'ineligible';
  return row.user_id === requesterUserId.toLowerCase() ? 'self' : 'other_manager';
}
