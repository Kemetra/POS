import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T089 prerequisite — shifts migration correctness.
 *
 * Verifies: DDL creates the expected table/indexes, lifecycle_state CHECK
 * is enforced, the closed_at biconditional holds, and the declared_count
 * NULL-on-forced-close constraint is enforced (FR-024(a) blind-close).
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATION_SQL = readFileSync(path.join(REPO_ROOT, 'migrations', '0007_shifts.sql'), 'utf8');

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(MIGRATION_SQL);
  return db;
}

function insertShift(
  db: SqlJsDatabase,
  overrides: Partial<{
    id: string;
    tenant_id: string;
    branch_id: string;
    originating_terminal_id: string;
    opening_operator_id: string;
    lifecycle_state: string;
    declared_count: number | null;
    opened_at: string;
    closed_at: string | null;
  }> = {},
): void {
  const row = {
    id: 'shift-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    originating_terminal_id: 'terminal-001',
    opening_operator_id: 'op-abc',
    lifecycle_state: 'open',
    declared_count: null,
    opened_at: '2026-05-12T08:00:00.000Z',
    closed_at: null,
    ...overrides,
  };
  db.run(
    `INSERT INTO shifts
       (id, tenant_id, branch_id, originating_terminal_id,
        opening_operator_id, lifecycle_state, declared_count, opened_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenant_id,
      row.branch_id,
      row.originating_terminal_id,
      row.opening_operator_id,
      row.lifecycle_state,
      row.declared_count,
      row.opened_at,
      row.closed_at,
    ],
  );
}

describe('T089-pre — shifts migration', () => {
  it('migration runs without error and table exists', () => {
    const db = freshDb();
    const result = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='shifts'`);
    expect(result[0]?.values).toHaveLength(1);
    db.close();
  });

  it('branch-open index exists', () => {
    const db = freshDb();
    const result = db.exec(
      `SELECT name FROM sqlite_master
       WHERE type='index' AND name='idx_shifts_branch_open'`,
    );
    expect(result[0]?.values).toHaveLength(1);
    db.close();
  });

  it('opening-operator index exists', () => {
    const db = freshDb();
    const result = db.exec(
      `SELECT name FROM sqlite_master
       WHERE type='index' AND name='idx_shifts_opening_operator'`,
    );
    expect(result[0]?.values).toHaveLength(1);
    db.close();
  });

  it('inserts an open shift', () => {
    const db = freshDb();
    expect(() => {
      insertShift(db);
    }).not.toThrow();
    db.close();
  });

  it('inserts a closed_normal shift with declared_count', () => {
    const db = freshDb();
    expect(() => {
      insertShift(db, {
        lifecycle_state: 'closed_normal',
        declared_count: 12500,
        closed_at: '2026-05-12T16:00:00.000Z',
      });
    }).not.toThrow();
    db.close();
  });

  it('inserts a closed_forced shift with declared_count = null (FR-024(a))', () => {
    const db = freshDb();
    expect(() => {
      insertShift(db, {
        lifecycle_state: 'closed_forced',
        declared_count: null,
        closed_at: '2026-05-12T12:00:00.000Z',
      });
    }).not.toThrow();
    db.close();
  });

  it('rejects invalid lifecycle_state', () => {
    const db = freshDb();
    expect(() => {
      insertShift(db, { lifecycle_state: 'reviewed' });
    }).toThrow();
    db.close();
  });

  it('rejects open shift with closed_at set', () => {
    const db = freshDb();
    expect(() => {
      insertShift(db, {
        lifecycle_state: 'open',
        closed_at: '2026-05-12T16:00:00.000Z',
      });
    }).toThrow();
    db.close();
  });

  it('rejects closed_normal without closed_at', () => {
    const db = freshDb();
    expect(() => {
      insertShift(db, {
        lifecycle_state: 'closed_normal',
        declared_count: 12500,
        closed_at: null,
      });
    }).toThrow();
    db.close();
  });

  it('rejects closed_forced without closed_at', () => {
    const db = freshDb();
    expect(() => {
      insertShift(db, {
        lifecycle_state: 'closed_forced',
        declared_count: null,
        closed_at: null,
      });
    }).toThrow();
    db.close();
  });

  it('rejects closed_forced with non-null declared_count (FR-024(a))', () => {
    const db = freshDb();
    expect(() => {
      insertShift(db, {
        lifecycle_state: 'closed_forced',
        declared_count: 0,
        closed_at: '2026-05-12T12:00:00.000Z',
      });
    }).toThrow();
    db.close();
  });

  it('lifecycle transition (open → closed_forced) via UPDATE is allowed', () => {
    const db = freshDb();
    insertShift(db, { id: 'shift-transition' });
    expect(() => {
      db.run(
        `UPDATE shifts
         SET lifecycle_state = 'closed_forced',
             declared_count  = NULL,
             closed_at       = '2026-05-12T12:00:00.000Z'
         WHERE id = 'shift-transition'`,
      );
    }).not.toThrow();
    db.close();
  });
});
