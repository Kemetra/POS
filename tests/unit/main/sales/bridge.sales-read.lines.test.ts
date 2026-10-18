/**
 * RT-541 — the sale detail (`sales.read` / `sales.findByNumber`) gains its
 * recorded lines, from the frozen `sales.lines_json` snapshot (008 T028a).
 *
 *   • A sale finalized after migration 0028 shows its lines, display fields
 *     only (no line_id / version / last_action_id).
 *   • A pre-0028 sale holds the column default '[]': it shows an explicit
 *     "lines not recorded" state, never an empty itemised sale.
 *   • A snapshot that cannot be read is reported as such, never thrown across
 *     IPC and never guessed.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  createSalesBridge,
  type OperatorSessionForSales,
} from '../../../../src/main/sales/sales-bridge.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindPrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import { bindDrawerEventsRepository } from '../../../../src/main/sales/repositories/drawer-events.repository.js';
import type { SaleId, SaleNumber } from '../../../../src/shared/sales/types.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b))
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const MANAGER: OperatorSessionForSales = {
  role: 'manager',
  operator_id: 'op-manager',
  operator_session_id: 'sess-manager',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
};

let db: SqlJsDatabase;

function seed(saleId: string, linesJson: string): void {
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (?, ?, ?, ?, 'pa', 'cart', 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
       'op-a', 'Cashier A', 'sess', 2500, 0, 0, '[]',
       '2026-10-16T08:00:00.000Z', '2026-10-16T08:00:00.000Z', 'TRN-1', 'Branch', 'Address',
       '2026-10-16', ?)`,
    [saleId, `N-${saleId}`, `N-${saleId}`, `handoff-${saleId}`, linesJson],
  );
}

function bridge() {
  const handle = makeSqlJsHandle(db);
  return createSalesBridge({
    getCurrentSession: () => MANAGER,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    drawerEventsRepo: bindDrawerEventsRepository(handle),
  });
}

const RECORDED = JSON.stringify([
  {
    line_id: 'l1',
    item_ref: 'SKU-1',
    display_name: 'Paracetamol',
    quantity: 2,
    unit_price_minor: 1000,
    line_subtotal_minor: 2000,
    note: null,
    version: 3,
    last_action_id: 'a9',
  },
  {
    line_id: 'l2',
    item_ref: 'SKU-2',
    display_name: 'Bandage',
    quantity: 1,
    unit_price_minor: 500,
    line_subtotal_minor: 500,
    note: 'no box',
    version: 1,
    last_action_id: 'a10',
  },
]);

beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of ALL_MIGRATIONS) db.exec(sql);
});

describe('RT-541 — sale detail lines', () => {
  it('shows the recorded lines, in order, with display fields only', async () => {
    seed('s1', RECORDED);
    const res = await bridge().read({ sale_id: 's1' as SaleId });
    if (res.kind !== 'ok') throw new Error('expected ok');
    expect(res.sale.lines).toEqual({
      state: 'recorded',
      items: [
        {
          item_ref: 'SKU-1',
          display_name: 'Paracetamol',
          quantity: 2,
          unit_price_minor: 1000,
          line_subtotal_minor: 2000,
          note: null,
        },
        {
          item_ref: 'SKU-2',
          display_name: 'Bandage',
          quantity: 1,
          unit_price_minor: 500,
          line_subtotal_minor: 500,
          note: 'no box',
        },
      ],
    });
  });

  it('a pre-0028 sale (column default) says its lines were not recorded', async () => {
    seed('legacy', '[]');
    const res = await bridge().findByNumber({ sale_number: 'N-legacy' as SaleNumber });
    if (res.kind !== 'ok') throw new Error('expected ok');
    expect(res.sale.lines).toEqual({ state: 'not_recorded' });
  });

  it.each([
    ['not JSON', '{'],
    ['not an array', '{"line_id":"l1"}'],
    ['an element that is not an object', '[1]'],
    ['an element missing a display field', '[{"item_ref":"SKU-1","quantity":1}]'],
    [
      'a non-integer amount',
      '[{"item_ref":"x","display_name":"x","quantity":1,"unit_price_minor":1.5,"line_subtotal_minor":1,"note":null}]',
    ],
  ])('a snapshot that is %s is reported unreadable, not thrown', async (_label, raw) => {
    seed('bad', raw);
    const res = await bridge().read({ sale_id: 'bad' as SaleId });
    expect(res).toMatchObject({ kind: 'ok', sale: { lines: { state: 'unreadable' } } });
  });
});
