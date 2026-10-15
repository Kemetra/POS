/**
 * RT-531 — `0052_drawer_events_suppression_no_drawer` ([GATED], owner-authorized
 * with the RT-531 brief): the `drawer_events` rebuild that lets
 * `suppression_reason` be `no_drawer_configured` (a terminal with no cash
 * drawer). On the full stack:
 *   • the number right after 0051, and only it;
 *   • `suppressed` + `no_drawer_configured` is accepted, an unknown reason is not;
 *   • `failed` + `no_drawer_configured` (rows the stub wrote) is still accepted;
 *   • the biconditional outcome/reason CHECKs, UNIQUE(sale_id), the FKs and
 *     the append-only triggers all survive the rebuild;
 *   • rows written before it survive a rebuild unchanged.
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

const MIGRATION = '0052_drawer_events_suppression_no_drawer';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  for (const id of ['sale-1', 'sale-2', 'sale-3']) {
    seedSale(db, { sale_id: id });
    db.run(
      `INSERT INTO print_events (
         print_event_id, sale_id, outcome, purpose, render_path,
         acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
         failure_reason, previous_failed_print_event_ids, printed_at
       ) VALUES (?, ?, 'success', 'first_print', 'escpos_direct', 'op', 'sess', NULL, NULL, NULL,
         '2026-10-15T10:00:01.000Z')`,
      [`pe-${id}`, id],
    );
  }
});

afterEach(() => {
  db.close();
});

function insert(
  sale: string,
  outcome: 'opened' | 'suppressed' | 'failed',
  suppression: string | null,
  failure: string | null,
): void {
  db.run(
    `INSERT INTO drawer_events (
       drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
       last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'term-1', '2026-10-15T10:00:02.000Z')`,
    [`de-${sale}`, sale, outcome, suppression, failure, `pe-${sale}`],
  );
}

const value = (sql: string): unknown => db.exec(sql)[0]?.values[0]?.[0];

describe('0052 — drawer_events.suppression_reason gains no_drawer_configured', () => {
  it('takes the number right after 0051, and only it does', () => {
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    const i = names.indexOf(`${MIGRATION}.sql`);
    expect(i).toBeGreaterThan(0);
    expect(names[i - 1]).toBe('0051_payment_attempts_selling_operator_display_name.sql');
    expect(names.filter((n) => n.startsWith('0052_'))).toEqual([`${MIGRATION}.sql`]);
  });

  it.each(['cashless_tender_mix', 'no_drawer_configured'])(
    'accepts a suppressed row with reason %s',
    (reason) => {
      insert('sale-1', 'suppressed', reason, null);
      expect(value(`SELECT suppression_reason FROM drawer_events WHERE sale_id = 'sale-1'`)).toBe(
        reason,
      );
    },
  );

  it('still refuses an unknown suppression reason', () => {
    expect(() => {
      insert('sale-1', 'suppressed', 'made_up', null);
    }).toThrow(/CHECK constraint failed/);
  });

  it.each(['printer_dk_failure', 'os_error', 'no_drawer_configured'])(
    'still accepts a failed row with reason %s (historical rows stay valid)',
    (reason) => {
      insert('sale-1', 'failed', null, reason);
      expect(value(`SELECT failure_reason FROM drawer_events WHERE sale_id = 'sale-1'`)).toBe(
        reason,
      );
    },
  );

  it('keeps the biconditional outcome / reason CHECKs', () => {
    expect(() => {
      insert('sale-1', 'suppressed', null, null);
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      insert('sale-1', 'opened', 'no_drawer_configured', null);
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      insert('sale-1', 'failed', null, null);
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      insert('sale-1', 'suppressed', 'no_drawer_configured', 'os_error');
    }).toThrow(/CHECK constraint failed/);
  });

  it('keeps exactly one row per sale (FR-053) and the foreign keys', () => {
    insert('sale-1', 'suppressed', 'no_drawer_configured', null);
    expect(() => {
      db.run(
        `INSERT INTO drawer_events (
           drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
           last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
         ) VALUES ('de-dup', 'sale-1', 'opened', NULL, NULL, NULL, 'pe-sale-1', 'term-1', 't')`,
      );
    }).toThrow(/UNIQUE constraint failed/);
    expect(() => {
      db.run(
        `INSERT INTO drawer_events (
           drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
           last_successful_open_at_for_terminal, triggering_print_event_id, terminal_id, attempted_at
         ) VALUES ('de-fk', 'no-such-sale', 'opened', NULL, NULL, NULL, 'pe-sale-1', 'term-1', 't')`,
      );
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('stays append-only: UPDATE and DELETE are denied', () => {
    insert('sale-1', 'suppressed', 'no_drawer_configured', null);
    expect(() => {
      db.run(`UPDATE drawer_events SET terminal_id = 'x' WHERE sale_id = 'sale-1'`);
    }).toThrow(/append-only/);
    expect(() => {
      db.run(`DELETE FROM drawer_events WHERE sale_id = 'sale-1'`);
    }).toThrow(/append-only/);
  });

  it('keeps every row through a rebuild, and re-creates the indexes and triggers', () => {
    insert('sale-1', 'opened', null, null);
    insert('sale-2', 'failed', null, 'no_drawer_configured');
    insert('sale-3', 'suppressed', 'cashless_tender_mix', null);
    db.exec(SQL_TEXT); // a second rebuild over existing rows
    expect(value('SELECT COUNT(*) FROM drawer_events')).toBe(3);
    expect(value(`SELECT failure_reason FROM drawer_events WHERE sale_id = 'sale-2'`)).toBe(
      'no_drawer_configured',
    );
    const names = (type: string): unknown[] | undefined =>
      db
        .exec(
          `SELECT name FROM sqlite_master WHERE type = '${type}' AND tbl_name = 'drawer_events'`,
        )[0]
        ?.values.map((v) => v[0]);
    expect(names('index')).toEqual(
      expect.arrayContaining([
        'idx_drawer_events_sale_id',
        'idx_drawer_events_terminal_attempted_at',
      ]),
    );
    expect(names('trigger')).toEqual(
      expect.arrayContaining(['trg_drawer_events_no_update', 'trg_drawer_events_no_delete']),
    );
  });

  it('leaves the column list as it was', () => {
    const cols = (db.exec('PRAGMA table_info(drawer_events)')[0]?.values ?? []).map((r) =>
      String(r[1]),
    );
    expect(cols).toEqual([
      'drawer_event_id',
      'sale_id',
      'outcome',
      'suppression_reason',
      'failure_reason',
      'last_successful_open_at_for_terminal',
      'triggering_print_event_id',
      'terminal_id',
      'attempted_at',
    ]);
  });
});
