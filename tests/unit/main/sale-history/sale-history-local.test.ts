/**
 * RT-542 — the local reads of the store-wide history, on the real migrated
 * schema (sql.js):
 *   • `unsynced`: this terminal's sales in the window the server has not
 *     received (no sync row, pending or dead-letter), never a synced one,
 *     another terminal's, or (for a cashier) another operator's;
 *   • `localSaleIds`: this terminal's own sale per server saleRef.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  createSaleHistoryLocalReads,
  type SaleHistoryLocalReads,
  type UnsyncedQuery,
} from '../../../../src/main/sale-history/sale-history-local.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b))
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

const SCOPE = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };
const REF_A = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a01';
const REF_B = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a02';

let SQL: SqlJsStatic;
let db: SqlJsDatabase;
let reads: SaleHistoryLocalReads;
let seq = 0;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  seq = 0;
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of ALL_MIGRATIONS) db.exec(sql);
  reads = createSaleHistoryLocalReads(makeSqlJsHandle(db));
});

function sale(id: string, at: string, over: { seller?: string; terminal?: string } = {}): void {
  seq += 1;
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (?, ?, ?, ?, 'pa', 'cart', ?, ?, ?, 'TERM-01', ?, 'Seller', 'sess',
       1000, 0, 0, '[]', ?, ?, 'TRN-1', 'Branch', 'Address', '2026-10-16', '[]')`,
    [
      id,
      `TERM-01-2026-10-16-${String(seq).padStart(6, '0')}`,
      `R-${String(seq)}`,
      `handoff-${id}`,
      SCOPE.tenant_id,
      SCOPE.branch_id,
      over.terminal ?? SCOPE.terminal_id,
      over.seller ?? 'op-a',
      at,
      at,
    ],
  );
}

function syncState(id: string, status: string, ref: string | null = null): void {
  db.run(
    `INSERT INTO sale_sync_state
       (sale_id, tenant_id, branch_id, sync_status, attempt_count, created_at, updated_at, server_sale_ref)
     VALUES (?, ?, ?, ?, 1, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', ?)`,
    [id, SCOPE.tenant_id, SCOPE.branch_id, status, ref],
  );
}

function window(over: Partial<UnsyncedQuery> = {}): UnsyncedQuery {
  return {
    scope: SCOPE,
    selling_operator_id: null,
    start_inclusive: '2026-10-15T21:00:00.000Z',
    end_exclusive: '2026-10-16T21:00:00.000Z',
    limit: 101,
    ...over,
  };
}

describe('RT-542 local reads — unsynced', () => {
  it('lists unsent sales of this terminal in the window, newest first, with their state', () => {
    sale('new', '2026-10-16T09:00:00.000Z');
    sale('pending', '2026-10-16T10:00:00.000Z');
    syncState('pending', 'pending');
    sale('dead', '2026-10-16T11:00:00.000Z');
    syncState('dead', 'dead_letter');
    sale('synced', '2026-10-16T12:00:00.000Z');
    syncState('synced', 'synced', REF_A);
    sale('outside', '2026-10-16T21:00:00.000Z');
    sale('other-till', '2026-10-16T13:00:00.000Z', { terminal: 'terminal-2' });
    const rows = reads.unsynced(window());
    expect(rows.map((r) => [r.sale_id, r.sync])).toEqual([
      ['dead', 'dead_letter'],
      ['pending', 'pending'],
      ['new', 'not_started'],
    ]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      [
        'finalized_at',
        'sale_id',
        'sale_number',
        'selling_operator_display_name',
        'subtotal_minor',
        'sync',
        'terminal_label',
        'total_tax_minor',
      ].sort(),
    );
  });

  it('limits a cashier to their own sales and honours the limit', () => {
    sale('mine-1', '2026-10-16T09:00:00.000Z', { seller: 'op-a' });
    sale('theirs', '2026-10-16T10:00:00.000Z', { seller: 'op-b' });
    sale('mine-2', '2026-10-16T11:00:00.000Z', { seller: 'op-a' });
    expect(reads.unsynced(window({ selling_operator_id: 'op-a' })).map((r) => r.sale_id)).toEqual([
      'mine-2',
      'mine-1',
    ]);
    expect(reads.unsynced(window({ limit: 1 }))).toHaveLength(1);
  });
});

describe('RT-542 local reads — localSaleIds', () => {
  it('maps server refs to this terminal’s own sales only', () => {
    sale('local-a', '2026-10-16T09:00:00.000Z');
    syncState('local-a', 'synced', REF_A);
    sale('other-till', '2026-10-16T10:00:00.000Z', { terminal: 'terminal-2' });
    syncState('other-till', 'synced', REF_B);
    const ids = reads.localSaleIds(SCOPE, [REF_A, REF_B, '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a03']);
    expect([...ids.entries()]).toEqual([[REF_A, 'local-a']]);
    expect(reads.localSaleIds(SCOPE, []).size).toBe(0);
  });
});
