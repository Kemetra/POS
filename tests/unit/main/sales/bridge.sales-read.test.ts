/**
 * T070 — `sales.read` bridge handler test (RED).
 *
 * Per contracts/bridge-api.md §"sales.read" + tasks.md T070:
 *   • Requires active session (no_session refusal).
 *   • Tenant/branch/terminal isolation enforced (tenant_isolation refusal).
 *   • Sale-not-found refuses with sale_not_found.
 *   • Success returns the sales.read payload shape — MAIN-ONLY FIELDS
 *     STRIPPED: envelope_handoff_action_id, payment_attempt_id,
 *     envelope_cart_id, tenant_tax_registration_id.
 *   • Includes latest_print_event + latest_drawer_event projections
 *     (absent when no rows exist; present and projected when they do).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSalesBridge } from '../../../../src/main/sales/sales-bridge.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindPrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import { bindDrawerEventsRepository } from '../../../../src/main/sales/repositories/drawer-events.repository.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
  '0023_create_drawer_events.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
});

const SESSION = {
  role: 'cashier' as const,
  operator_id: 'op-clerk-user-abc',
  operator_session_id: 'sess-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
};

function seedSale(overrides: Record<string, string | number> = {}): void {
  const defaults: Record<string, string | number> = {
    sale_id: 'sale-1',
    sale_number: 'TERM-01-2026-05-28-000001',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    ...overrides,
  };
  db.exec(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day
     ) VALUES (
       '${String(defaults.sale_id)}', '${String(defaults.sale_number)}', '${String(defaults.sale_number)}',
       'handoff-1', 'pa-1',
       'cart-1', '${String(defaults.tenant_id)}', '${String(defaults.branch_id)}', '${String(defaults.terminal_id)}', 'TERM-01',
       'op-clerk-user-abc', 'Ahmed', 'sess-1',
       1500, 0, 0, '[{"tender_type":"cash","amount_applied_minor":1500}]',
       '2026-05-28T10:00:00.000Z', '2026-05-28T10:00:00.500Z', 'TRN-SECRET-123', 'Maadi', '12 Road 9',
       '2026-05-28'
     )`,
  );
}

function buildBridge(sessionOverride: typeof SESSION | null = SESSION) {
  const handle = makeSqlJsHandle(db);
  return createSalesBridge({
    getCurrentSession: () => sessionOverride,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    drawerEventsRepo: bindDrawerEventsRepository(handle),
  });
}

describe('T070 — sales.read: gating', () => {
  it('refuses with no_session when no active session', async () => {
    seedSale();
    const bridge = buildBridge(null);
    const result = await bridge.read({ sale_id: 'sale-1' });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('no_session');
  });

  it('refuses with sale_not_found when sale_id unknown', async () => {
    const bridge = buildBridge();
    const result = await bridge.read({ sale_id: 'does-not-exist' });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('sale_not_found');
  });

  it('refuses with tenant_isolation when session tenant mismatches sale tenant', async () => {
    seedSale({ tenant_id: 'tenant-OTHER' });
    const bridge = buildBridge();
    const result = await bridge.read({ sale_id: 'sale-1' });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('tenant_isolation');
  });

  it('refuses with tenant_isolation when session terminal mismatches sale terminal', async () => {
    seedSale({ terminal_id: 'terminal-OTHER' });
    const bridge = buildBridge();
    const result = await bridge.read({ sale_id: 'sale-1' });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('tenant_isolation');
  });
});

describe('T070 — sales.read: success payload shape', () => {
  it('returns the sale with main-only fields stripped', async () => {
    seedSale();
    const bridge = buildBridge();
    const result = await bridge.read({ sale_id: 'sale-1' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.sale.sale_id).toBe('sale-1');
    expect(result.sale.sale_number).toBe('TERM-01-2026-05-28-000001');

    // Main-only fields MUST NOT cross the bridge.
    const saleObj = result.sale as unknown as Record<string, unknown>;
    expect('envelope_handoff_action_id' in saleObj).toBe(false);
    expect('payment_attempt_id' in saleObj).toBe(false);
    expect('envelope_cart_id' in saleObj).toBe(false);
    expect('tenant_tax_registration_id' in saleObj).toBe(false);
  });

  it('includes tender_lines_summary parsed from JSON', async () => {
    seedSale();
    const bridge = buildBridge();
    const result = await bridge.read({ sale_id: 'sale-1' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.sale.tender_lines_summary).toEqual([
      { tender_type: 'cash', amount_applied_minor: 1500 },
    ]);
  });

  it('omits latest_print_event and latest_drawer_event when no rows exist (S1 reality)', async () => {
    seedSale();
    const bridge = buildBridge();
    const result = await bridge.read({ sale_id: 'sale-1' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.sale.latest_print_event).toBeUndefined();
    expect(result.sale.latest_drawer_event).toBeUndefined();
  });

  it('projects latest_print_event when a print_event exists', async () => {
    seedSale();
    db.exec(
      `INSERT INTO print_events (
         print_event_id, sale_id, outcome, purpose, render_path,
         acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
         failure_reason, previous_failed_print_event_ids, printed_at
       ) VALUES (
         'pe-1', 'sale-1', 'success', 'first_print', 'escpos_direct',
         'op-clerk-user-abc', 'sess-1', NULL,
         NULL, NULL, '2026-05-28T10:00:01.000Z'
       )`,
    );
    const bridge = buildBridge();
    const result = await bridge.read({ sale_id: 'sale-1' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.sale.latest_print_event).toBeDefined();
    expect(result.sale.latest_print_event?.outcome).toBe('success');
    expect(result.sale.latest_print_event?.print_event_id).toBe('pe-1');
  });

  it('projects latest_drawer_event when a drawer_event exists', async () => {
    seedSale();
    db.exec(
      `INSERT INTO print_events (
         print_event_id, sale_id, outcome, purpose, render_path,
         acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
         failure_reason, previous_failed_print_event_ids, printed_at
       ) VALUES (
         'pe-1', 'sale-1', 'success', 'first_print', 'escpos_direct',
         'op-clerk-user-abc', 'sess-1', NULL,
         NULL, NULL, '2026-05-28T10:00:01.000Z'
       )`,
    );
    db.exec(
      `INSERT INTO drawer_events (
         drawer_event_id, sale_id, outcome, suppression_reason, failure_reason,
         last_successful_open_at_for_terminal, triggering_print_event_id,
         terminal_id, attempted_at
       ) VALUES (
         'de-1', 'sale-1', 'opened', NULL, NULL,
         NULL, 'pe-1',
         'terminal-1', '2026-05-28T10:00:02.000Z'
       )`,
    );
    const bridge = buildBridge();
    const result = await bridge.read({ sale_id: 'sale-1' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.sale.latest_drawer_event).toBeDefined();
    expect(result.sale.latest_drawer_event?.outcome).toBe('opened');
  });
});

describe('T073 — sales.read: forbidden-field-in-request guard', () => {
  it('refuses requests containing forbidden keys in the payload', async () => {
    seedSale();
    const bridge = buildBridge();
    const result = await bridge.read({
      sale_id: 'sale-1',
      pan: 'TEST_PAN_TOKEN_NOT_A_REAL_CARD', // forbidden key (synthetic non-numeric token per CR4 on PR #266)
    } as unknown as { sale_id: string });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('forbidden_field_in_request');
  });

  it('refuses requests containing voucher tokens in the payload', async () => {
    seedSale();
    const bridge = buildBridge();
    const result = await bridge.read({
      sale_id: 'sale-1',
      voucher_redemption_intent_token: 'TOKEN',
    } as unknown as { sale_id: string });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('forbidden_field_in_request');
  });

  it('refuses requests with a shared FORBIDDEN_PAYLOAD_KEYS key (covers shared-list branch)', async () => {
    // pin is on the shared FORBIDDEN_PAYLOAD_KEYS list (not the bridge-local
    // denylist). Confirms the bridge guard composes both layers.
    seedSale();
    const bridge = buildBridge();
    const result = await bridge.read({
      sale_id: 'sale-1',
      pin: '1234',
    } as unknown as { sale_id: string });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('forbidden_field_in_request');
  });

  it('terminates on cyclic payloads instead of stack-overflowing (CR10 on PR #266)', async () => {
    // Build a cyclic object. Without the WeakSet visited-tracker, the
    // recursive scan would never return. Bridge must complete and reach
    // the session check.
    seedSale();
    const bridge = buildBridge();
    type Cyclic = { sale_id: string; self?: Cyclic };
    const cyclic: Cyclic = { sale_id: 'sale-1' };
    cyclic.self = cyclic;
    const result = await bridge.read(cyclic as unknown as { sale_id: string });
    // No forbidden keys, no isolation issues — read succeeds.
    expect(result.kind).toBe('ok');
  });

  it('refuses requests with forbidden keys nested inside an array (recursive scan)', async () => {
    seedSale();
    const bridge = buildBridge();
    const result = await bridge.read({
      sale_id: 'sale-1',
      items: [{ pan: 'TEST_PAN_TOKEN_NOT_A_REAL_CARD' }],
    } as unknown as { sale_id: string });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('forbidden_field_in_request');
  });

  it('passes when request contains arrays of clean objects (array branch returns null)', async () => {
    seedSale();
    const bridge = buildBridge();
    // Array branch must traverse without finding any forbidden key, then
    // return null so the read proceeds. Confirms the false-path of the
    // array iteration in findForbiddenKey.
    const result = await bridge.read({
      sale_id: 'sale-1',
      hint: ['clean', 'strings'],
    } as unknown as { sale_id: string });
    expect(result.kind).toBe('ok');
  });
});

describe('T070 — sales.read: latest_print_event with duplicate_copy_sequence_number', () => {
  it('includes duplicate_copy_sequence_number when set (reprint event)', async () => {
    seedSale();
    db.exec(
      `INSERT INTO print_events (
         print_event_id, sale_id, outcome, purpose, render_path,
         acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
         failure_reason, previous_failed_print_event_ids, printed_at
       ) VALUES (
         'pe-reprint', 'sale-1', 'success', 'reprint', 'escpos_direct',
         'op-clerk-user-abc', 'sess-1', 2,
         NULL, NULL, '2026-05-28T11:00:00.000Z'
       )`,
    );
    const bridge = buildBridge();
    const result = await bridge.read({ sale_id: 'sale-1' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.sale.latest_print_event?.duplicate_copy_sequence_number).toBe(2);
  });
});
