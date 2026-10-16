/**
 * T071 — `sales.findByNumber` bridge handler test (RED).
 *
 * Per contracts/bridge-api.md §"sales.findByNumber" + tasks.md T071 +
 * §A4 checklist item 6:
 *   • Scoped tenant/branch/terminal lookup using the active session.
 *   • Cross-tenant misses refuse with `sale_not_found` (NOT
 *     `tenant_isolation`) — the latter would leak existence of the sale
 *     in another tenant. Per §A4 checklist item 6.
 *   • Cross-branch and cross-terminal misses within the same tenant
 *     ALSO refuse with `sale_not_found` (terminal-level isolation per
 *     Constitution §P17).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

function seedSale(overrides: Record<string, string> = {}): void {
  const defaults: Record<string, string> = {
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
       'handoff-${String(defaults.sale_id)}', 'pa-1',
       'cart-1', '${String(defaults.tenant_id)}', '${String(defaults.branch_id)}', '${String(defaults.terminal_id)}', 'TERM-01',
       'op-clerk-user-abc', 'Ahmed', 'sess-1',
       1500, 0, 0, '[]',
       '2026-05-28T10:00:00.000Z', '2026-05-28T10:00:00.500Z', 'TRN', 'B', 'A',
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

describe('T071 — sales.findByNumber: tenant-isolated lookup', () => {
  it('finds the sale when tenant/branch/terminal match', async () => {
    seedSale();
    const bridge = buildBridge();
    const result = await bridge.findByNumber({ sale_number: 'TERM-01-2026-05-28-000001' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.sale.sale_id).toBe('sale-1');
  });

  it('refuses with sale_not_found on cross-tenant miss (no information leak)', async () => {
    seedSale({ tenant_id: 'tenant-OTHER' });
    const bridge = buildBridge();
    const result = await bridge.findByNumber({ sale_number: 'TERM-01-2026-05-28-000001' });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    // Critical: NOT tenant_isolation — that would leak existence.
    expect(result.reason).toBe('sale_not_found');
  });

  it('refuses with sale_not_found on cross-branch miss within same tenant', async () => {
    seedSale({ branch_id: 'branch-OTHER' });
    const bridge = buildBridge();
    const result = await bridge.findByNumber({ sale_number: 'TERM-01-2026-05-28-000001' });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('sale_not_found');
  });

  it('refuses with sale_not_found on cross-terminal miss within same branch', async () => {
    seedSale({ terminal_id: 'terminal-OTHER' });
    const bridge = buildBridge();
    const result = await bridge.findByNumber({ sale_number: 'TERM-01-2026-05-28-000001' });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('sale_not_found');
  });

  it('refuses with sale_not_found when sale_number does not exist anywhere', async () => {
    const bridge = buildBridge();
    const result = await bridge.findByNumber({ sale_number: 'TERM-99-9999-99-99-999999' });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('sale_not_found');
  });

  it('refuses with no_session when no active session', async () => {
    seedSale();
    const bridge = buildBridge(null);
    const result = await bridge.findByNumber({ sale_number: 'TERM-01-2026-05-28-000001' });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('no_session');
  });

  it('refuses with forbidden_field_in_request when payload contains a forbidden key', async () => {
    seedSale();
    const bridge = buildBridge();
    const result = await bridge.findByNumber({
      sale_number: 'TERM-01-2026-05-28-000001',
      pan: 'TEST_PAN_TOKEN_NOT_A_REAL_CARD',
    } as unknown as { sale_number: string });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('forbidden_field_in_request');
  });
});
