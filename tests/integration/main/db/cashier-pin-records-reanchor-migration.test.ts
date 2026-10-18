import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 017-offline-pin-reanchor T030 + T031 — re-key migration 0036.
 *
 * Re-anchors `cashier_pin_records`'s composite PRIMARY KEY off the
 * provider-coupled `cashier_clerk_user_id` onto the provider-neutral `user_id`
 * (028 §16). SQLite cannot ALTER a PK in place → canonical table-rebuild
 * (CREATE _new keyed on user_id → INSERT…SELECT copy → DROP → RENAME → rebuild
 * the covering index).
 *
 * OQ-D6-1 COLLAPSED (verified 2026-06-14): the ONLY writer of
 * `cashier_pin_records` is 019's provision handler, which ALWAYS sets a
 * non-null `user_id` (born-neutral). No other INSERT exists anywhere; `0006`
 * is DDL, `0035` an ALTER. So when `0036` runs the table holds only
 * non-null-`user_id` rows or is empty — no legacy clerk-only rows, no dual-key
 * window, no backfill. The migration is a direct rebuild to a `user_id NOT NULL`
 * PK; `clerk_user_id` is demoted to a nullable, non-key bridge column (G-3).
 *
 * P3 defensive belt: an unexpected NULL-`user_id` row (which should be
 * impossible) MUST NOT be silently dropped by the copy — the rebuild aborts
 * rather than lose a sealed credential row.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');

function sql(file: string): string {
  return readFileSync(path.join(REPO_ROOT, 'migrations', file), 'utf8');
}

const BASE_SQL = sql('0006_cashier_pin_records.sql');
const ADD_USER_ID_SQL = sql('0035_add_user_id_to_cashier_pin_records.sql');
const REANCHOR_SQL = sql('0036_reanchor_cashier_pin_records.sql');

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

/** Applies 0006 → 0035 (the pre-0036 schema state), mirroring the ordered runner. */
function dbBefore0036(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(BASE_SQL);
  db.run(ADD_USER_ID_SQL);
  return db;
}

/** Applies the full chain including the 0036 re-anchor. */
function dbAfter0036(): SqlJsDatabase {
  const db = dbBefore0036();
  db.run(REANCHOR_SQL);
  return db;
}

/** Seed a born-neutral row (as 019's provision handler writes it). */
function seedBornNeutral(
  db: SqlJsDatabase,
  o: {
    clerk: string;
    userId: string;
    hash: string;
    salt: string;
    failed?: number;
    lockout?: string | null;
  },
): void {
  db.run(
    `INSERT INTO cashier_pin_records
       (tenant_id, branch_id, terminal_id, cashier_clerk_user_id, user_id,
        pin_hash, pin_salt, failed_attempt_count, lockout_until,
        created_at, created_by_operator_id)
     VALUES ('t', 'b', 'term', ?, ?, X'${o.hash}', X'${o.salt}', ?, ?,
             '2026-01-01T00:00:00.000Z', 'mgr')`,
    [o.clerk, o.userId, o.failed ?? 0, o.lockout ?? null],
  );
}

function pkColumns(db: SqlJsDatabase): string[] {
  // pk column index > 0 marks PK membership; order by it.
  const r = db.exec(`PRAGMA table_info(cashier_pin_records)`);
  const rows = (r[0]?.values ?? []) as Array<[number, string, string, number, unknown, number]>;
  return rows
    .filter((row) => row[5] > 0)
    .sort((a, b) => a[5] - b[5])
    .map((row) => row[1]);
}

describe('017 T030 — 0036 re-anchor migration-safety', () => {
  it('target PK is (tenant_id, branch_id, terminal_id, user_id)', () => {
    const db = dbAfter0036();
    expect(pkColumns(db)).toEqual(['tenant_id', 'branch_id', 'terminal_id', 'user_id']);
    db.close();
  });

  it('clerk_user_id is demoted to a NON-key bridge column (still present, not in PK)', () => {
    const db = dbAfter0036();
    const r = db.exec(`PRAGMA table_info(cashier_pin_records)`);
    const cols = (r[0]?.values ?? []).map((row) => row[1] as string);
    expect(cols).toContain('cashier_clerk_user_id');
    expect(pkColumns(db)).not.toContain('cashier_clerk_user_id');
    db.close();
  });

  it('a UNIQUE index covers the runtime-lookup key (tenant,branch,terminal,clerk) — defense-in-depth (review finding #1)', () => {
    // The old 0006 PK enforced one row per (scope, clerk) at the schema level.
    // 0036 demotes clerk to a non-key bridge → that schema guarantee must be
    // restored as a partial UNIQUE index on the column the SELECT/.get() filters
    // on, so a hypothetical app-guard bug can't yield two rows + an arbitrary
    // .get(). This index ALSO covers the lookup (it keys on the exact WHERE tuple).
    const db = dbAfter0036();
    const list = db.exec(`PRAGMA index_list('cashier_pin_records')`);
    // index_list columns: [seq, name, unique, origin, partial]
    const idxRows = (list[0]?.values ?? []) as Array<[number, string, number, string, number]>;
    const uniqueOverClerk = idxRows.some((row) => {
      if (row[2] !== 1) return false; // must be UNIQUE
      const info = db.exec(`PRAGMA index_info('${row[1]}')`);
      const cols = (info[0]?.values ?? []).map((c) => c[2] as string);
      return (
        JSON.stringify(cols) ===
        JSON.stringify(['tenant_id', 'branch_id', 'terminal_id', 'cashier_clerk_user_id'])
      );
    });
    expect(uniqueOverClerk).toBe(true);
    db.close();
  });

  it('the clerk-bridge UNIQUE index enforces one row per (scope, clerk) — the invariant the old PK guaranteed', () => {
    const db = dbAfter0036();
    seedBornNeutral(db, { clerk: 'clerk-dup', userId: 'neutral-1', hash: 'aabb', salt: 'ccdd' });
    // Same (scope, clerk) but a DIFFERENT user_id must STILL collide — proving the
    // runtime lookup key is schema-unique, not merely app-guarded.
    expect(() => {
      seedBornNeutral(db, { clerk: 'clerk-dup', userId: 'neutral-2', hash: 'eeff', salt: '0011' });
    }).toThrow();
    db.close();
  });

  it('new PK enforces uniqueness on user_id (same user_id+scope collides)', () => {
    const db = dbAfter0036();
    seedBornNeutral(db, { clerk: 'clerk-1', userId: 'neutral-A', hash: 'aabb', salt: 'ccdd' });
    expect(() => {
      seedBornNeutral(db, { clerk: 'clerk-2', userId: 'neutral-A', hash: 'eeff', salt: '0011' });
    }).toThrow(); // same (t,b,term,user_id) → PK collision even with a different clerk id
    db.close();
  });

  it('carries no transaction-wrap opt-out marker (runs inside the runner default wrap)', () => {
    // cashier_pin_records has NO FK constraints (unlike 0019's payment_attempts),
    // so the rebuild needs no `PRAGMA foreign_keys = OFF` / `@no-wrap-transaction`
    // dance — the runner's default db.transaction() wrap gives atomic, crash-safe,
    // roll-back-on-error semantics (the P3 fail-loud guarantee). Single-run is the
    // runner's job (skip-by-name in schema_migrations), as for 0019/0035.
    // The runner scans only the first 10 lines for the opt-out marker
    // (src/main/db/migrate.ts). The marker, if present, is its own `--` line —
    // not prose mentioning it. Assert no marker-as-directive in the scan window.
    const first10 = REANCHOR_SQL.split('\n').slice(0, 10);
    expect(first10.some((l) => l.trim() === '-- @no-wrap-transaction')).toBe(false);
    // No actual BEGIN/COMMIT *statement* (the words appear only in comment prose).
    const code = REANCHOR_SQL.split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/\bBEGIN\s*;/i);
    expect(code).not.toMatch(/\bCOMMIT\s*;/i);
  });
});

describe('017 T031 — 0036 copy fidelity (no stranded cashier; P3)', () => {
  it('preserves pin_hash/pin_salt/failed_attempt_count/lockout_until byte-identical across the rebuild', () => {
    const db = dbBefore0036();
    seedBornNeutral(db, {
      clerk: 'clerk-keep',
      userId: 'neutral-keep',
      hash: 'deadbeef',
      salt: 'cafef00d',
      failed: 3,
      lockout: '2026-02-02T02:02:02.000Z',
    });
    db.run(REANCHOR_SQL);
    const r = db.exec(
      `SELECT hex(pin_hash), hex(pin_salt), failed_attempt_count, lockout_until, cashier_clerk_user_id
         FROM cashier_pin_records WHERE user_id='neutral-keep'`,
    );
    const row = r[0]?.values[0];
    expect(row?.[0]).toBe('DEADBEEF'); // hash byte-identical
    expect(row?.[1]).toBe('CAFEF00D'); // salt byte-identical
    expect(row?.[2]).toBe(3); // lockout counter preserved
    expect(row?.[3]).toBe('2026-02-02T02:02:02.000Z'); // lockout_until preserved
    expect(row?.[4]).toBe('clerk-keep'); // clerk id retained on the bridge column
    db.close();
  });

  it('every pre-rebuild row survives (row count unchanged — no silent drop)', () => {
    const db = dbBefore0036();
    seedBornNeutral(db, { clerk: 'c1', userId: 'u1', hash: 'aa', salt: 'bb' });
    seedBornNeutral(db, { clerk: 'c2', userId: 'u2', hash: 'cc', salt: 'dd' });
    db.run(REANCHOR_SQL);
    const r = db.exec(`SELECT COUNT(*) FROM cashier_pin_records`);
    expect(r[0]?.values[0]?.[0]).toBe(2);
    db.close();
  });
});
