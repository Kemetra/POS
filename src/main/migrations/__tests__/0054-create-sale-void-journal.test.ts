/**
 * RT-530 — migration-shape test for `0054_create_sale_void_journal` ([GATED],
 * owner-authorized on RT-530 comment 11988). On the full stack (sql.js):
 *   • the number right after 0053, and only it;
 *   • well-formed ids, codes, days and amounts, a bounded external id;
 *   • one live void per sale and one void per approval;
 *   • the state machine, the immutable evidence and the never-deleted rows;
 *   • the real runner applies it once.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';

import { runMigrations, type MigrationsDb } from '../../db/migrate.js';
import {
  freshSalesSyncDb,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { MIGRATIONS_DIR } from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';

const MIGRATION = '0054_create_sale_void_journal';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const UUID = (n: number): string => `0190f5a2-3b4c-7d8e-9f01-${String(n).padStart(12, '0')}`;

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-1' });
  seedSale(db, { sale_id: 'sale-2' });
});

afterEach(() => {
  db.close();
});

type Cell = string | number | null;

function insert(over: Record<string, Cell> = {}): void {
  const row: Record<string, Cell> = {
    void_id: 'v1',
    tenant_id: 't',
    branch_id: 'b',
    terminal_id: 'term',
    sale_id: 'sale-1',
    sale_number: 'SN-1',
    external_id: `pos-pulse-void:${UUID(1)}`,
    approval_id: UUID(2),
    approver_user_id: UUID(3),
    requester_user_id: UUID(4),
    requester_operator_id: 'op-1',
    requester_display_name: 'Rana',
    operator_session_id: 'sess-1',
    approval_policy_version: 'rt114-2026-10-07',
    approved_at: '2026-06-07T10:05:00.000Z',
    business_date: '2026-06-07',
    amount_minor: 1500,
    cash_minor: 1500,
    currency_code: 'EGP',
    state: 'pending',
    requested_at: '2026-06-07T10:06:00.000Z',
    updated_at: '2026-06-07T10:06:00.000Z',
    ...over,
  };
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO sale_void_journal (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    Object.values(row),
  );
}

const run = (sql: string): void => {
  db.run(sql);
};

describe('0054 - sale void journal (RT-530, [GATED])', () => {
  it('takes the number right after 0053, and only it does', () => {
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    const i = names.indexOf(`${MIGRATION}.sql`);
    expect(names[i - 1]).toBe('0053_return_payouts_method_no_drawer.sql');
    expect(names.filter((n) => n.startsWith('0054_'))).toEqual([`${MIGRATION}.sql`]);
  });

  it('stores a well-formed pending void', () => {
    insert();
    expect(db.exec('SELECT COUNT(*) FROM sale_void_journal')[0]?.values[0]?.[0]).toBe(1);
  });

  it.each<[string, Record<string, Cell>]>([
    ['a short approval id', { approval_id: 'a-1' }],
    ['a short approver id', { approver_user_id: 'u-1' }],
    ['a short requester id', { requester_user_id: 'u-2' }],
    ['an external id with the wrong prefix', { external_id: `pos-pulse-return:${UUID(1)}` }],
    ['a truncated external id', { external_id: 'pos-pulse-void:short' }],
    ['a malformed business day', { business_date: '07/06/2026' }],
    ['a negative amount', { amount_minor: -1 }],
    ['a negative cash', { cash_minor: -1 }],
    ['a lower-case currency', { currency_code: 'egp' }],
    ['an unknown state', { state: 'sent' }],
    ['an empty policy version', { approval_policy_version: '' }],
    ['a refusal reason on a pending void', { refusal_reason: 'conflict' }],
    ['a refused void without a reason', { state: 'refused' }],
    ['a confirmed void without a reference', { state: 'confirmed' }],
  ])('refuses %s', (_label, over) => {
    expect(() => {
      insert(over);
    }).toThrow(/CHECK/);
  });

  it('allows one live void per sale, and one void per approval', () => {
    insert();
    expect(() => {
      insert({ void_id: 'v2', external_id: `pos-pulse-void:${UUID(5)}`, approval_id: UUID(6) });
    }).toThrow(/UNIQUE/);
    expect(() => {
      insert({ void_id: 'v3', sale_id: 'sale-2', external_id: `pos-pulse-void:${UUID(7)}` });
    }).toThrow(/UNIQUE/);
  });

  it('frees the sale once its void is refused', () => {
    insert();
    run(`UPDATE sale_void_journal SET state = 'refused', refusal_reason = 'conflict'`);
    expect(() => {
      insert({ void_id: 'v2', external_id: `pos-pulse-void:${UUID(5)}`, approval_id: UUID(6) });
    }).not.toThrow();
  });

  it('follows the state machine: pending -> unknown -> confirmed, then fixed', () => {
    insert();
    run(`UPDATE sale_void_journal SET state = 'unknown'`);
    run(`UPDATE sale_void_journal SET state = 'confirmed', void_ref = 'evt', confirmed_at = 't'`);
    expect(() => {
      run(`UPDATE sale_void_journal SET state = 'pending'`);
    }).toThrow(/illegal state transition/);
    expect(() => {
      run(`UPDATE sale_void_journal SET void_ref = 'other'`);
    }).toThrow(/immutable/);
  });

  it('sets a refused outcome once, and acknowledges it once', () => {
    insert();
    run(`UPDATE sale_void_journal SET state = 'refused', refusal_reason = 'conflict'`);
    run(`UPDATE sale_void_journal SET acknowledged_at = 'a'`);
    expect(() => {
      run(`UPDATE sale_void_journal SET acknowledged_at = 'b'`);
    }).toThrow(/immutable/);
    expect(() => {
      run(`UPDATE sale_void_journal SET refusal_reason = 'validation_error'`);
    }).toThrow(/immutable/);
  });

  it('cannot acknowledge a void that is not final', () => {
    insert();
    expect(() => {
      run(`UPDATE sale_void_journal SET acknowledged_at = 'a'`);
    }).toThrow(/CHECK/);
  });

  it.each([
    'approval_id',
    'approver_user_id',
    'requester_user_id',
    'approval_policy_version',
    'approved_at',
    'business_date',
    'amount_minor',
    'cash_minor',
    'sale_id',
    'external_id',
  ])('never lets the evidence %s be edited', (column) => {
    insert();
    expect(() => {
      run(`UPDATE sale_void_journal SET ${column} = ${column}`);
    }).toThrow(/immutable/);
  });

  it('never deletes a row', () => {
    insert();
    expect(() => {
      run('DELETE FROM sale_void_journal');
    }).toThrow(/DELETE is denied/);
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
    db.exec(
      `DROP TRIGGER trg_sale_void_journal_no_delete;
       DROP TRIGGER trg_sale_void_journal_identity_immutable;
       DROP TRIGGER trg_sale_void_journal_state_guard;
       DROP TRIGGER trg_sale_void_journal_outcome_immutable;
       DROP TABLE sale_void_journal;`,
    );
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
  });
});
