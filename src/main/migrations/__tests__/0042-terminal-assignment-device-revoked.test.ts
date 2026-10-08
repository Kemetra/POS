/**
 * RT-215 — migration-shape test for `0042_terminal_assignment_device_revoked`.
 *
 * Runs the real 0003 / 0027 then 0042 against sql.js (SQLite proper) and
 * asserts the migration only adds a nullable `device_revoked_at` column:
 *   • it applies cleanly on top of 0027 and is the latest migration on disk;
 *   • the pre-existing pairing row survives unchanged and reads NULL;
 *   • the column is a nullable INTEGER (unix epoch seconds, like `paired_at`);
 *     a non-negative integer is accepted, anything else is refused;
 *   • a re-pair (`INSERT OR REPLACE`, the store's write) resets it to NULL;
 *   • through the real runner it applies exactly once.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

import { runMigrations, type MigrationFile, type MigrationsDb } from '../../db/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'migrations');

const MIGRATION_FILES = {
  assignment: '0003_terminal_assignment',
  extend: '0027_extend_terminal_assignment',
  deviceRevoked: '0042_terminal_assignment_device_revoked',
} as const;
type MigrationKey = keyof typeof MIGRATION_FILES;

const PREREQS: readonly MigrationKey[] = ['assignment', 'extend'];

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

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
  PREREQS.forEach(applyMigration);
});

afterEach(() => {
  db.close();
});

/** The store's own write: INSERT OR REPLACE of the single row (a pair or re-pair). */
function writePairing(terminalId: string): void {
  db.run(
    `INSERT OR REPLACE INTO terminal_assignment
       (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at,
        branch_name, branch_address, tenant_tax_registration_id,
        printer_vendor_id, printer_product_id, printer_com_port)
     VALUES (1, 't1', 'b1', ?, 'Till 1', 1700000000, 'Branch', 'Addr', 'TRN', NULL, NULL, NULL)`,
    [terminalId],
  );
}

function setRevokedAt(value: unknown): void {
  db.run('UPDATE terminal_assignment SET device_revoked_at = ? WHERE id = 1', [
    value as number | string | null,
  ]);
}

function firstResult(sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

const rows = (): unknown[][] => firstResult('SELECT * FROM terminal_assignment');
const revokedAt = (): unknown =>
  firstResult('SELECT device_revoked_at FROM terminal_assignment WHERE id = 1')[0]?.[0];

function columns(): ColumnInfo[] {
  return firstResult('PRAGMA table_info(terminal_assignment)').map((r) => ({
    name: r[1] as string,
    type: r[2] as string,
    notnull: r[3] as number,
    pk: r[5] as number,
  }));
}

function sqlJsRunnerDb(recorded: { names: string[] }): MigrationsDb {
  return {
    exec: db.exec.bind(db),
    listAppliedNames: () =>
      firstResult('SELECT name FROM schema_migrations').map((r) => r[0] as string),
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

describe('0042 — terminal_assignment.device_revoked_at (RT-215)', () => {
  it('takes the number right after 0041 (RT113-P1.1), and only it does', () => {
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    const i = names.indexOf(`${MIGRATION_FILES.deviceRevoked}.sql`);
    expect(names[i - 1]).toBe('0041_create_cashier_offline_grants.sql');
    expect(names.filter((n) => n.startsWith('0042_'))).toEqual([
      `${MIGRATION_FILES.deviceRevoked}.sql`,
    ]);
  });

  it('applies cleanly on top of 0027 and adds a nullable INTEGER column, last', () => {
    const before = columns();
    applyMigration('deviceRevoked');
    const after = columns();
    expect(after.slice(0, -1)).toEqual(before);
    const col = after.at(-1);
    expect(col?.name).toBe('device_revoked_at');
    expect(col?.type).toBe('INTEGER');
    expect(col?.notnull).toBe(0);
    expect(col?.pk).toBe(0);
  });

  it('keeps the existing pairing row byte-identical, with device_revoked_at NULL', () => {
    writePairing('term-1');
    const before = rows();
    applyMigration('deviceRevoked');
    const after = rows();
    expect(after.map((r) => r.slice(0, -1))).toEqual(before);
    expect(revokedAt()).toBeNull();
  });

  it('accepts a non-negative integer and NULL', () => {
    applyMigration('deviceRevoked');
    writePairing('term-1');
    setRevokedAt(1_760_000_000);
    expect(revokedAt()).toBe(1_760_000_000);
    setRevokedAt(0);
    expect(revokedAt()).toBe(0);
    setRevokedAt(null);
    expect(revokedAt()).toBeNull();
  });

  it.each<{ label: string; value: unknown }>([
    { label: 'negative', value: -1 },
    { label: 'text', value: '2026-10-05T00:00:00Z' },
    { label: 'real', value: 1.5 },
  ])('refuses a non-epoch-seconds value ($label)', ({ value }) => {
    applyMigration('deviceRevoked');
    writePairing('term-1');
    expect(() => {
      setRevokedAt(value);
    }).toThrow(/CHECK constraint failed/);
  });

  it('a re-pair (INSERT OR REPLACE) resets device_revoked_at to NULL', () => {
    applyMigration('deviceRevoked');
    writePairing('term-1');
    setRevokedAt(1_760_000_000);
    writePairing('term-2');
    expect(revokedAt()).toBeNull();
  });

  it('applies exactly once through the real runner (re-run is a no-op)', () => {
    const recorded = { names: [] as string[] };
    const runnerDb = sqlJsRunnerDb(recorded);
    const files = [readMigration('deviceRevoked')];
    runMigrations({ db: runnerDb, files });
    expect(() => {
      runMigrations({ db: runnerDb, files });
    }).not.toThrow();
    expect(recorded.names).toEqual([MIGRATION_FILES.deviceRevoked]);
    expect(columns().filter((c) => c.name === 'device_revoked_at')).toHaveLength(1);
  });

  it('is not file-level idempotent on its own (the runner is the guard)', () => {
    applyMigration('deviceRevoked');
    expect(() => {
      applyMigration('deviceRevoked');
    }).toThrow(/duplicate column name/);
  });
});
