import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T064 — cashier_pin_records migration correctness.
 *
 * Verifies: DDL creates the expected table, composite PK rejects duplicates,
 * pin_hash/pin_salt are BLOB NOT NULL, failed_attempt_count has the right
 * default and constraint, and no raw-PIN column exists.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATION_SQL = readFileSync(
  path.join(REPO_ROOT, 'migrations', '0006_cashier_pin_records.sql'),
  'utf8',
);

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(MIGRATION_SQL);
  return db;
}

function insertPin(
  db: SqlJsDatabase,
  overrides: Partial<{
    tenant_id: string;
    branch_id: string;
    terminal_id: string;
    cashier_clerk_user_id: string;
    pin_hash: Uint8Array;
    pin_salt: Uint8Array;
    failed_attempt_count: number | null;
    lockout_until: string | null;
    created_at: string;
    created_by_operator_id: string;
  }> = {},
): void {
  const row = {
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-001',
    cashier_clerk_user_id: 'cashier-clerk-xyz',
    pin_hash: new Uint8Array(32).fill(0xaa),
    pin_salt: new Uint8Array(16).fill(0xbb),
    failed_attempt_count: 0,
    lockout_until: null,
    created_at: '2026-05-07T08:00:00.000Z',
    created_by_operator_id: 'manager-abc',
    ...overrides,
  };
  db.run(
    `INSERT INTO cashier_pin_records
       (tenant_id, branch_id, terminal_id, cashier_clerk_user_id,
        pin_hash, pin_salt, failed_attempt_count, lockout_until,
        created_at, created_by_operator_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.tenant_id,
      row.branch_id,
      row.terminal_id,
      row.cashier_clerk_user_id,
      row.pin_hash,
      row.pin_salt,
      row.failed_attempt_count,
      row.lockout_until,
      row.created_at,
      row.created_by_operator_id,
    ],
  );
}

describe('T064 — cashier_pin_records migration', () => {
  it('migration runs without error and table exists', () => {
    const db = freshDb();
    const result = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='cashier_pin_records'`,
    );
    expect(result[0]?.values).toHaveLength(1);
    db.close();
  });

  it('inserts a valid PIN record', () => {
    const db = freshDb();
    expect(() => {
      insertPin(db);
    }).not.toThrow();
    db.close();
  });

  it('composite PK rejects a duplicate (tenant, branch, terminal, cashier)', () => {
    const db = freshDb();
    insertPin(db);
    expect(() => {
      insertPin(db);
    }).toThrow();
    db.close();
  });

  it('composite PK allows the same cashier on a different terminal (PR-4)', () => {
    const db = freshDb();
    insertPin(db, { terminal_id: 'terminal-001' });
    expect(() => {
      insertPin(db, { terminal_id: 'terminal-002' });
    }).not.toThrow();
    db.close();
  });

  it('composite PK allows different cashiers on the same terminal', () => {
    const db = freshDb();
    insertPin(db, { cashier_clerk_user_id: 'cashier-1' });
    expect(() => {
      insertPin(db, { cashier_clerk_user_id: 'cashier-2' });
    }).not.toThrow();
    db.close();
  });

  it('schema has no raw-PIN column (PRAGMA table_info assertion)', () => {
    const db = freshDb();
    const result = db.exec(`PRAGMA table_info(cashier_pin_records)`);
    const columnNames = (result[0]?.values ?? []).map((row) => row[1] as string);
    const forbidden = ['pin', 'pin_plaintext', 'raw_pin', 'pin_value', 'pin_text'];
    for (const col of forbidden) {
      expect(columnNames).not.toContain(col);
    }
    db.close();
  });

  it('pin_hash and pin_salt columns exist', () => {
    const db = freshDb();
    const result = db.exec(`PRAGMA table_info(cashier_pin_records)`);
    const columnNames = (result[0]?.values ?? []).map((row) => row[1] as string);
    expect(columnNames).toContain('pin_hash');
    expect(columnNames).toContain('pin_salt');
    db.close();
  });

  it('rejects NULL pin_hash', () => {
    const db = freshDb();
    expect(() => {
      db.run(
        `INSERT INTO cashier_pin_records
           (tenant_id, branch_id, terminal_id, cashier_clerk_user_id,
            pin_hash, pin_salt, failed_attempt_count, lockout_until,
            created_at, created_by_operator_id)
         VALUES ('t', 'b', 'term', 'cashier', NULL,
                 X'aabbccdd', 0, NULL, '2026-01-01T00:00:00.000Z', 'mgr')`,
      );
    }).toThrow();
    db.close();
  });

  it('rejects NULL pin_salt', () => {
    const db = freshDb();
    expect(() => {
      db.run(
        `INSERT INTO cashier_pin_records
           (tenant_id, branch_id, terminal_id, cashier_clerk_user_id,
            pin_hash, pin_salt, failed_attempt_count, lockout_until,
            created_at, created_by_operator_id)
         VALUES ('t', 'b', 'term', 'cashier', X'aabbccdd',
                 NULL, 0, NULL, '2026-01-01T00:00:00.000Z', 'mgr')`,
      );
    }).toThrow();
    db.close();
  });

  it('failed_attempt_count defaults to 0', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO cashier_pin_records
         (tenant_id, branch_id, terminal_id, cashier_clerk_user_id,
          pin_hash, pin_salt, lockout_until,
          created_at, created_by_operator_id)
       VALUES ('t', 'b', 'term', 'cashier', X'aabb', X'ccdd',
               NULL, '2026-01-01T00:00:00.000Z', 'mgr')`,
    );
    const result = db.exec(
      `SELECT failed_attempt_count FROM cashier_pin_records WHERE tenant_id='t'`,
    );
    expect(result[0]?.values[0]?.[0]).toBe(0);
    db.close();
  });

  it('rejects negative failed_attempt_count', () => {
    const db = freshDb();
    expect(() => {
      insertPin(db, { failed_attempt_count: -1 });
    }).toThrow();
    db.close();
  });

  it('lockout_until is nullable', () => {
    const db = freshDb();
    expect(() => {
      insertPin(db, { lockout_until: null });
    }).not.toThrow();
    db.close();
  });

  it('lockout_until accepts a timestamp string', () => {
    const db = freshDb();
    expect(() => {
      insertPin(db, { lockout_until: '2026-05-07T08:10:00.000Z' });
    }).not.toThrow();
    db.close();
  });

  it('pin_hash round-trips as BLOB bytes', () => {
    const db = freshDb();
    const expectedHash = new Uint8Array(32).fill(0xde);
    insertPin(db, { pin_hash: expectedHash });
    const result = db.exec(`SELECT pin_hash FROM cashier_pin_records WHERE tenant_id='tenant-1'`);
    const retrieved = result[0]?.values[0]?.[0];
    expect(retrieved).toBeInstanceOf(Uint8Array);
    expect(retrieved).toEqual(expectedHash);
    db.close();
  });
});
