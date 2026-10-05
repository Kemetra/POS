import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import { freshGrantDb, handleFor, initGrantSql } from './__helpers__/offline-grant-fixture.js';
import { purgeOtherTerminalPinRecords } from '../pin-records-purge.js';

/**
 * RT-215 decision 5 — on a re-pair, `cashier_pin_records` that belong to a
 * DIFFERENT terminal are deleted. The new pairing always has a new
 * terminal_id (RT-138 L5), so the old PINs can never be used again; keeping
 * them only keeps PIN hashes of an identity this till no longer holds.
 *
 * Runs on the full migration stack (sql.js) through the production
 * `DatabaseHandle` adapter.
 */

let raw: SqlJsDatabase;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  raw = freshGrantDb();
});

afterEach(() => {
  raw.close();
});

function seedPin(terminal_id: string, user_id: string): void {
  raw.run(
    `INSERT INTO cashier_pin_records
       (tenant_id, branch_id, terminal_id, user_id, cashier_clerk_user_id, pin_hash, pin_salt,
        failed_attempt_count, lockout_until, created_at, created_by_operator_id)
     VALUES ('t1', 'b1', ?, ?, NULL, X'01', X'02', 0, NULL, '2026-10-05T00:00:00Z', 'user_mgr')`,
    [terminal_id, user_id],
  );
}

function pinTerminals(): unknown[] {
  return (
    raw.exec('SELECT terminal_id FROM cashier_pin_records ORDER BY terminal_id, user_id')[0]
      ?.values ?? []
  ).map((r) => r[0]);
}

describe('purgeOtherTerminalPinRecords (RT-215)', () => {
  it('deletes the PIN records of every other terminal and keeps the current one', () => {
    seedPin('term-old', 'u1');
    seedPin('term-old', 'u2');
    seedPin('term-older', 'u1');
    seedPin('term-new', 'u3');
    const deleted = purgeOtherTerminalPinRecords(handleFor(raw), 'term-new');
    expect(deleted).toBe(3);
    expect(pinTerminals()).toEqual(['term-new']);
  });

  it('is a no-op on a first pairing (nothing to delete)', () => {
    expect(purgeOtherTerminalPinRecords(handleFor(raw), 'term-new')).toBe(0);
  });

  it('refuses an empty terminal id rather than deleting everything', () => {
    seedPin('term-old', 'u1');
    expect(() => purgeOtherTerminalPinRecords(handleFor(raw), '')).toThrow();
    expect(pinTerminals()).toEqual(['term-old']);
  });
});
