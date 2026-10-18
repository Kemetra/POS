import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 019-cashier-pin-provisioning T004 — additive `user_id` column migration.
 *
 * Verifies migration 0035 adds a NULLABLE, non-key `user_id TEXT` column to
 * `cashier_pin_records` (R-1): 019-created rows populate it; legacy rows keep
 * it NULL until 017's re-anchor backfill. The PK is unchanged in 019 (017
 * re-keys later), so the column must be insertable-as-NULL and the existing
 * composite PK must still reject duplicates. Re-running the migration is
 * idempotent (the runner may replay).
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');

const BASE_SQL = readFileSync(
  path.join(REPO_ROOT, 'migrations', '0006_cashier_pin_records.sql'),
  'utf8',
);
const USER_ID_SQL = readFileSync(
  path.join(REPO_ROOT, 'migrations', '0035_add_user_id_to_cashier_pin_records.sql'),
  'utf8',
);

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

/** Applies 0006 then 0035, mirroring the ordered migration runner. */
function migratedDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(BASE_SQL);
  db.run(USER_ID_SQL);
  return db;
}

function columnNames(db: SqlJsDatabase): string[] {
  const result = db.exec(`PRAGMA table_info(cashier_pin_records)`);
  return (result[0]?.values ?? []).map((row) => row[1] as string);
}

describe('019 T004 — cashier_pin_records.user_id additive column (0035)', () => {
  it('adds a user_id column to the table', () => {
    const db = migratedDb();
    expect(columnNames(db)).toContain('user_id');
    db.close();
  });

  it('user_id is nullable — a row may be inserted without it (legacy row → NULL)', () => {
    const db = migratedDb();
    expect(() => {
      db.run(
        `INSERT INTO cashier_pin_records
           (tenant_id, branch_id, terminal_id, cashier_clerk_user_id,
            pin_hash, pin_salt, failed_attempt_count, lockout_until,
            created_at, created_by_operator_id)
         VALUES ('t', 'b', 'term', 'legacy-clerk', X'aabb', X'ccdd', 0, NULL,
                 '2026-01-01T00:00:00.000Z', 'mgr')`,
      );
    }).not.toThrow();
    const result = db.exec(`SELECT user_id FROM cashier_pin_records WHERE tenant_id='t'`);
    // Column present, value NULL for a row inserted without it.
    expect(result[0]?.values[0]?.[0]).toBeNull();
    db.close();
  });

  it('user_id can be populated on a born-neutral 019 row', () => {
    const db = migratedDb();
    db.run(
      `INSERT INTO cashier_pin_records
         (tenant_id, branch_id, terminal_id, cashier_clerk_user_id, user_id,
          pin_hash, pin_salt, failed_attempt_count, lockout_until,
          created_at, created_by_operator_id)
       VALUES ('t', 'b', 'term', 'clerk-xyz', 'neutral-uuid-123', X'aabb', X'ccdd', 0, NULL,
               '2026-01-01T00:00:00.000Z', 'mgr')`,
    );
    const result = db.exec(`SELECT user_id FROM cashier_pin_records WHERE tenant_id='t'`);
    expect(result[0]?.values[0]?.[0]).toBe('neutral-uuid-123');
    db.close();
  });

  it('user_id is NOT in the primary key — the existing composite PK still governs uniqueness', () => {
    const db = migratedDb();
    // Same (tenant, branch, terminal, cashier_clerk_user_id) but different user_id
    // must STILL collide on the unchanged PK (proves user_id is non-key in 019).
    db.run(
      `INSERT INTO cashier_pin_records
         (tenant_id, branch_id, terminal_id, cashier_clerk_user_id, user_id,
          pin_hash, pin_salt, failed_attempt_count, lockout_until,
          created_at, created_by_operator_id)
       VALUES ('t', 'b', 'term', 'clerk-1', 'neutral-A', X'aabb', X'ccdd', 0, NULL,
               '2026-01-01T00:00:00.000Z', 'mgr')`,
    );
    expect(() => {
      db.run(
        `INSERT INTO cashier_pin_records
           (tenant_id, branch_id, terminal_id, cashier_clerk_user_id, user_id,
            pin_hash, pin_salt, failed_attempt_count, lockout_until,
            created_at, created_by_operator_id)
         VALUES ('t', 'b', 'term', 'clerk-1', 'neutral-B', X'aabb', X'ccdd', 0, NULL,
                 '2026-01-01T00:00:00.000Z', 'mgr')`,
      );
    }).toThrow();
    db.close();
  });

  it('adds exactly one user_id column (no duplicate on a single apply)', () => {
    const db = migratedDb();
    const userIdCols = columnNames(db).filter((c) => c === 'user_id');
    expect(userIdCols).toHaveLength(1);
    db.close();
  });

  it('carries no transaction-wrap opt-out marker (runs inside the runner default wrap)', () => {
    // 0035 is a single ALTER TABLE ADD COLUMN — it needs no manual BEGIN/COMMIT,
    // so it MUST NOT carry the `-- @no-wrap-transaction` marker. Re-apply
    // protection is the runner's job (skip-by-name in schema_migrations), exactly
    // as for the sibling additive migrations 0027/0028 — the file itself is a
    // plain ALTER, not file-level idempotent (SQLite has no ADD COLUMN IF NOT EXISTS).
    expect(USER_ID_SQL).not.toContain('@no-wrap-transaction');
  });
});
