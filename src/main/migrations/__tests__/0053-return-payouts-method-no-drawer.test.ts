/**
 * RT-531 — `0053_return_payouts_method_no_drawer` ([GATED], owner-authorized
 * with the RT-531 brief): the `return_payouts` rebuild that adds the payout
 * method `no_drawer` (the cash left a terminal that has no cash drawer). On the
 * full stack:
 *   • the number right after 0052, and only it;
 *   • `no_drawer` is accepted, and only after a kick that provably never
 *     reached the hardware (`failed_before_send`), like `drawer` needs `opened`;
 *   • `drawer` and `manual` and every 0040 rule are unchanged (0040's own test
 *     runs on this same stack);
 *   • the payout's six triggers and the journal's `paid_out` trigger are
 *     re-created, so a header still reaches `paid_out` only with a paid payout;
 *   • rows written before it, paid or not, survive a rebuild unchanged.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { MIGRATIONS_DIR } from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';

const MIGRATION = '0053_return_payouts_method_no_drawer';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

const REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';

let db: SqlJsDatabase;
let seq = 0;

/** A fresh `pos-pulse-return:<uuid>` external id (0039 pins its exact shape). */
function externalId(): string {
  seq += 1;
  return `pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-${seq.toString(16).padStart(12, '0')}`;
}

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

/** A confirmed return `id` of sale-1, ready for a payout. */
function confirmedReturn(id: string): void {
  db.run(
    `INSERT INTO return_journal (return_id, tenant_id, branch_id, terminal_id, sale_id,
       sale_number, server_sale_ref, external_id, operator_id, operator_session_id,
       currency_code, quoted_total_minor, request_body_json, state, created_at, updated_at)
     VALUES (?, 't', 'b', 'term', 'sale-1', 'SN-1', ?, ?, 'op', 'sess', 'EGP', 1500, '{}',
       'pending', 't0', 't0')`,
    [id, REF, externalId()],
  );
  db.run(
    `UPDATE return_journal SET state = 'confirmed', return_ref = ?, return_total_minor = 1500,
       confirmed_at = 't1' WHERE return_id = ?`,
    [`${REF}-${id}`, id],
  );
}

function startPayout(id: string): void {
  db.run(
    `INSERT INTO return_payouts (return_id, started_operator_id, started_session_id, started_at)
     VALUES (?, 'op-m', 'sess-m', 't3')`,
    [id],
  );
}

const SENDING = `kick_outcome = 'sending', kick_count = 1, kicked_at = 'k1'`;

function update(id: string, set: string): void {
  db.run(`UPDATE return_payouts SET ${set} WHERE return_id = ?`, [id]);
}

/** A started payout whose one kick ended `outcome`. */
function kicked(id: string, outcome: 'opened' | 'failed_before_send' | 'unknown'): void {
  confirmedReturn(id);
  startPayout(id);
  update(id, SENDING);
  update(id, `kick_outcome = '${outcome}'`);
}

const paid = (method: string): string =>
  `paid_operator_id = 'op-m', paid_operator_name = 'Manager', paid_session_id = 'sess-m',
   paid_at = 't4', method = '${method}'`;

const value = (sql: string): unknown => db.exec(sql)[0]?.values[0]?.[0];

describe('0053 — return_payouts.method gains no_drawer', () => {
  it('takes the number right after 0052, and only it does', () => {
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    const i = names.indexOf(`${MIGRATION}.sql`);
    expect(i).toBeGreaterThan(0);
    expect(names[i - 1]).toBe('0052_drawer_events_suppression_no_drawer.sql');
    expect(names.filter((n) => n.startsWith('0053_'))).toEqual([`${MIGRATION}.sql`]);
  });

  it('completes a no_drawer payout after a kick that never reached the hardware', () => {
    kicked('r1', 'failed_before_send');
    update('r1', paid('no_drawer'));
    expect(value(`SELECT method FROM return_payouts WHERE return_id = 'r1'`)).toBe('no_drawer');
  });

  it.each(['opened', 'unknown'] as const)(
    'refuses a no_drawer payout after a kick that %s (the drawer may have opened)',
    (outcome) => {
      kicked('r1', outcome);
      expect(() => {
        update('r1', paid('no_drawer'));
      }).toThrow(/CHECK constraint failed/);
    },
  );

  it('refuses a no_drawer payout that never kicked', () => {
    confirmedReturn('r1');
    startPayout('r1');
    expect(() => {
      update('r1', paid('no_drawer'));
    }).toThrow(/CHECK constraint failed/);
  });

  it('still refuses an unknown method', () => {
    kicked('r1', 'failed_before_send');
    expect(() => {
      update('r1', paid('made_up'));
    }).toThrow(/CHECK constraint failed/);
  });

  it('keeps drawer (needs opened) and manual (needs nothing) as they were', () => {
    kicked('r1', 'opened');
    update('r1', paid('drawer'));
    kicked('r2', 'failed_before_send');
    expect(() => {
      update('r2', paid('drawer'));
    }).toThrow(/CHECK constraint failed/);
    update('r2', paid('manual'));
    expect(value(`SELECT method FROM return_payouts WHERE return_id = 'r2'`)).toBe('manual');
  });

  it('still lets the header reach paid_out only with a paid payout', () => {
    kicked('r1', 'failed_before_send');
    const toPaidOut = (): void => {
      db.run(
        `UPDATE return_journal SET state = 'paid_out', paid_out_at = 't9' WHERE return_id = 'r1'`,
      );
    };
    expect(toPaidOut).toThrow(/needs a completed payout/);
    update('r1', paid('no_drawer'));
    expect(toPaidOut).not.toThrow();
  });

  it('keeps the kick guard: a sent kick resolves once, and a paid payout is final', () => {
    kicked('r1', 'failed_before_send');
    expect(() => {
      update('r1', `kick_outcome = 'opened'`);
    }).toThrow(/illegal drawer kick transition/);
    update('r1', paid('no_drawer'));
    expect(() => {
      update('r1', paid('manual'));
    }).toThrow(/completed once/);
    expect(() => {
      db.run(`DELETE FROM return_payouts WHERE return_id = 'r1'`);
    }).toThrow(/DELETE is denied/);
  });

  it('keeps a payout starting only for a confirmed return, unpaid, once', () => {
    db.run(
      `INSERT INTO return_journal (return_id, tenant_id, branch_id, terminal_id, sale_id,
         sale_number, server_sale_ref, external_id, operator_id, operator_session_id,
         currency_code, quoted_total_minor, request_body_json, state, created_at, updated_at)
       VALUES ('rp', 't', 'b', 'term', 'sale-1', 'SN-1', ?, ?, 'op', 'sess', 'EGP', 1, '{}',
         'pending', 't0', 't0')`,
      [REF, externalId()],
    );
    expect(() => {
      startPayout('rp');
    }).toThrow(/only for a confirmed return/);
    confirmedReturn('r1');
    startPayout('r1');
    expect(() => {
      startPayout('r1');
    }).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it('keeps every row through a rebuild, and re-creates the triggers', () => {
    kicked('r-open', 'opened');
    update('r-open', paid('drawer'));
    kicked('r-fbs', 'failed_before_send');
    confirmedReturn('r-new');
    startPayout('r-new');
    db.exec(SQL_TEXT); // a second rebuild over existing rows
    expect(value('SELECT COUNT(*) FROM return_payouts')).toBe(3);
    expect(
      db.exec(
        `SELECT return_id, method, kick_outcome, kick_count, paid_at FROM return_payouts
          ORDER BY return_id`,
      )[0]?.values,
    ).toEqual([
      ['r-fbs', null, 'failed_before_send', 1, null],
      ['r-new', null, null, 0, null],
      ['r-open', 'drawer', 'opened', 1, 't4'],
    ]);
    const triggers = (table: string): unknown[] | undefined =>
      db
        .exec(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = '${table}'`)[0]
        ?.values.map((v) => v[0]);
    expect(triggers('return_payouts')).toEqual(
      expect.arrayContaining([
        'trg_return_payouts_start_confirmed',
        'trg_return_payouts_start_immutable',
        'trg_return_payouts_paid_once',
        'trg_return_payouts_kick_guard',
        'trg_return_payouts_kick_lease',
        'trg_return_payouts_no_delete',
      ]),
    );
    expect(triggers('return_journal')).toEqual(
      expect.arrayContaining(['trg_return_journal_paid_out_needs_payout']),
    );
  });

  it('leaves the column list as 0040 made it', () => {
    const cols = (db.exec('PRAGMA table_info(return_payouts)')[0]?.values ?? []).map((r) =>
      String(r[1]),
    );
    expect(cols).toEqual([
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
  });
});
