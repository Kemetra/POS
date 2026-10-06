/**
 * RT-17 slice 4 part 2 — the local manager PIN store (option A, Jira RT-17
 * comment 10943; [GATED] migration 0044).
 *
 *   • `seal` + `save` enrol or replace a manager's PIN in a scope (tenant,
 *     branch, terminal — the cashier PIN records' scope). The secret is the
 *     cashier PIN's: an Argon2id PHC string (`hashPin`) sealed with
 *     safeStorage (`sealPinMaterial`). A replace clears the lockout.
 *   • `verify` finds the approver by the PIN alone among the scope's records:
 *     the close payload carries no manager identifier, so nothing a caller
 *     sends or receives tells which managers are enrolled. Each record is
 *     checked with the cashier verifier (`verifyPinWithWindow`, lockout
 *     included):
 *       - exactly one match → `verified` with that record's `users.id`, and
 *         its failure count is cleared;
 *       - no match → `invalid`, and the attempt is a failure on every record
 *         it was checked against (5 failures → 5 minutes, as for a cashier).
 *         A cashier guessing therefore locks the scope's managers out, never
 *         gets more guesses than one manager would allow;
 *       - two or more matches (two managers chose the same PIN) → `invalid`,
 *         nothing counted: the approver would be ambiguous, so it fails
 *         closed rather than picking one;
 *       - every record under lockout (none checked) → `locked`.
 *     A record whose seal does not open is skipped, never counted.
 *   • Attempts are serialised: a verification reads and writes the failure
 *     counts as one step, so concurrent wrong PINs cannot share a count.
 *
 * No logger: the PIN and the hashes cannot reach a log from this module
 * (PR-1). Nothing here is ever sent to the renderer.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { SafeStorageLike } from '../secrets/safe-storage.js';
import { hashPin, type PinRow } from './pin-credential.js';
import { verifyPinWithWindow } from './pin-lockout.js';
import { sealPinMaterial, unsealPinMaterial, type SealedPinMaterial } from './pin-seal.js';

export type { SealedPinMaterial };

/** Where a manager PIN is enrolled and verified: the paired terminal. */
export interface ManagerPinScope {
  tenantId: string;
  branchId: string;
  terminalId: string;
}

export type ManagerPinVerdict =
  | { kind: 'verified'; userId: string }
  | { kind: 'invalid' }
  | { kind: 'locked' };

export interface SaveManagerPinInput {
  scope: ManagerPinScope;
  /** The manager's `users.id` (stored lower-cased). */
  userId: string;
  sealed: SealedPinMaterial;
  /** ISO-8601 instant of the enrolment. */
  now: string;
}

export interface ManagerPinStore {
  /** Hash (Argon2id) and seal a PIN for `save`. The PIN is not kept. */
  seal(pin: string): Promise<SealedPinMaterial>;
  /** Enrol or replace the manager's PIN in the scope; clears its lockout. */
  save(input: SaveManagerPinInput): void;
  /** The manager whose PIN this is, in the scope (see the module header). */
  verify(input: { scope: ManagerPinScope; pin: string }): Promise<ManagerPinVerdict>;
}

export interface ManagerPinStoreDeps {
  db: Pick<DatabaseHandle, 'prepare'>;
  safeStorage: SafeStorageLike;
}

interface StoredRow {
  user_id: string;
  pin_hash: Uint8Array;
  pin_salt: Uint8Array;
  failed_attempt_count: number;
  lockout_until: string | null;
}

type Run = { run(...params: unknown[]): { changes: number } };
type All = { all(...params: unknown[]): StoredRow[] };

/** One record's attempt: its users.id and what the cashier verifier said. */
interface Checked {
  userId: string;
  result: Awaited<ReturnType<typeof verifyPinWithWindow>>;
}

const UPSERT = `
  INSERT INTO manager_pin_records
    (tenant_id, branch_id, terminal_id, user_id, pin_hash, pin_salt,
     failed_attempt_count, lockout_until, enrolled_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)
  ON CONFLICT (tenant_id, branch_id, terminal_id, user_id) DO UPDATE SET
    pin_hash = excluded.pin_hash,
    pin_salt = excluded.pin_salt,
    failed_attempt_count = 0,
    lockout_until = NULL,
    enrolled_at = excluded.enrolled_at`;

const SELECT_SCOPE = `
  SELECT user_id, pin_hash, pin_salt, failed_attempt_count, lockout_until
    FROM manager_pin_records
   WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?
   ORDER BY user_id`;

const SET_LOCKOUT = `
  UPDATE manager_pin_records
     SET failed_attempt_count = ?, lockout_until = ?
   WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND user_id = ?`;

function scopeParams(scope: ManagerPinScope): [string, string, string] {
  return [scope.tenantId, scope.branchId, scope.terminalId];
}

export function createManagerPinStore(deps: ManagerPinStoreDeps): ManagerPinStore {
  const { db, safeStorage } = deps;
  let queue: Promise<unknown> = Promise.resolve();

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

  function setLockout(input: {
    scope: ManagerPinScope;
    userId: string;
    failed: number;
    until: string | null;
  }): void {
    (db.prepare(SET_LOCKOUT) as Run).run(
      input.failed,
      input.until,
      ...scopeParams(input.scope),
      input.userId,
    );
  }

  /** Each openable record of the scope, checked against the PIN in turn. */
  async function checkAll(scope: ManagerPinScope, pin: string): Promise<Checked[]> {
    const rows = (db.prepare(SELECT_SCOPE) as All).all(...scopeParams(scope));
    const checked: Checked[] = [];
    for (const row of rows) {
      const pinRow = unsealed(row);
      if (pinRow === null) continue;
      checked.push({ userId: row.user_id, result: await verifyPinWithWindow(pin, pinRow) });
    }
    return checked;
  }

  /** One attempt (serialised by `verify`): see the module header. */
  async function attempt(scope: ManagerPinScope, pin: string): Promise<ManagerPinVerdict> {
    const checked = await checkAll(scope, pin);
    const matches = checked.filter((c) => c.result.kind === 'match');
    if (matches.length > 1) return { kind: 'invalid' };
    const [match] = matches;
    if (match !== undefined) {
      setLockout({ scope, userId: match.userId, failed: 0, until: null });
      return { kind: 'verified', userId: match.userId };
    }
    for (const { userId, result } of checked) {
      if (result.kind !== 'no_match') continue;
      setLockout({ scope, userId, failed: result.newFailedCount, until: result.newLockoutUntil });
    }
    const allLocked = checked.length > 0 && checked.every((c) => c.result.kind === 'locked_out');
    return allLocked ? { kind: 'locked' } : { kind: 'invalid' };
  }

  return {
    async seal(pin) {
      return sealPinMaterial(await hashPin(pin), safeStorage);
    },

    save(input) {
      (db.prepare(UPSERT) as Run).run(
        ...scopeParams(input.scope),
        input.userId.toLowerCase(),
        input.sealed.pin_hash,
        input.sealed.pin_salt,
        input.now,
      );
    },

    verify(input) {
      const run = queue.then(() => attempt(input.scope, input.pin));
      queue = run.catch(() => undefined);
      return run;
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
