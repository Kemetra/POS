/**
 * RT-15 S2 — migration-shape test for `0039_create_return_journal` (§A2).
 *
 * Runs the full migration stack on sql.js (SQLite proper) and asserts:
 *   • the two tables, their columns and indexes exist; existing tables are untouched;
 *   • CHECKs refuse a malformed externalId / saleRef / lineRef / currency /
 *     amount / quantity, and confirmed facts exist exactly in confirmed states;
 *   • the state machine: only pending→{pending,unknown,confirmed,refused},
 *     unknown→{unknown,confirmed,refused}, confirmed→paid_out; refused and
 *     paid_out are terminal;
 *   • identity + stored request are immutable; a confirmation is written once;
 *   • no DELETE of a header; lines are append-only; FKs hold;
 *   • through the real runner it applies exactly once.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as SqlJsDatabase } from 'sql.js';

import { runMigrations, type MigrationsDb } from '../../db/migrate.js';
import {
  freshSalesSyncDb,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = '0039_create_return_journal';
const SQL_TEXT = readFileSync(
  path.resolve(__dirname, '..', '..', '..', '..', 'migrations', `${MIGRATION}.sql`),
  'utf8',
);

const REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const KEY = `pos-pulse-return:${REF}`;

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-1' });
});

afterEach(() => {
  db.close();
});

type Row = Record<string, string | number | null>;

const BASE: Row = {
  return_id: 'r1',
  tenant_id: 't',
  branch_id: 'b',
  terminal_id: 'term',
  sale_id: 'sale-1',
  sale_number: 'SN-1',
  server_sale_ref: REF,
  external_id: KEY,
  operator_id: 'op',
  operator_session_id: 'sess',
  currency_code: 'EGP',
  quoted_total_minor: 1500,
  request_body_json: '{}',
  state: 'pending',
  created_at: 't0',
  updated_at: 't0',
};

function insert(overrides: Row = {}): void {
  const row = { ...BASE, ...overrides };
  const cols = Object.keys(row);
  db.run(
    `INSERT INTO return_journal (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    Object.values(row),
  );
}

/** A SET clause applied to r1. */
interface Change {
  readonly set: string;
}

function update(change: Change): void {
  if (change.set.includes(`state = 'paid_out'`)) completePayoutIfConfirmed();
  db.run(`UPDATE return_journal SET ${change.set} WHERE return_id = 'r1'`);
}

/**
 * RT-15 S4 (0040): the header reaches paid_out only with a completed
 * `return_payouts` row, which can exist only for a confirmed header. A move
 * to paid_out from any other state is still refused (by either trigger).
 */
function completePayoutIfConfirmed(): void {
  const state = db.exec(`SELECT state FROM return_journal WHERE return_id = 'r1'`)[0]
    ?.values[0]?.[0];
  if (state !== 'confirmed') return;
  db.run(
    `INSERT OR IGNORE INTO return_payouts (return_id, started_operator_id, started_session_id,
       started_at) VALUES ('r1', 'op', 'sess', 't2')`,
  );
  db.run(
    `UPDATE return_payouts SET paid_operator_id = 'op', paid_session_id = 'sess', paid_at = 't2',
       method = 'manual' WHERE return_id = 'r1' AND paid_at IS NULL`,
  );
}

type JournalState = 'pending' | 'unknown' | 'confirmed' | 'refused' | 'paid_out';
type TableName = 'return_journal' | 'return_journal_lines';

const CONFIRM: Change = {
  set: `state = 'confirmed', return_ref = '${REF}', return_total_minor = 1500, confirmed_at = 't1'`,
};
const SETS: Readonly<Record<JournalState, Change>> = {
  pending: { set: `state = 'pending'` },
  unknown: { set: `state = 'unknown'` },
  confirmed: CONFIRM,
  refused: { set: `state = 'refused', refusal_reason = 'over_return'` },
  paid_out: { set: `state = 'paid_out', paid_out_at = 't2'` },
};

/** The legal path from a fresh pending row to each state. */
const PATHS: Readonly<Record<JournalState, readonly Change[]>> = {
  pending: [],
  unknown: [SETS.unknown],
  refused: [SETS.refused],
  confirmed: [CONFIRM],
  paid_out: [CONFIRM, SETS.paid_out],
};

/** Put r1 into `state` through legal transitions. */
function reach(state: JournalState): void {
  insert();
  PATHS[state].forEach(update);
}

function columns(table: TableName): string[] {
  return (db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((r) => String(r[1]));
}

describe('0039 — return journal (RT-15 S2)', () => {
  it('creates both tables with their columns and indexes', () => {
    expect(columns('return_journal')).toEqual(
      expect.arrayContaining([...Object.keys(BASE), 'return_ref', 'paid_out_at', 'attempt_count']),
    );
    expect(columns('return_journal_lines')).toEqual(['return_id', 'line_ref', 'quantity']);
    const indexes = (db.exec(`PRAGMA index_list(return_journal)`)[0]?.values ?? []).map((r) =>
      String(r[1]),
    );
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_return_journal_scope_state', 'idx_return_journal_sale']),
    );
  });

  it.each<[string, Row]>([
    ['an externalId without the prefix', { external_id: `pos-pulse:${REF}` }],
    ['a short externalId', { external_id: 'pos-pulse-return:1' }],
    ['a non-UUID saleRef', { server_sale_ref: 'not-a-uuid-not-a-uuid-not-a-uuid-123' }],
    ['a lowercase currency', { currency_code: 'egp' }],
    ['a negative quoted total', { quoted_total_minor: -1 }],
    ['an unknown state', { state: 'done' }],
    ['confirmed without server facts', { state: 'confirmed' }],
    ['refused without a reason', { state: 'refused' }],
    ['a return_ref while pending', { return_ref: REF }],
    ['an unknown sale', { sale_id: 'sale-404' }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => {
      insert(overrides);
    }).toThrow(/constraint failed/i);
  });

  it('refuses a duplicate externalId', () => {
    insert();
    expect(() => {
      insert({ return_id: 'r2' });
    }).toThrow(/UNIQUE/);
  });

  it.each<[JournalState, JournalState, boolean]>([
    ['pending', 'pending', true],
    ['pending', 'unknown', true],
    ['pending', 'confirmed', true],
    ['pending', 'refused', true],
    ['pending', 'paid_out', false],
    ['unknown', 'unknown', true],
    ['unknown', 'confirmed', true],
    ['unknown', 'refused', true],
    ['unknown', 'pending', false],
    ['confirmed', 'paid_out', true],
    ['confirmed', 'refused', false],
    ['confirmed', 'unknown', false],
    ['refused', 'confirmed', false],
    ['refused', 'pending', false],
    ['paid_out', 'confirmed', false],
  ])('%s → %s allowed: %s', (from, to, allowed) => {
    reach(from);
    const run = (): void => {
      update(SETS[to]);
    };
    if (allowed) expect(run).not.toThrow();
    else
      expect(run).toThrow(
        /illegal state transition|constraint failed|immutable|paid_out needs a completed payout/,
      );
  });

  it.each([
    'sale_id',
    'external_id',
    'request_body_json',
    'quoted_total_minor',
    'operator_session_id',
  ])('keeps %s immutable', (column) => {
    insert();
    expect(() => {
      update({ set: `${column} = ${column}` });
    }).toThrow(/immutable/);
  });

  it('writes a confirmation once: its facts never change, even into paid_out', () => {
    reach('confirmed');
    expect(() => {
      update({ set: `return_total_minor = 1400` });
    }).toThrow(/immutable/);
    expect(() => {
      update({
        set: `state = 'paid_out', paid_out_at = 't2', return_ref = '${REF.replace('f6', 'f7')}'`,
      });
    }).toThrow(/immutable/);
  });

  it('never deletes a header; lines are append-only and need a header', () => {
    insert();
    db.run(`INSERT INTO return_journal_lines (return_id, line_ref, quantity) VALUES ('r1', ?, 2)`, [
      REF,
    ]);
    expect(() => db.run(`DELETE FROM return_journal`)).toThrow(/DELETE is denied/);
    expect(() => db.run(`UPDATE return_journal_lines SET quantity = 3`)).toThrow(/append-only/);
    expect(() => db.run(`DELETE FROM return_journal_lines`)).toThrow(/append-only/);
    expect(() => db.run(`INSERT INTO return_journal_lines VALUES ('r1', 'bad-ref', 1)`)).toThrow(
      /constraint failed/,
    );
    expect(() =>
      db.run(`INSERT INTO return_journal_lines VALUES ('r1', ?, 0)`, [REF.replace('f6', 'f0')]),
    ).toThrow(/constraint failed/);
    expect(() => db.run(`INSERT INTO return_journal_lines VALUES ('r404', ?, 1)`, [REF])).toThrow(
      /header must be pending and unsent/,
    );
  });

  it.each<[string, JournalState, Change | null]>([
    ['an attempted pending header', 'pending', { set: 'attempt_count = 1' }],
    ['an unknown header', 'unknown', null],
    ['a confirmed header', 'confirmed', null],
    ['a refused header', 'refused', null],
    ['a paid-out header', 'paid_out', null],
  ])('refuses a line added to %s (P2-2)', (_label, state, extra) => {
    reach(state);
    if (extra !== null) update(extra);
    expect(() => db.run(`INSERT INTO return_journal_lines VALUES ('r1', ?, 1)`, [REF])).toThrow(
      /header must be pending and unsent/,
    );
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
    db.exec('DROP TABLE return_journal_lines; DROP TABLE return_journal;');
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
    expect(columns('return_journal')).toContain('external_id');
  });
});
