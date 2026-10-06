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
 * No logger: the PIN and the hashes cannot reach a log from this module
 * (PR-1). Nothing here is ever sent to the renderer.
 */
import { randomUUID } from 'node:crypto';

import type { DatabaseHandle } from '../db/client.js';
import type { SafeStorageLike } from '../secrets/safe-storage.js';
import { hashPin, type PinRow, type PinVerifyResult } from './pin-credential.js';
import { verifyPinWithWindow } from './pin-lockout.js';
import { sealPinMaterial, unsealPinMaterial, type SealedPinMaterial } from './pin-seal.js';

export type { SealedPinMaterial };

/** A record is valid this long after the manager's last online sign-in here. */
export const MANAGER_ONLINE_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

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
  | { kind: 'expired' };

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
}

export interface ManagerPinStore {
  /** Hash (Argon2id) and seal a PIN for `enrol`. The PIN is not kept. */
  seal(pin: string): Promise<SealedPinMaterial>;
  enrol(input: EnrolManagerPinInput): Promise<EnrolManagerPinOutcome>;
  verify(input: VerifyManagerPinInput): Promise<ManagerPinVerdict>;
  list(input: { scope: ManagerPinScope; now: string }): EnrolledManager[];
  /** An online manager / admin sign-in on this terminal at `at`. */
  touchOnline(input: { scope: ManagerPinScope; userId: string; at: string }): void;
}

export interface ManagerPinStoreDeps {
  db: Pick<DatabaseHandle, 'prepare'>;
  safeStorage: SafeStorageLike;
}

interface StoredRow {
  user_id: string;
  manager_ref: string;
  display_name: string;
  pin_hash: Uint8Array;
  pin_salt: Uint8Array;
  failed_attempt_count: number;
  lockout_until: string | null;
  last_online_at: string;
}

type Run = { run(...params: unknown[]): { changes: number } };
type Get = { get(...params: unknown[]): StoredRow | undefined };
type All = { all(...params: unknown[]): StoredRow[] };

/** One record's attempt: the scope, the record as read, and the PIN tried. */
interface Attempt {
  scope: ManagerPinScope;
  row: StoredRow;
  pin: string;
}

const COLUMNS = `user_id, manager_ref, display_name, pin_hash, pin_salt,
                 failed_attempt_count, lockout_until, last_online_at`;
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
    last_online_at = excluded.last_online_at`;

/** Nit 7: only on the secret the attempt checked. */
const SET_LOCKOUT = `
  UPDATE manager_pin_records
     SET failed_attempt_count = ?, lockout_until = ?
   WHERE ${IN_SCOPE} AND user_id = ? AND pin_hash = ?`;

const TOUCH_ONLINE = `UPDATE manager_pin_records SET last_online_at = ?
                       WHERE ${IN_SCOPE} AND user_id = ?`;

const CURRENT_PIN_REFUSAL = {
  locked_out: { kind: 'current_pin_locked' },
  no_match: { kind: 'current_pin_invalid' },
} as const;

function scopeParams(scope: ManagerPinScope): [string, string, string] {
  return [scope.tenantId, scope.branchId, scope.terminalId];
}

/**
 * True while `now` is at or after the last online sign-in, and at most the
 * validity after it (round 2: a sign-in in the future is not current).
 */
function isCurrent(row: StoredRow, now: string): boolean {
  const elapsed = Date.parse(now) - Date.parse(row.last_online_at);
  return elapsed >= 0 && elapsed <= MANAGER_ONLINE_VALIDITY_MS;
}

function verdictOf(row: StoredRow, result: PinVerifyResult | null): ManagerPinVerdict {
  if (result?.kind === 'match') return { kind: 'verified', userId: row.user_id };
  return result?.kind === 'locked_out' ? { kind: 'locked' } : { kind: 'invalid' };
}

export function createManagerPinStore(deps: ManagerPinStoreDeps): ManagerPinStore {
  const { db, safeStorage } = deps;
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

  function setLockout(input: Attempt & { failed: number; until: string | null }): void {
    (db.prepare(SET_LOCKOUT) as Run).run(
      input.failed,
      input.until,
      ...scopeParams(input.scope),
      input.row.user_id,
      input.row.pin_hash,
    );
  }

  /**
   * One record's attempt with the cashier verifier; the lockout state is
   * persisted (on the checked secret only). Null when the seal does not open.
   */
  async function attempt(input: Attempt): Promise<PinVerifyResult | null> {
    const pinRow = unsealed(input.row);
    if (pinRow === null) return null;
    const result = await verifyPinWithWindow(input.pin, pinRow);
    if (result.kind === 'match') setLockout({ ...input, failed: 0, until: null });
    if (result.kind === 'no_match') {
      setLockout({ ...input, failed: result.newFailedCount, until: result.newLockoutUntil });
    }
    return result;
  }

  async function verifyOne(input: VerifyManagerPinInput): Promise<ManagerPinVerdict> {
    const { scope } = input;
    const row = (db.prepare(SELECT_BY_REF) as Get).get(...scopeParams(scope), input.managerRef);
    if (row === undefined) return { kind: 'invalid' };
    if (!isCurrent(row, input.now)) return { kind: 'expired' };
    return verdictOf(row, await attempt({ scope, row, pin: input.pin }));
  }

  /** P2-2: a replacement needs the record's current PIN. Null when it may go ahead. */
  async function replacementRefusal(input: {
    scope: ManagerPinScope;
    row: StoredRow;
    currentPin: string | undefined;
  }): Promise<EnrolManagerPinOutcome | null> {
    const { currentPin } = input;
    if (currentPin === undefined) return { kind: 'current_pin_required' };
    const result = await attempt({ scope: input.scope, row: input.row, pin: currentPin });
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
        : await replacementRefusal({ scope, row: existing, currentPin: input.currentPin });
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
    return { kind: 'enrolled' };
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
      const rows = (db.prepare(SELECT_SCOPE) as All).all(...scopeParams(input.scope));
      return rows
        .filter((row) => isCurrent(row, input.now))
        .map((row) => ({ managerRef: row.manager_ref, displayName: row.display_name }));
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
