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
 *
 * Helpers take typed option objects / closed-set keys rather than bare strings.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

import { runMigrations, type MigrationFile, type MigrationsDb } from '../../db/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'migrations');

/** The migrations this test touches, by role. */
const MIGRATION_FILES = {
  sales: '0020_create_sales',
  outbox: '0024_create_sale_sync_outbox',
  syncState: '0034_create_sale_sync_state',
  serverSaleRef: '0038_sale_sync_state_server_sale_ref',
} as const;
type MigrationKey = keyof typeof MIGRATION_FILES;

const PREREQS: readonly MigrationKey[] = ['sales', 'outbox', 'syncState'];

type SyncStatus = 'pending' | 'synced' | 'dead_letter';

interface SeedRowInput {
  saleId: string;
  status: SyncStatus;
}

interface SetRefInput {
  saleId: string;
  ref: string | null;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

const UUID_LOWER = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const UUID_UPPER = '0190F5A2-7B3C-7D4E-8F90-A1B2C3D4E5F6';

let SQL: SqlJsStatic | undefined;
let db: SqlJsDatabase;

function readMigration(key: MigrationKey): MigrationFile {
  const name = MIGRATION_FILES[key];
  return { name, sql: readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8') };
}

function applyMigration(key: MigrationKey): void {
  db.exec(readMigration(key).sql);
}

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  if (SQL === undefined) throw new Error('initSqlJs() must complete first');
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  PREREQS.forEach(applyMigration);
});

afterEach(() => {
  db.close();
});

/** Seed a parent `sales` row and its `sale_sync_state` row (FK-consistent). */
function seedRow({ saleId, status }: SeedRowInput): void {
  db.run(
    `INSERT INTO sales (sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id, envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label, selling_operator_id, selling_operator_display_name, selling_operator_session_id, subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json, settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address, local_calendar_day)
     VALUES (?, ?, ?, ?, 'pa', 'c', 't1', 'b1', 'term1', 'Till 1', 'op1', 'Op', 'sess1', 1000, 0, 0, '[]', '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z', 'TRN', 'Branch', 'Addr', '2026-10-04')`,
    [saleId, `SN-${saleId}`, `R-${saleId}`, `h-${saleId}`],
  );
  db.run(
    `INSERT INTO sale_sync_state (sale_id, tenant_id, branch_id, sync_status, attempt_count, next_retry_at, last_error_category, last_attempt_at, synced_at, created_at, updated_at)
     VALUES (?, 't1', 'b1', ?, 2, NULL, NULL, '2026-10-04T00:00:01Z', '2026-10-04T00:00:02Z', '2026-10-04T00:00:00Z', '2026-10-04T00:00:02Z')`,
    [saleId, status],
  );
}

function setServerSaleRef({ saleId, ref }: SetRefInput): void {
  db.run('UPDATE sale_sync_state SET server_sale_ref = ? WHERE sale_id = ?', [ref, saleId]);
}

function firstResult(query: { sql: string }): unknown[][] {
  return db.exec(query.sql)[0]?.values ?? [];
}

const stateRows = (): unknown[][] =>
  firstResult({ sql: 'SELECT * FROM sale_sync_state ORDER BY sale_id' });
const serverSaleRefs = (): unknown[] =>
  firstResult({ sql: 'SELECT server_sale_ref FROM sale_sync_state ORDER BY sale_id' }).map(
    (r) => r[0],
  );
const indexNames = (): unknown[] =>
  firstResult({ sql: 'PRAGMA index_list(sale_sync_state)' }).map((r) => r[1]);
const appliedNames = (): string[] =>
  firstResult({ sql: 'SELECT name FROM schema_migrations' }).map((r) => r[0] as string);

function columns(): ColumnInfo[] {
  return firstResult({ sql: 'PRAGMA table_info(sale_sync_state)' }).map((r) => ({
    name: r[1] as string,
    type: r[2] as string,
    notnull: r[3] as number,
    pk: r[5] as number,
  }));
}

/** A `MigrationsDb` over the current sql.js handle, recording each applied name. */
function sqlJsRunnerDb(recorded: { names: string[] }): MigrationsDb {
  return {
    exec: db.exec.bind(db),
    listAppliedNames: appliedNames,
    recordApplied: (row) => {
      recorded.names.push(row.name);
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
}

describe('0038 — sale_sync_state.server_sale_ref (RT-15 S1)', () => {
  it('applies cleanly on top of 0034 and adds a nullable TEXT column', () => {
    applyMigration('serverSaleRef');
    const col = columns().find((c) => c.name === 'server_sale_ref');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
    expect(col?.pk).toBe(0);
  });

  it('preserves every pre-existing row unchanged, with server_sale_ref NULL', () => {
    seedRow({ saleId: 's-synced', status: 'synced' });
    seedRow({ saleId: 's-pending', status: 'pending' });
    seedRow({ saleId: 's-dead', status: 'dead_letter' });
    const before = stateRows();

    applyMigration('serverSaleRef');

    const after = stateRows();
    expect(after).toHaveLength(3);
    // The new column is appended last; every original column is byte-identical.
    expect(after.map((r) => r.slice(0, -1))).toEqual(before);
    expect(serverSaleRefs()).toEqual([null, null, null]);
  });

  it('keeps 0034 columns, primary key and drain index unchanged', () => {
    const beforeCols = columns();
    const beforeIdx = indexNames();
    applyMigration('serverSaleRef');
    const afterCols = columns();
    expect(afterCols.slice(0, -1)).toEqual(beforeCols);
    expect(afterCols[afterCols.length - 1]?.name).toBe('server_sale_ref');
    expect(indexNames()).toEqual(beforeIdx);
  });

  it('accepts NULL and a canonical UUID in either case', () => {
    applyMigration('serverSaleRef');
    seedRow({ saleId: 's1', status: 'synced' });
    seedRow({ saleId: 's2', status: 'synced' });
    setServerSaleRef({ saleId: 's1', ref: UUID_LOWER });
    setServerSaleRef({ saleId: 's2', ref: UUID_UPPER });
    expect(serverSaleRefs()).toEqual([UUID_LOWER, UUID_UPPER]);
    setServerSaleRef({ saleId: 's1', ref: null });
    expect(serverSaleRefs()).toEqual([null, UUID_UPPER]);
  });

  it.each<{ label: string; value: string }>([
    { label: 'empty string', value: '' },
    { label: 'not a uuid', value: 'sale-ref-1' },
    { label: 'no dashes (32 hex)', value: '0190f5a27b3c7d4e8f90a1b2c3d4e5f6' },
    { label: 'non-hex character', value: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5fZ' },
    { label: 'too long', value: `${UUID_LOWER}0` },
    { label: 'braced', value: `{${UUID_LOWER.slice(1, -1)}}` },
    { label: 'dash in the wrong place', value: '0190f5a27-b3c-7d4e-8f90-a1b2c3d4e5f6' },
    { label: 'extra dash replacing a hex digit', value: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5-6' },
  ])('refuses a non-UUID value ($label)', ({ value }) => {
    applyMigration('serverSaleRef');
    seedRow({ saleId: 's1', status: 'synced' });
    expect(() => {
      setServerSaleRef({ saleId: 's1', ref: value });
    }).toThrow(/CHECK constraint failed/);
  });

  it('applies exactly once through the real runner (re-run is a no-op)', () => {
    const recorded = { names: [] as string[] };
    const runnerDb = sqlJsRunnerDb(recorded);
    const files = [readMigration('serverSaleRef')];

    runMigrations({ db: runnerDb, files });
    // A second boot sees it in schema_migrations and skips it; re-executing the
    // ALTER would throw "duplicate column name", so not throwing proves the skip.
    expect(() => {
      runMigrations({ db: runnerDb, files });
    }).not.toThrow();

    expect(recorded.names).toEqual([MIGRATION_FILES.serverSaleRef]);
    expect(columns().filter((c) => c.name === 'server_sale_ref')).toHaveLength(1);
  });

  it('is not file-level idempotent on its own (the runner is the guard)', () => {
    applyMigration('serverSaleRef');
    expect(() => {
      applyMigration('serverSaleRef');
    }).toThrow(/duplicate column name/);
  });
});
