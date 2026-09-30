/**
 * 011-sale-sync-capture-up — shared test fixture for the sale-sync slice.
 *
 * Builds a fresh sql.js database with the FULL migration stack applied (so
 * `sales`, `sale_sync_outbox`, and `sale_sync_state` exist exactly as
 * production sees them), wraps it in the production `DatabaseHandle` via the
 * 009/010 `handleFor` adapter (re-exported here), and seeds `sales` +
 * `sale_sync_outbox` rows so drain tests exercise the real first-drain path
 * (outbox row present, sale_sync_state row absent).
 *
 * sql.js is pure-WASM SQLite — loads under Vitest without the Electron-rebuilt
 * better-sqlite3 binary; column/CHECK/PK/trigger semantics match production.
 */
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { handleFor } from '../../../catalogue/__tests__/__helpers__/catalogue-fixture.js';

export { handleFor };

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
// __tests__/__helpers__ → sales-sync → main → src → repo root
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

/** Narrow a known-present value to non-null without a forbidden `!`. */
export function nn<T>(value: T | null | undefined, message = 'expected a value, got null'): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

let SQL: SqlJsStatic | undefined;

/** Initialise the sql.js engine once. Call in a `beforeAll`. */
export async function initSalesSyncSql(): Promise<void> {
  if (SQL === undefined) SQL = await initSqlJs();
}

/** A raw sql.js database with EVERY migration applied (all sale tables empty). */
export function freshSalesSyncDb(): SqlJsDatabase {
  if (SQL === undefined) {
    throw new Error('initSalesSyncSql() must be awaited in beforeAll before freshSalesSyncDb()');
  }
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of ALL_MIGRATIONS) db.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  return db;
}

export interface SeedSaleInput {
  sale_id?: string;
  tenant_id?: string;
  branch_id?: string;
  terminal_id?: string;
  selling_operator_id?: string;
  envelope_handoff_action_id?: string;
  subtotal_minor?: number;
  total_tax_minor?: number;
  finalized_at?: string;
  lines_json?: string;
  tender_lines_summary_json?: string;
}

/** Insert a durable `sales` row (the payload source). Unique sale_number per id. */
export function seedSale(db: SqlJsDatabase, o: SeedSaleInput = {}): string {
  const sale_id = o.sale_id ?? 'sale-1';
  const row = {
    sale_id,
    sale_number: `SN-${sale_id}`,
    receipt_number: `R-${sale_id}`,
    envelope_handoff_action_id: o.envelope_handoff_action_id ?? `handoff-${sale_id}`,
    tenant_id: o.tenant_id ?? 'tenant-1',
    branch_id: o.branch_id ?? 'branch-1',
    terminal_id: o.terminal_id ?? 'term-1',
    selling_operator_id: o.selling_operator_id ?? 'op-1',
    subtotal_minor: o.subtotal_minor ?? 1500,
    total_tax_minor: o.total_tax_minor ?? 0,
    finalized_at: o.finalized_at ?? '2026-06-07T10:00:00.000Z',
    lines_json:
      o.lines_json ??
      JSON.stringify([
        {
          line_id: 'l-1',
          item_ref: 'p-1',
          display_name: 'Panadol',
          quantity: 1,
          unit_price_minor: 1500,
          line_subtotal_minor: 1500,
        },
      ]),
  };
  db.run(
    `INSERT INTO sales
       (sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
        envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label, selling_operator_id,
        selling_operator_display_name, selling_operator_session_id, subtotal_minor, total_tax_minor,
        total_change_due_minor, tender_lines_summary_json, settled_at, finalized_at,
        tenant_tax_registration_id, branch_name, branch_address, local_calendar_day, lines_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.sale_id,
      row.sale_number,
      row.receipt_number,
      row.envelope_handoff_action_id,
      'pa-1',
      'cart-1',
      row.tenant_id,
      row.branch_id,
      row.terminal_id,
      'Till 1',
      row.selling_operator_id,
      'Operator One',
      'sess-1',
      row.subtotal_minor,
      row.total_tax_minor,
      0,
      o.tender_lines_summary_json ?? '[]',
      '2026-06-07T10:00:00.000Z',
      row.finalized_at,
      'TRN-123',
      'Main Branch',
      '1 Cairo St',
      '2026-06-07',
      row.lines_json,
    ] as never[],
  );
  return sale_id;
}

export interface SeedOutboxInput {
  sale_id?: string;
  tenant_id?: string;
  branch_id?: string;
  terminal_id?: string;
  envelope_handoff_action_id?: string;
  enqueued_at?: string;
}

/** Enqueue a `sale_sync_outbox` row (008's enqueue-only path). */
export function seedOutbox(db: SqlJsDatabase, o: SeedOutboxInput = {}): void {
  const sale_id = o.sale_id ?? 'sale-1';
  db.run(
    `INSERT INTO sale_sync_outbox
       (outbox_row_id, sale_id, envelope_handoff_action_id, tenant_id, branch_id, terminal_id, state, enqueued_at)
     VALUES (?,?,?,?,?,?, 'pending', ?)`,
    [
      `ob-${sale_id}`,
      sale_id,
      o.envelope_handoff_action_id ?? `handoff-${sale_id}`,
      o.tenant_id ?? 'tenant-1',
      o.branch_id ?? 'branch-1',
      o.terminal_id ?? 'term-1',
      o.enqueued_at ?? '2026-06-07T10:00:01.000Z',
    ] as never[],
  );
}
