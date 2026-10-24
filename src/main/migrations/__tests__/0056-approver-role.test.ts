/**
 * RT-861 — migration-shape test for `0056_approver_role` ([GATED], owner-
 * approved 2026-10-24 in RT-861, widened the same day to the PIN record).
 * On the full stack (sql.js):
 *   • the number right after 0055, and only it;
 *   • `manager_pin_records.role` and `manager_approvals.approver_role` are
 *     appended, nullable, and hold only `manager` or `admin`;
 *   • rows written before 0056 survive with NULL (never a guessed role);
 *   • an approval's role is never edited (the 0048 rule extended);
 *   • the real runner applies it once.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';

import { runMigrations, type MigrationsDb } from '../../db/migrate.js';
import {
  MIGRATIONS_DIR,
  freshGrantDb,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';

const MIGRATION = '0056_approver_role';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const BEFORE_0056 = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql') && f < `${MIGRATION}.sql`)
  .sort((a, b) => a.localeCompare(b));

const USER_ID = '0190f5a2-3b4c-7d8e-9f01-23456789abce';
const REF = '7f3c1e2a-0b4d-4c5e-8f60-123456789abc';
const APPROVAL_ID = '0190f5a2-3b4c-7d8e-9f01-000000000001';

type Row = Record<string, string | number | Uint8Array | null>;

let db: SqlJsDatabase;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  db = freshGrantDb();
});

afterEach(() => {
  db.close();
});

function columns(target: SqlJsDatabase, table: string): string[] {
  return (target.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((r) => String(r[1]));
}

function insertInto(target: SqlJsDatabase, table: string, row: Row): void {
  const keys = Object.keys(row);
  target.run(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    Object.values(row),
  );
}

function pinRecord(over: Row = {}): Row {
  return {
    tenant_id: 't',
    branch_id: 'b',
    terminal_id: 'term',
    user_id: USER_ID,
    manager_ref: REF,
    display_name: 'Mona Manager',
    pin_hash: new Uint8Array([1, 2, 3]),
    pin_salt: new Uint8Array([4, 5, 6]),
    enrolled_at: '2026-10-24T08:00:00.000Z',
    last_online_at: '2026-10-24T08:00:00.000Z',
    ...over,
  };
}

function approval(over: Row = {}): Row {
  return {
    approval_id: APPROVAL_ID,
    tenant_id: 't',
    branch_id: 'b',
    terminal_id: 'term',
    action_kind: 'cart.discount.manual',
    subject_ref: 'cart_line_manual_pct_10',
    subject_version: 'v1',
    amount_minor: 900,
    reason_code: 'promotion',
    reason_note: null,
    requester_operator_id: 'op-1',
    requester_user_id: null,
    approver_user_id: USER_ID,
    policy_version: 'rt114-2026-10-07',
    issued_at: '2026-10-24T09:00:00.000Z',
    expires_at: '2026-10-24T09:02:00.000Z',
    ...over,
  };
}

/** A database migrated up to 0055 only. */
function before0056(): SqlJsDatabase {
  const old = new (db.constructor as new () => SqlJsDatabase)();
  old.exec('PRAGMA foreign_keys = ON;');
  for (const name of BEFORE_0056) old.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  return old;
}

describe('0056 — approver role on PIN records and approvals (RT-861, [GATED])', () => {
  it('takes the number right after 0055, and only it does', () => {
    expect(BEFORE_0056[BEFORE_0056.length - 1]).toBe('0055_sales_finalized_at_index.sql');
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith('0056_'));
    expect(names).toEqual([`${MIGRATION}.sql`]);
  });

  it('appends exactly one column to each table, and alters nothing else', () => {
    const old = before0056();
    const pinBefore = columns(old, 'manager_pin_records');
    const approvalsBefore = columns(old, 'manager_approvals');
    old.close();
    expect(columns(db, 'manager_pin_records')).toEqual([...pinBefore, 'role']);
    expect(columns(db, 'manager_approvals')).toEqual([...approvalsBefore, 'approver_role']);
  });

  it('rows written before 0056 survive with a NULL role', () => {
    const old = before0056();
    insertInto(old, 'manager_pin_records', pinRecord());
    insertInto(old, 'manager_approvals', approval());
    old.exec(SQL_TEXT);
    expect(old.exec('SELECT user_id, role FROM manager_pin_records')[0]?.values).toEqual([
      [USER_ID, null],
    ]);
    expect(old.exec('SELECT approval_id, approver_role FROM manager_approvals')[0]?.values).toEqual(
      [[APPROVAL_ID, null]],
    );
    old.close();
  });

  it.each(['manager', 'admin', null])('accepts the role %j on both tables', (role) => {
    insertInto(db, 'manager_pin_records', pinRecord({ role }));
    insertInto(db, 'manager_approvals', approval({ approver_role: role }));
  });

  it.each(['cashier', '', 'Manager', 'owner'])('refuses the role %j on both tables', (role) => {
    expect(() => {
      insertInto(db, 'manager_pin_records', pinRecord({ role }));
    }).toThrow(/CHECK/);
    expect(() => {
      insertInto(db, 'manager_approvals', approval({ approver_role: role }));
    }).toThrow(/CHECK/);
  });

  it('a PIN record’s role may be refreshed (the online sign-in), but not to a non-manager role', () => {
    insertInto(db, 'manager_pin_records', pinRecord({ role: 'manager' }));
    db.run(`UPDATE manager_pin_records SET role = 'admin'`);
    expect(db.exec('SELECT role FROM manager_pin_records')[0]?.values).toEqual([['admin']]);
    expect(() => {
      db.run(`UPDATE manager_pin_records SET role = 'cashier'`);
    }).toThrow(/CHECK/);
  });

  it.each<[string | null, string | null]>([
    ['manager', 'admin'],
    ['admin', null],
    [null, 'manager'],
  ])('never edits an approval’s role (%j → %j)', (from, to) => {
    insertInto(db, 'manager_approvals', approval({ approver_role: from }));
    expect(() => {
      db.run('UPDATE manager_approvals SET approver_role = ?', [to]);
    }).toThrow(/never edited/);
  });

  it('still consumes an approval once (0048 unchanged)', () => {
    insertInto(db, 'manager_approvals', approval({ approver_role: 'manager' }));
    db.run(`UPDATE manager_approvals SET consumed_at = 'x' WHERE approval_id = ?`, [APPROVAL_ID]);
    expect(db.exec('SELECT consumed_at, approver_role FROM manager_approvals')[0]?.values).toEqual([
      ['x', 'manager'],
    ]);
  });

  it('applies exactly once through the real runner', () => {
    const old = before0056();
    const applied: string[] = [];
    const runnerDb: MigrationsDb = {
      exec: (sql) => {
        old.exec(sql);
      },
      listAppliedNames: () => applied,
      recordApplied: (row) => applied.push(row.name),
      transaction: (fn) => fn(),
    };
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
    expect(columns(old, 'manager_approvals')).toContain('approver_role');
    old.close();
  });
});
