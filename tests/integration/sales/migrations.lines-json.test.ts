import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T028a — migration 0028 (extend `sales` with `lines_json`).
 *
 * Persists the `PaymentIntentEnvelope.lines` snapshot (item_ref,
 * display_name, quantity, unit_price_minor, line_subtotal_minor, note)
 * onto the durable Sale row for byte-stable reprints (FR-015 / FR-016).
 *
 * Asserts:
 *   • The `lines_json` column exists on `sales` after 0028 applies.
 *   • It defaults to '[]' so the migration runs cleanly against rows
 *     written before 0028 (dev fixtures past 0020).
 *   • A JSON array of line snapshots round-trips byte-identically through
 *     INSERT → SELECT (the canonical reprint-stability guarantee).
 *
 * Uses sql.js (pure-JS SQLite) per the project pattern — no native
 * better-sqlite3 binding required at test time.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

// All migrations up to and including 0027, plus the new 0028.
const ALL_MIGRATIONS = [
  '0001_init.sql',
  '0002_secrets.sql',
  '0003_terminal_assignment.sql',
  '0004_audit_events.sql',
  '0005_operator_sessions.sql',
  '0006_cashier_pin_records.sql',
  '0007_shifts.sql',
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0050_carts_park.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0015_create_payment_action_outbox.sql',
  '0016_payment_action_outbox_append_only_trigger.sql',
  '0017_extend_audit_event_categories.sql',
  '0018_audit_event_tender_reversal_pending.sql',
  '0019_extend_payment_failure_reason_enum.sql',
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
  '0023_create_drawer_events.sql',
  '0024_create_sale_sync_outbox.sql',
  '0025_create_sale_number_sequences.sql',
  '0026_extend_audit_event_categories.sql',
  '0027_extend_terminal_assignment.sql',
  '0028_extend_sales_with_lines_json.sql',
];

let SQL: SqlJsStatic;
const sqlCache = new Map<string, string>();

function loadSql(name: string): string {
  let cached = sqlCache.get(name);
  if (cached === undefined) {
    cached = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    sqlCache.set(name, cached);
  }
  return cached;
}

beforeAll(async () => {
  SQL = await initSqlJs();
});

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of ALL_MIGRATIONS) db.exec(loadSql(name));
  return db;
}

function columns(db: SqlJsDatabase, table: string): Set<string> {
  const result = db.exec(`PRAGMA table_info(${table})`);
  const names = new Set<string>();
  for (const row of result[0]?.values ?? []) {
    names.add(String(row[1]));
  }
  return names;
}

// Insert a sales row WITHOUT specifying lines_json — exercises the DEFAULT.
function insertSaleWithoutLines(db: SqlJsDatabase): void {
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day
     ) VALUES (
       'sale-default', 'TERM-01-2026-05-27-000001', 'TERM-01-2026-05-27-000001', 'handoff-default', 'attempt-1',
       'cart-1', 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
       'op-abc', 'Mohamed Ahmed', 'sess-1',
       19925, 0, 75, '[]',
       '2026-05-27T10:00:05.000Z', '2026-05-27T10:00:06.000Z', 'TAX-REG-1', 'Main Branch', '12 Tahrir St',
       '2026-05-27'
     )`,
  );
}

describe('T028a — migration 0028 lines_json', () => {
  it('adds the lines_json column to sales', () => {
    const db = freshDb();
    expect(columns(db, 'sales').has('lines_json')).toBe(true);
    db.close();
  });

  it("defaults lines_json to '[]' for rows inserted without it", () => {
    const db = freshDb();
    insertSaleWithoutLines(db);
    const result = db.exec(`SELECT lines_json FROM sales WHERE sale_id = 'sale-default'`);
    expect(String(result[0]?.values[0]?.[0])).toBe('[]');
    db.close();
  });

  it('round-trips a JSON line-snapshot array byte-identically', () => {
    const db = freshDb();
    const lines = [
      {
        line_id: 'line-1',
        item_ref: 'SKU-001',
        display_name: 'Paracetamol 500mg',
        quantity: 2,
        unit_price_minor: 1500,
        line_subtotal_minor: 3000,
        note: null,
        version: 1,
        last_action_id: 'action-1',
      },
      {
        line_id: 'line-2',
        item_ref: 'SKU-002',
        display_name: 'Vitamin C 1000mg',
        quantity: 1,
        unit_price_minor: 2500,
        line_subtotal_minor: 2500,
        note: 'fridge item',
        version: 1,
        last_action_id: 'action-2',
      },
    ];
    const linesJson = JSON.stringify(lines);
    db.run(
      `INSERT INTO sales (
         sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
         envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
         selling_operator_id, selling_operator_display_name, selling_operator_session_id,
         subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
         settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
         local_calendar_day, lines_json
       ) VALUES (
         'sale-lines', 'TERM-01-2026-05-27-000002', 'TERM-01-2026-05-27-000002', 'handoff-lines', 'attempt-2',
         'cart-2', 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
         'op-abc', 'Mohamed Ahmed', 'sess-1',
         5500, 0, 0, '[]',
         '2026-05-27T10:01:05.000Z', '2026-05-27T10:01:06.000Z', 'TAX-REG-1', 'Main Branch', '12 Tahrir St',
         '2026-05-27', ?
       )`,
      [linesJson],
    );
    const result = db.exec(`SELECT lines_json FROM sales WHERE sale_id = 'sale-lines'`);
    expect(String(result[0]?.values[0]?.[0])).toBe(linesJson);
    db.close();
  });
});
