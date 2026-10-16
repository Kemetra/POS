/**
 * T501 — manual override does NOT kick the drawer (RED).
 *
 * A manual override means no print succeeded, so the drawer-kick gating (which
 * fires only after a successful print) never triggers. No drawer_events row is
 * INSERTed. The manualOverride path wires NO drawer dispatcher, so the kick is
 * structurally impossible; this asserts the observable consequence.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createReceiptsBridge } from '../../../src/main/receipts/receipts-bridge.js';
import { bindPrintEventsRepository } from '../../../src/main/sales/repositories/print-events.repository.js';
import { bindSalesRepository } from '../../../src/main/sales/repositories/sales.repository.js';
import { bindDrawerEventsRepository } from '../../../src/main/sales/repositories/drawer-events.repository.js';
import { createSaleAuditEmitter } from '../../../src/main/sales/audit-emitter.js';
import { makeSqlJsHandle } from '../../unit/main/cart/__helpers__/sql-js-handle.js';
import type { OperatorSessionForSales } from '../../../src/main/sales/sales-bridge.js';
import type { PrintDispatcher } from '../../../src/main/receipts/print-dispatcher.js';
import type { SaleId } from '../../../src/shared/sales/types.js';

function neverDispatcher(): Pick<PrintDispatcher, 'dispatchRetryPrint' | 'dispatchReprint'> {
  const fail = (): never => {
    throw new Error('dispatcher must not be called by manualOverride');
  };
  return { dispatchRetryPrint: fail, dispatchReprint: fail };
}

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
  operator_id: 'op-overrider',
  operator_session_id: 'sess-overrider',
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
  // Deliberately NO drawerKickDispatcher — manual override must never kick.
  return createReceiptsBridge({
    getCurrentSession: () => SESSION,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    printDispatcher: neverDispatcher(),
    auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
    now: () => '2026-05-27T10:00:11.000Z',
    newPrintEventId: () => 'pe-mo-1',
  });
}

describe('T501 — manual override on a cash-inclusive sale does not kick the drawer', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedCashSale(db);
    seedFailedPrint(db);
  });

  it('no drawer_events row is written for the sale after a manual override', async () => {
    const bridge = makeBridge(db);
    const drawerRepo = bindDrawerEventsRepository(makeSqlJsHandle(db));

    expect(drawerRepo.readBySale('sale-1')).toBeNull();

    const res = await bridge.manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'idem-1',
    });
    expect(res.kind).toBe('ok');

    expect(drawerRepo.readBySale('sale-1')).toBeNull();
  });
});
