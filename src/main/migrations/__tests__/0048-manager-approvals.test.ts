/**
 * RT-443 (MA-2) — migration-shape test for `0048_manager_approvals` ([GATED],
 * owner-approved 2026-10-12). On the full stack (sql.js):
 *   • the number right after 0047, and only it;
 *   • the approval columns, with bounded ids, codes and amounts;
 *   • consumed once, never edited, never deleted (triggers);
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

const MIGRATION = '0048_manager_approvals';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const ID = '0190f5a2-3b4c-7d8e-9f01-000000000001';

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

function insert(over: Record<string, string | number | null> = {}): void {
  const row: Record<string, string | number | null> = {
    approval_id: ID,
    tenant_id: 't',
    branch_id: 'b',
    terminal_id: 'term',
    action_kind: 'cart.cancel_post_handoff',
    subject_ref: 'cart-1',
    subject_version: 'handoff:h-1',
    amount_minor: 12500,
    reason_code: 'customer_left',
    reason_note: null,
    requester_operator_id: 'op-1',
    requester_user_id: null,
    approver_user_id: 'u-mgr',
    policy_version: 'rt114-2026-10-07',
    issued_at: '2026-10-13T09:00:00.000Z',
    expires_at: '2026-10-13T09:02:00.000Z',
    ...over,
  };
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO manager_approvals (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    Object.values(row),
  );
}

describe('0048 — manager approvals (RT-443, [GATED])', () => {
  it('takes the number right after 0047, and only it does', () => {
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    const i = names.indexOf(`${MIGRATION}.sql`);
    expect(names[i - 1]).toBe('0047_manager_pin_records_lifecycle.sql');
    expect(names.filter((n) => n.startsWith('0048_'))).toEqual([`${MIGRATION}.sql`]);
  });

  it('stores a well-formed approval, the amount optional', () => {
    insert();
    insert({ approval_id: '0190f5a2-3b4c-7d8e-9f01-000000000002', amount_minor: null });
    expect(db.exec('SELECT COUNT(*) FROM manager_approvals')[0]?.values[0]?.[0]).toBe(2);
  });

  it.each<[string, Record<string, string | number | null>]>([
    ['an upper-case id', { approval_id: ID.toUpperCase() }],
    ['a short id', { approval_id: 'a-1' }],
    ['a negative amount', { amount_minor: -1 }],
    ['a fractional amount', { amount_minor: 1.5 }],
    ['an empty subject', { subject_ref: '' }],
    ['a long reason code', { reason_code: 'r'.repeat(41) }],
    ['a long note', { reason_note: 'n'.repeat(201) }],
    ['an empty approver', { approver_user_id: '' }],
  ])('refuses %s', (_l, over) => {
    expect(() => {
      insert(over);
    }).toThrow(/CHECK/);
  });

  it('consumes an approval once, and never again', () => {
    insert();
    db.run(`UPDATE manager_approvals SET consumed_at = 'x' WHERE approval_id = ?`, [ID]);
    expect(() => {
      db.run(`UPDATE manager_approvals SET consumed_at = 'y' WHERE approval_id = ?`, [ID]);
    }).toThrow(/consumed once/);
  });

  it.each(['subject_version', 'amount_minor', 'approver_user_id', 'expires_at'])(
    'never lets %s be edited',
    (column) => {
      insert();
      expect(() => {
        db.run(
          `UPDATE manager_approvals SET ${column} = ${column === 'amount_minor' ? '1' : "'z'"}`,
        );
      }).toThrow(/never edited/);
    },
  );

  it('never deletes an approval', () => {
    insert();
    expect(() => {
      db.run('DELETE FROM manager_approvals');
    }).toThrow(/append-only/);
  });

  it('applies exactly once through the real runner', () => {
    const applied: string[] = [];
    const runnerDb: MigrationsDb = {
      exec: (sql) => {
        db.exec(sql);
      },
      listAppliedNames: () => applied,
      recordApplied: (row) => applied.push(row.name),
      transaction: (fn) => fn(),
    };
    db.exec('DROP TRIGGER trg_manager_approvals_no_delete; DROP TABLE manager_approvals;');
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
  });
});
