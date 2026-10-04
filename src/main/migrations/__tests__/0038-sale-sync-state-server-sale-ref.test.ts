/**
 * RT-15 S1 — migration-shape test for `0038_sale_sync_state_server_sale_ref`.
 *
 * Runs the real 0020 / 0024 / 0034 then 0038 against sql.js (SQLite proper) and
 * asserts the migration only adds a nullable, UUID-shaped `server_sale_ref`:
 *   • it applies cleanly on top of 0034;
 *   • every pre-existing row survives unchanged and reads `server_sale_ref` NULL;
 *   • the column is nullable TEXT; a canonical UUID (either case) is accepted;
 *     a non-UUID value is refused by the CHECK;
 *   • 0034's columns / PK / index are unchanged;
 *   • through the real runner it applies exactly once (a second run is a no-op).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

import { runMigrations, type MigrationFile, type MigrationsDb } from '../../db/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'migrations');

const PREREQS = [
  '0020_create_sales.sql',
  '0024_create_sale_sync_outbox.sql',
  '0034_create_sale_sync_state.sql',
];
const MIGRATION = '0038_sale_sync_state_server_sale_ref.sql';

function migrationSql(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
}

const UUID_LOWER = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const UUID_UPPER = '0190F5A2-7B3C-7D4E-8F90-A1B2C3D4E5F6';

let SQL: SqlJsStatic | undefined;
let db: SqlJsDatabase;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  if (SQL === undefined) throw new Error('initSqlJs() must complete first');
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of PREREQS) db.exec(migrationSql(name));
});

afterEach(() => {
  db.close();
});

function seedSale(id: string): void {
  db.run(
    `INSERT INTO sales (sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id, envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label, selling_operator_id, selling_operator_display_name, selling_operator_session_id, subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json, settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address, local_calendar_day)
     VALUES (?, ?, ?, ?, 'pa', 'c', 't1', 'b1', 'term1', 'Till 1', 'op1', 'Op', 'sess1', 1000, 0, 0, '[]', '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z', 'TRN', 'Branch', 'Addr', '2026-10-04')`,
    [id, `SN-${id}`, `R-${id}`, `h-${id}`],
  );
}

function seedState(id: string, status: string): void {
  db.run(
    `INSERT INTO sale_sync_state (sale_id, tenant_id, branch_id, sync_status, attempt_count, next_retry_at, last_error_category, last_attempt_at, synced_at, created_at, updated_at)
     VALUES (?, 't1', 'b1', ?, 2, NULL, NULL, '2026-10-04T00:00:01Z', '2026-10-04T00:00:02Z', '2026-10-04T00:00:00Z', '2026-10-04T00:00:02Z')`,
    [id, status],
  );
}

function rows(sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function columns(): ColumnInfo[] {
  return rows('PRAGMA table_info(sale_sync_state)').map((r) => ({
    name: r[1] as string,
    type: r[2] as string,
    notnull: r[3] as number,
    pk: r[5] as number,
  }));
}

function setRef(id: string, value: string): void {
  db.run('UPDATE sale_sync_state SET server_sale_ref = ? WHERE sale_id = ?', [value, id]);
}

describe('0038 — sale_sync_state.server_sale_ref (RT-15 S1)', () => {
  it('applies cleanly on top of 0034 and adds a nullable TEXT column', () => {
    db.exec(migrationSql(MIGRATION));
    const col = columns().find((c) => c.name === 'server_sale_ref');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
    expect(col?.pk).toBe(0);
  });

  it('preserves every pre-existing row unchanged, with server_sale_ref NULL', () => {
    seedSale('s-synced');
    seedSale('s-pending');
    seedSale('s-dead');
    seedState('s-synced', 'synced');
    seedState('s-pending', 'pending');
    seedState('s-dead', 'dead_letter');
    const before = rows('SELECT * FROM sale_sync_state ORDER BY sale_id');

    db.exec(migrationSql(MIGRATION));

    const after = rows('SELECT * FROM sale_sync_state ORDER BY sale_id');
    expect(after).toHaveLength(3);
    // The new column is appended last; every original column is byte-identical.
    expect(after.map((r) => r.slice(0, -1))).toEqual(before);
    expect(after.map((r) => r[r.length - 1])).toEqual([null, null, null]);
  });

  it('keeps 0034 columns, primary key and drain index unchanged', () => {
    const beforeCols = columns();
    const beforeIdx = rows('PRAGMA index_list(sale_sync_state)').map((r) => r[1]);
    db.exec(migrationSql(MIGRATION));
    const afterCols = columns();
    expect(afterCols.slice(0, -1)).toEqual(beforeCols);
    expect(afterCols[afterCols.length - 1]?.name).toBe('server_sale_ref');
    expect(rows('PRAGMA index_list(sale_sync_state)').map((r) => r[1])).toEqual(beforeIdx);
  });

  it('accepts NULL and a canonical UUID in either case', () => {
    db.exec(migrationSql(MIGRATION));
    seedSale('s1');
    seedSale('s2');
    seedState('s1', 'synced');
    seedState('s2', 'synced');
    setRef('s1', UUID_LOWER);
    setRef('s2', UUID_UPPER);
    expect(rows(`SELECT server_sale_ref FROM sale_sync_state ORDER BY sale_id`)).toEqual([
      [UUID_LOWER],
      [UUID_UPPER],
    ]);
    db.run(`UPDATE sale_sync_state SET server_sale_ref = NULL WHERE sale_id = 's1'`);
    expect(rows(`SELECT server_sale_ref FROM sale_sync_state WHERE sale_id = 's1'`)).toEqual([
      [null],
    ]);
  });

  it.each([
    ['empty string', ''],
    ['not a uuid', 'sale-ref-1'],
    ['no dashes (32 hex)', '0190f5a27b3c7d4e8f90a1b2c3d4e5f6'],
    ['non-hex character', '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5fZ'],
    ['too long', `${UUID_LOWER}0`],
    ['braced', `{${UUID_LOWER.slice(1, -1)}}`],
    ['dash in the wrong place', '0190f5a27-b3c-7d4e-8f90-a1b2c3d4e5f6'],
    ['extra dash replacing a hex digit', '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5-6'],
  ])('refuses a non-UUID value (%s)', (_label, value) => {
    db.exec(migrationSql(MIGRATION));
    seedSale('s1');
    seedState('s1', 'synced');
    expect(() => {
      setRef('s1', value);
    }).toThrow(/CHECK constraint failed/);
  });

  it('applies exactly once through the real runner (re-run is a no-op)', () => {
    const applied: string[] = [];
    const runnerDb: MigrationsDb = {
      exec: (sql) => {
        db.exec(sql);
      },
      listAppliedNames: () => rows('SELECT name FROM schema_migrations').map((r) => r[0] as string),
      recordApplied: (row) => {
        applied.push(row.name);
        db.run('INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)', [
          row.name,
          row.applied_at,
          row.checksum,
        ]);
      },
      transaction: (fn) => {
        db.exec('BEGIN');
        try {
          const out = fn();
          db.exec('COMMIT');
          return out;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      },
    };
    const files: MigrationFile[] = [
      { name: MIGRATION.replace(/\.sql$/, ''), sql: migrationSql(MIGRATION) },
    ];

    runMigrations({ db: runnerDb, files });
    // A second boot sees it in schema_migrations and skips it; re-executing the
    // ALTER would throw "duplicate column name", so not throwing proves the skip.
    expect(() => {
      runMigrations({ db: runnerDb, files });
    }).not.toThrow();

    expect(applied).toEqual(['0038_sale_sync_state_server_sale_ref']);
    expect(columns().filter((c) => c.name === 'server_sale_ref')).toHaveLength(1);
  });

  it('is not file-level idempotent on its own (the runner is the guard)', () => {
    db.exec(migrationSql(MIGRATION));
    expect(() => {
      db.exec(migrationSql(MIGRATION));
    }).toThrow(/duplicate column name/);
  });
});
