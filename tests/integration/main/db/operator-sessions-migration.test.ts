import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T065 — operator_sessions migration correctness.
 *
 * Verifies: DDL creates the expected table/indexes/triggers, all CHECK
 * constraints are enforced, the partial unique index enforces single-active-
 * session-per-operator (FR-013), and the conditional UPDATE trigger correctly
 * allows active→ended transitions while freezing ended rows.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATION_SQL = readFileSync(
  path.join(REPO_ROOT, 'migrations', '0005_operator_sessions.sql'),
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

function insertSession(
  db: SqlJsDatabase,
  overrides: Partial<{
    id: string;
    acting_operator_id: string;
    role: string;
    tenant_id: string;
    branch_id: string;
    originating_terminal_id: string;
    start_at: string;
    end_at: string | null;
    end_cause: string | null;
  }> = {},
): void {
  const row = {
    id: 'sess-1',
    acting_operator_id: 'op-abc',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    originating_terminal_id: 'terminal-001',
    start_at: '2026-05-07T08:00:00.000Z',
    end_at: null,
    end_cause: null,
    ...overrides,
  };
  db.run(
    `INSERT INTO operator_sessions
       (id, acting_operator_id, role, tenant_id, branch_id,
        originating_terminal_id, start_at, end_at, end_cause)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.acting_operator_id,
      row.role,
      row.tenant_id,
      row.branch_id,
      row.originating_terminal_id,
      row.start_at,
      row.end_at,
      row.end_cause,
    ],
  );
}

describe('T065 — operator_sessions migration', () => {
  it('migration runs without error and table exists', () => {
    const db = freshDb();
    const result = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='operator_sessions'`,
    );
    expect(result[0]?.values).toHaveLength(1);
    db.close();
  });

  it('partial unique index exists', () => {
    const db = freshDb();
    const result = db.exec(
      `SELECT name FROM sqlite_master
       WHERE type='index' AND name='idx_operator_sessions_one_active_per_operator'`,
    );
    expect(result[0]?.values).toHaveLength(1);
    db.close();
  });

  it('inserts an active session (end_at NULL, end_cause NULL)', () => {
    const db = freshDb();
    expect(() => {
      insertSession(db);
    }).not.toThrow();
    db.close();
  });

  it('inserts an ended session with a valid end_cause', () => {
    const db = freshDb();
    expect(() => {
      insertSession(db, {
        end_at: '2026-05-07T09:00:00.000Z',
        end_cause: 'signed_out',
      });
    }).not.toThrow();
    db.close();
  });

  it('rejects invalid end_cause', () => {
    const db = freshDb();
    expect(() => {
      insertSession(db, {
        end_at: '2026-05-07T09:00:00.000Z',
        end_cause: 'unknown_reason',
      });
    }).toThrow();
    db.close();
  });

  it('accepts all valid end_cause values', () => {
    const validCauses = [
      'signed_out',
      'inactivity_timeout',
      'superseded_by_takeover',
      'terminal_session_terminated',
      'account_disabled_mid_session',
    ] as const;
    for (const [i, cause] of validCauses.entries()) {
      const db = freshDb();
      expect(() => {
        insertSession(db, {
          id: `sess-cause-${String(i)}`,
          end_at: '2026-05-07T09:00:00.000Z',
          end_cause: cause,
        });
      }).not.toThrow();
      db.close();
    }
  });

  it('biconditional: rejects end_at set with end_cause NULL', () => {
    const db = freshDb();
    expect(() => {
      insertSession(db, {
        end_at: '2026-05-07T09:00:00.000Z',
        end_cause: null,
      });
    }).toThrow();
    db.close();
  });

  it('biconditional: rejects end_cause set with end_at NULL', () => {
    const db = freshDb();
    expect(() => {
      insertSession(db, {
        end_at: null,
        end_cause: 'signed_out',
      });
    }).toThrow();
    db.close();
  });

  it('temporal: rejects end_at before start_at', () => {
    const db = freshDb();
    expect(() => {
      insertSession(db, {
        start_at: '2026-05-07T09:00:00.000Z',
        end_at: '2026-05-07T08:00:00.000Z',
        end_cause: 'signed_out',
      });
    }).toThrow();
    db.close();
  });

  it('temporal: allows end_at equal to start_at', () => {
    const db = freshDb();
    expect(() => {
      insertSession(db, {
        start_at: '2026-05-07T08:00:00.000Z',
        end_at: '2026-05-07T08:00:00.000Z',
        end_cause: 'signed_out',
      });
    }).not.toThrow();
    db.close();
  });

  it('partial unique index blocks a second active session for the same operator+tenant', () => {
    const db = freshDb();
    insertSession(db, { id: 'sess-active-1' });
    expect(() => {
      insertSession(db, { id: 'sess-active-2' });
    }).toThrow();
    db.close();
  });

  it('partial unique index allows a second active session for a different operator', () => {
    const db = freshDb();
    insertSession(db, { id: 'sess-op1', acting_operator_id: 'op-1' });
    expect(() => {
      insertSession(db, { id: 'sess-op2', acting_operator_id: 'op-2' });
    }).not.toThrow();
    db.close();
  });

  it('partial unique index allows multiple ended sessions for the same operator+tenant', () => {
    const db = freshDb();
    insertSession(db, {
      id: 'sess-ended-1',
      end_at: '2026-05-07T09:00:00.000Z',
      end_cause: 'signed_out',
    });
    expect(() => {
      insertSession(db, {
        id: 'sess-ended-2',
        end_at: '2026-05-07T10:00:00.000Z',
        end_cause: 'inactivity_timeout',
      });
    }).not.toThrow();
    db.close();
  });

  it('UPDATE trigger allows the active→ended lifecycle transition', () => {
    const db = freshDb();
    insertSession(db, { id: 'sess-transition' });
    expect(() => {
      db.run(
        `UPDATE operator_sessions
         SET end_at = '2026-05-07T09:00:00.000Z', end_cause = 'signed_out'
         WHERE id = 'sess-transition'`,
      );
    }).not.toThrow();
    db.close();
  });

  it('UPDATE trigger blocks UPDATE on an already-ended row', () => {
    const db = freshDb();
    insertSession(db, {
      id: 'sess-ended',
      end_at: '2026-05-07T09:00:00.000Z',
      end_cause: 'signed_out',
    });
    expect(() => {
      db.run(
        `UPDATE operator_sessions
         SET end_cause = 'inactivity_timeout'
         WHERE id = 'sess-ended'`,
      );
    }).toThrow(/ended rows are immutable/);
    db.close();
  });

  it('DELETE trigger fires and blocks DELETE', () => {
    const db = freshDb();
    insertSession(db);
    expect(() => {
      db.run(`DELETE FROM operator_sessions WHERE id = 'sess-1'`);
    }).toThrow(/DELETE is denied/);
    db.close();
  });
});
