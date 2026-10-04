/**
 * RT-15 S4 — migration-shape test for `0040_create_return_payouts` (§A2).
 *
 * Runs the full migration stack on sql.js and asserts (invariant X6):
 *   • `return_payouts`: a payout can be started only for a `confirmed` header
 *     and only unpaid; its start facts are immutable; it is completed once,
 *     with all paid facts together; it is never deleted; one row per return;
 *   • `return_journal_line_details`: the slip facts of a journaled line, written
 *     only with the line while the header is pending and unsent; append-only;
 *   • nothing existing is altered (0039's tables keep their exact columns);
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
const MIGRATION = '0040_create_return_payouts';
const SQL_TEXT = readFileSync(
  path.resolve(__dirname, '..', '..', '..', '..', 'migrations', `${MIGRATION}.sql`),
  'utf8',
);

const REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const LINE = '0190f5a2-7b3c-7d4e-8f90-00000000000a';

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

type Header = 'pending' | 'unknown' | 'confirmed' | 'refused' | 'paid_out';

const TO_STATE: Readonly<Record<Header, readonly string[]>> = {
  pending: [],
  unknown: [`state = 'unknown'`],
  refused: [`state = 'refused', refusal_reason = 'over_return'`],
  confirmed: [
    `state = 'confirmed', return_ref = '${REF}', return_total_minor = 1500, confirmed_at = 't1'`,
  ],
  paid_out: [
    `state = 'confirmed', return_ref = '${REF}', return_total_minor = 1500, confirmed_at = 't1'`,
    // 0040: the header reaches paid_out only with a completed payout row.
    'PAYOUT',
    `state = 'paid_out', paid_out_at = 't2'`,
  ],
};

/** A journaled return r1 with one line, moved to `state` through legal transitions. */
function journal(state: Header): void {
  db.run(
    `INSERT INTO return_journal (return_id, tenant_id, branch_id, terminal_id, sale_id,
       sale_number, server_sale_ref, external_id, operator_id, operator_session_id,
       currency_code, quoted_total_minor, request_body_json, state, created_at, updated_at)
     VALUES ('r1', 't', 'b', 'term', 'sale-1', 'SN-1', ?, ?, 'op', 'sess', 'EGP', 1500, '{}',
       'pending', 't0', 't0')`,
    [REF, `pos-pulse-return:${REF}`],
  );
  db.run(`INSERT INTO return_journal_lines (return_id, line_ref, quantity) VALUES ('r1', ?, 1)`, [
    LINE,
  ]);
  for (const set of TO_STATE[state]) {
    if (set === 'PAYOUT') {
      startPayout();
      db.run(`UPDATE return_payouts SET ${PAID} WHERE return_id = 'r1'`);
    } else {
      db.run(`UPDATE return_journal SET ${set} WHERE return_id = 'r1'`);
    }
  }
}

function startPayout(returnId = 'r1'): void {
  db.run(
    `INSERT INTO return_payouts (return_id, started_operator_id, started_session_id, started_at)
     VALUES (?, 'op-m', 'sess-m', 't3')`,
    [returnId],
  );
}

const PAID = `paid_operator_id = 'op-m', paid_operator_name = 'Manager', paid_session_id = 'sess-m',
  paid_at = 't4', method = 'manual'`;

/** Move r1's payout kick state (the drawer kick record) by one UPDATE. */
function kick(set: string): void {
  db.run(`UPDATE return_payouts SET ${set} WHERE return_id = 'r1'`);
}

const SENDING_1 = `kick_outcome = 'sending', kick_count = 1, kicked_at = 'k1'`;

function columns(table: string): string[] {
  return (db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((r) => String(r[1]));
}

describe('0040 — return payouts (RT-15 S4)', () => {
  it('creates the two tables and leaves 0039 as it was', () => {
    expect(columns('return_payouts')).toEqual([
      'return_id',
      'started_operator_id',
      'started_session_id',
      'started_at',
      'paid_operator_id',
      'paid_operator_name',
      'paid_session_id',
      'paid_at',
      'method',
      'kick_outcome',
      'kick_count',
      'kicked_at',
    ]);
    expect(columns('return_journal_line_details')).toEqual([
      'return_id',
      'line_ref',
      'line_name',
      'amount_minor',
    ]);
    expect(columns('return_journal_lines')).toEqual(['return_id', 'line_ref', 'quantity']);
  });

  it.each<Header>(['pending', 'unknown', 'refused'])(
    'refuses to start a payout for a %s return',
    (state) => {
      journal(state);
      expect(() => {
        startPayout();
      }).toThrow(/only for a confirmed return/);
    },
  );

  it('a paid-out return gets no second payout row', () => {
    journal('paid_out');
    expect(() => {
      startPayout();
    }).toThrow(/only for a confirmed return|UNIQUE|PRIMARY KEY/);
  });

  it('P1: the header reaches paid_out only with a completed payout row', () => {
    journal('confirmed');
    const toPaidOut = (): void => {
      db.run(
        `UPDATE return_journal SET state = 'paid_out', paid_out_at = 't9' WHERE return_id = 'r1'`,
      );
    };
    expect(toPaidOut).toThrow(/needs a completed payout/);
    startPayout();
    expect(toPaidOut).toThrow(/needs a completed payout/);
    db.run(`UPDATE return_payouts SET ${PAID}`);
    expect(toPaidOut).not.toThrow();
  });

  it.each<[string, string[], string, boolean]>([
    ['never kicked → sending (first kick)', [], SENDING_1, true],
    ['sending → opened', [SENDING_1], `kick_outcome = 'opened'`, true],
    ['sending → failed_before_send', [SENDING_1], `kick_outcome = 'failed_before_send'`, true],
    ['sending → unknown', [SENDING_1], `kick_outcome = 'unknown'`, true],
    [
      'failed_before_send → sending (a retry)',
      [SENDING_1, `kick_outcome = 'failed_before_send'`],
      `kick_outcome = 'sending', kick_count = 2, kicked_at = 'k2'`,
      true,
    ],
    [
      'opened → sending (a second kick after an opening)',
      [SENDING_1, `kick_outcome = 'opened'`],
      `kick_outcome = 'sending', kick_count = 2, kicked_at = 'k2'`,
      false,
    ],
    [
      'unknown → sending (a second kick after an unknown)',
      [SENDING_1, `kick_outcome = 'unknown'`],
      `kick_outcome = 'sending', kick_count = 2, kicked_at = 'k2'`,
      false,
    ],
    ['sending → sending without counting the kick', [SENDING_1], `kicked_at = 'k2'`, false],
    [
      'opened → failed_before_send',
      [SENDING_1, `kick_outcome = 'opened'`],
      `kick_outcome = 'failed_before_send'`,
      false,
    ],
    [
      'never kicked → opened',
      [],
      `kick_outcome = 'opened', kick_count = 1, kicked_at = 'k1'`,
      false,
    ],
  ])('P1 kick record: %s', (_label, path, set, allowed) => {
    journal('confirmed');
    startPayout();
    path.forEach(kick);
    const run = (): void => {
      kick(set);
    };
    if (allowed) expect(run).not.toThrow();
    else expect(run).toThrow(/kick|constraint failed/);
  });

  it('P1: a drawer payout needs a drawer that opened', () => {
    journal('confirmed');
    startPayout();
    kick(SENDING_1);
    kick(`kick_outcome = 'unknown'`);
    expect(() =>
      db.run(`UPDATE return_payouts SET ${PAID.replace("'manual'", "'drawer'")}`),
    ).toThrow(/constraint failed/);
    db.run(`UPDATE return_payouts SET ${PAID}`);
  });

  it('starts a payout for a confirmed return, once', () => {
    journal('confirmed');
    startPayout();
    expect(() => {
      startPayout();
    }).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it('refuses a payout row born paid', () => {
    journal('confirmed');
    expect(() =>
      db.run(
        `INSERT INTO return_payouts (return_id, started_operator_id, started_session_id,
           started_at, paid_operator_id, paid_session_id, paid_at, method)
         VALUES ('r1', 'op', 'sess', 't3', 'op', 'sess', 't4', 'drawer')`,
      ),
    ).toThrow(/only for a confirmed return|unpaid/);
  });

  it('completes once, with every paid fact together and a known method', () => {
    journal('confirmed');
    startPayout();
    expect(() => db.run(`UPDATE return_payouts SET paid_at = 't4'`)).toThrow(/constraint failed/);
    expect(() => db.run(`UPDATE return_payouts SET ${PAID.replace("'manual'", "'card'")}`)).toThrow(
      /constraint failed/,
    );
    db.run(`UPDATE return_payouts SET ${PAID}`);
    expect(() => db.run(`UPDATE return_payouts SET method = 'manual'`)).toThrow(/completed once/);
  });

  it.each(['return_id', 'started_operator_id', 'started_session_id', 'started_at'])(
    'keeps %s immutable',
    (column) => {
      journal('confirmed');
      startPayout();
      expect(() => db.run(`UPDATE return_payouts SET ${column} = ${column}`)).toThrow(/immutable/);
    },
  );

  it('never deletes a payout', () => {
    journal('confirmed');
    startPayout();
    expect(() => db.run('DELETE FROM return_payouts')).toThrow(/DELETE is denied/);
  });

  it('refuses a payout for an unknown return', () => {
    expect(() => {
      startPayout('r404');
    }).toThrow(/only for a confirmed return/);
  });

  it('writes line details only with an unsent pending line; append-only', () => {
    journal('pending');
    const insertDetail = (lineRef: string, name: string | null, amount: number) =>
      db.run(`INSERT INTO return_journal_line_details VALUES ('r1', ?, ?, ?)`, [
        lineRef,
        name,
        amount,
      ]);
    insertDetail(LINE, 'Panadol 500mg', 1500);
    expect(() => insertDetail(LINE, 'again', 1)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => insertDetail(REF, 'no such line', 1)).toThrow(/FOREIGN KEY|constraint failed/);
    expect(() => db.run(`UPDATE return_journal_line_details SET amount_minor = 1`)).toThrow(
      /append-only/,
    );
    expect(() => db.run(`DELETE FROM return_journal_line_details`)).toThrow(/append-only/);
  });

  it.each<[string, string | null, number]>([
    ['an empty name', '', 1500],
    ['a name over 120 characters', 'x'.repeat(121), 1500],
    ['a negative amount', 'Panadol', -1],
  ])('refuses a line detail with %s', (_label, name, amount) => {
    journal('pending');
    expect(() =>
      db.run(`INSERT INTO return_journal_line_details VALUES ('r1', ?, ?, ?)`, [
        LINE,
        name,
        amount,
      ]),
    ).toThrow(/constraint failed/);
  });

  it('accepts a line detail without a name', () => {
    journal('pending');
    db.run(`INSERT INTO return_journal_line_details VALUES ('r1', ?, NULL, 0)`, [LINE]);
    expect(db.exec('SELECT COUNT(*) FROM return_journal_line_details')[0]?.values[0]?.[0]).toBe(1);
  });

  it.each<Header>(['unknown', 'confirmed', 'refused'])(
    'refuses a line detail once the header is %s',
    (state) => {
      journal(state);
      expect(() =>
        db.run(`INSERT INTO return_journal_line_details VALUES ('r1', ?, 'x', 1)`, [LINE]),
      ).toThrow(/header must be pending and unsent/);
    },
  );

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
    db.exec('DROP TABLE return_journal_line_details; DROP TABLE return_payouts;');
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
    expect(columns('return_payouts')).toContain('paid_at');
  });
});
