/**
 * T502 / T503 — "first-print after manual override" edge case (RED).
 *
 *   T502 After a manual override, the next successful retry-print INSERTs with
 *        purpose='retry_after_failure', outcome='success' (NOT purpose='reprint');
 *        the slip has no duplicate-copy marker (FR-052 + spec Edge Case).
 *   T503 After a manual override + successful retry, drawer-kick gating runs
 *        normally on the retry success (cash-inclusive → drawer pops); the
 *        UNIQUE(sale_id) constraint ensures only one DrawerEvent total.
 *
 * NOTE (Slice-6 conflict): the merged Slice-3 retry handler currently treats a
 * prior `manual_override` print as terminal (already-printed no-op), locked by
 * the T253 idempotent sub-test. T502/T503 require the OPPOSITE — a prior
 * manual_override must be NON-terminal so a later retry can run. These tests are
 * authored RED first; their failure IS the evidence for the spec-vs-merged-code
 * decision (narrow the retry guard to outcome='success' only).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createReceiptsBridge } from '../../../src/main/receipts/receipts-bridge.js';
import { createPrintDispatcher } from '../../../src/main/receipts/print-dispatcher.js';
import { createPrintPipeline } from '../../../src/main/receipts/print-pipeline.js';
import { createDrawerKickDispatcher } from '../../../src/main/drawer/drawer-kick.js';
import { bindPrintEventsRepository } from '../../../src/main/sales/repositories/print-events.repository.js';
import { bindSalesRepository } from '../../../src/main/sales/repositories/sales.repository.js';
import { bindDrawerEventsRepository } from '../../../src/main/sales/repositories/drawer-events.repository.js';
import { createSaleAuditEmitter } from '../../../src/main/sales/audit-emitter.js';
import { makeSqlJsHandle } from '../../unit/main/cart/__helpers__/sql-js-handle.js';
import type { OperatorSessionForSales } from '../../../src/main/sales/sales-bridge.js';
import type { SaleId } from '../../../src/shared/sales/types.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
const MIGRATIONS = [
  '0004_audit_events.sql',
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
  '0023_create_drawer_events.sql',
  '0028_extend_sales_with_lines_json.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const SESSION: OperatorSessionForSales = {
  role: 'manager',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  operator_id: 'op-1',
  operator_session_id: 'sess-1',
};

function seedCashSale(db: SqlJsDatabase): void {
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (
       'sale-1','TERM-01-2026-05-27-000001','TERM-01-2026-05-27-000001','handoff-1','pa-1',
       'cart-1','tenant-1','branch-1','terminal-1','TERM-01',
       'op-selling','Mohamed Ahmed','sess-1',
       5500,0,0,'[{"tender_type":"cash","amount_applied_minor":5500,"change_due_minor":0}]',
       '2026-05-27T10:00:05.000Z','2026-05-27T10:00:06.000Z','TRN-100','Maadi Branch','12 Road 9',
       '2026-05-27','[{"line_id":"l1","item_ref":"SKU-001","display_name":"Paracetamol","quantity":1,"unit_price_minor":5500,"line_subtotal_minor":5500,"note":null,"version":1,"last_action_id":"a1"}]'
     )`,
  );
}

function seedFailedPrint(db: SqlJsDatabase): void {
  db.run(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES ('pe-failed-1', 'sale-1', 'failure', 'first_print', 'escpos_direct',
       'op-selling', 'sess-1', NULL, 'printer_offline', NULL, '2026-05-27T10:00:07.000Z')`,
  );
}

function makeBridge(db: SqlJsDatabase) {
  const handle = makeSqlJsHandle(db);
  const pipeline = createPrintPipeline({
    escposAdapter: {
      render_path: 'escpos_direct',
      print: () => Promise.resolve({ ok: true as const, render_path: 'escpos_direct' as const }),
    },
    osPrintAdapter: {
      render_path: 'os_print',
      print: () => Promise.resolve({ ok: true as const, render_path: 'os_print' as const }),
    },
    probeEscposSupport: () => Promise.resolve(true),
  });
  let peSeq = 0;
  const printDispatcher = createPrintDispatcher({
    pipeline,
    printEventsRepo: bindPrintEventsRepository(handle),
    auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
    now: () => '2026-05-27T10:00:12.000Z',
    newPrintEventId: () => `pe-${String(++peSeq)}`,
  });
  const drawerKickDispatcher = createDrawerKickDispatcher({
    drawerEventsRepo: bindDrawerEventsRepository(handle),
    // A working drawer transport so a cash-inclusive retry-success kicks.
    transport: { kick: () => Promise.resolve({ ok: true as const }) },
    auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
    now: () => '2026-05-27T10:00:13.000Z',
    newDrawerEventId: () => 'de-1',
  });
  return createReceiptsBridge({
    getCurrentSession: () => SESSION,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    printDispatcher,
    drawerKickDispatcher,
    auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
    now: () => '2026-05-27T10:00:11.000Z',
    newPrintEventId: () => 'pe-mo-1',
  });
}

describe('T502/T503 — first-print after manual override', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedCashSale(db);
    seedFailedPrint(db);
  });

  it('T502: a retry after manual override is a retry_after_failure success, not a reprint', async () => {
    const bridge = makeBridge(db);

    const mo = await bridge.manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'mo-1',
    });
    expect(mo.kind).toBe('ok');

    // Printer comes back online → cashier retries.
    const retry = await bridge.retryPrint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'r-1' });
    expect(retry.kind).toBe('ok');
    if (retry.kind === 'ok') {
      expect(retry.outcome).toBe('success');
      expect(retry.purpose).toBe('retry_after_failure');
    }

    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    const retryRow = rows.find(
      (r) => r.purpose === 'retry_after_failure' && r.outcome === 'success',
    );
    expect(retryRow).toBeDefined();
    // No reprint row — the retry-success is the canonical first print (FR-052).
    expect(rows.find((r) => r.purpose === 'reprint')).toBeUndefined();
    // The manual_override row remains in the lineage.
    expect(rows.find((r) => r.outcome === 'manual_override')).toBeDefined();
  });

  it('T503: the retry-success after manual override kicks the drawer (cash-inclusive), one DrawerEvent total', async () => {
    const bridge = makeBridge(db);
    const drawerRepo = bindDrawerEventsRepository(makeSqlJsHandle(db));

    await bridge.manualOverride({ sale_id: 'sale-1' as SaleId, idempotency_key: 'mo-1' });
    await bridge.retryPrint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'r-1' });

    const drawer = drawerRepo.readBySale('sale-1');
    expect(drawer).not.toBeNull();
    expect(drawer?.outcome).toBe('opened');
  });
});
