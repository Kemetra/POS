/**
 * T410 / T411 / T412 — receipts.reprint attribution + isolation + permission (RED).
 *
 *   T410 the reprint print_events row carries acting_operator_id = the CURRENT
 *        signed-in (reprinting) operator, NOT the Sale's selling_operator_id;
 *        the audit payload carries BOTH operator ids (FR-024 / AD-10).
 *   T411 tenant isolation — a cross-scope sale refuses with `sale_not_found`
 *        (NOT `tenant_isolation`, per §A4 #6 information-leak rule).
 *   T412 RT-546 / OD-534-2 (supersedes AD-10's "no role restriction"): a
 *        cashier reprints only their own sale; manager / admin any sale in scope.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReceiptsBridge } from '../../../../src/main/receipts/receipts-bridge.js';
import { createPrintDispatcher } from '../../../../src/main/receipts/print-dispatcher.js';
import { createPrintPipeline } from '../../../../src/main/receipts/print-pipeline.js';
import { bindPrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { createSaleAuditEmitter } from '../../../../src/main/sales/audit-emitter.js';
import type { SaleAuditEvent } from '../../../../src/main/sales/audit-emitter.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import type { OperatorSessionForSales } from '../../../../src/main/sales/sales-bridge.js';
import type { SaleId } from '../../../../src/shared/sales/types.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0004_audit_events.sql',
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
  '0028_extend_sales_with_lines_json.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function seedSale(db: SqlJsDatabase): void {
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
       'op-selling','Mohamed Ahmed','sess-selling',
       5500,0,0,'[{"tender_type":"cash","amount_applied_minor":5500,"change_due_minor":0}]',
       '2026-05-27T10:00:05.000Z','2026-05-27T10:00:06.000Z','TRN-100','Maadi Branch','12 Road 9',
       '2026-05-27','[{"line_id":"l1","item_ref":"SKU-001","display_name":"Paracetamol","quantity":1,"unit_price_minor":5500,"line_subtotal_minor":5500,"note":null,"version":1,"last_action_id":"a1"}]'
     )`,
  );
}

function seedSuccessfulFirstPrint(db: SqlJsDatabase, id: string): void {
  db.run(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES (?, 'sale-1', 'success', 'first_print', 'escpos_direct',
       'op-selling', 'sess-selling', NULL, NULL, NULL, '2026-05-27T10:00:07.000Z')`,
    [id],
  );
}

function makeBridge(
  db: SqlJsDatabase,
  events: SaleAuditEvent[],
  session: OperatorSessionForSales | null,
) {
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
  let seq = 0;
  const printDispatcher = createPrintDispatcher({
    pipeline,
    printEventsRepo: bindPrintEventsRepository(handle),
    auditEmitter: createSaleAuditEmitter({ sink: { write: (e) => events.push(e) } }),
    now: () => '2026-05-27T10:00:09.000Z',
    newPrintEventId: () => `pe-reprint-${String(++seq)}`,
  });
  return createReceiptsBridge({
    getCurrentSession: () => session,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    printDispatcher,
  });
}

// RT-546: a reprint by someone other than the seller is a manager's (OD-534-2).
const REPRINTER: OperatorSessionForSales = {
  role: 'manager',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  operator_id: 'op-reprinter',
  operator_session_id: 'sess-reprinter',
};

describe('T410 — receipts.reprint attribution', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
    seedSuccessfulFirstPrint(db, 'pe-first-1');
  });

  it('reprint row attributes to the reprinting operator, not the selling operator; audit carries both', async () => {
    const events: SaleAuditEvent[] = [];
    const bridge = makeBridge(db, events, REPRINTER);

    await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });

    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    const reprintRow = rows.find((r) => r.purpose === 'reprint');
    expect(reprintRow?.acting_operator_id).toBe('op-reprinter');
    expect(reprintRow?.acting_operator_id).not.toBe('op-selling');

    const audit = events.find((e) => e.action_category === 'sale.receipt.reprinted');
    expect(audit).toBeDefined();
    // The audit payload carries BOTH the reprinting and the selling operator ids.
    expect(audit?.payload.reprinting_operator_id).toBe('op-reprinter');
    expect(audit?.payload.selling_operator_id).toBe('op-selling');
  });
});

describe('T411 — receipts.reprint tenant isolation', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
    seedSuccessfulFirstPrint(db, 'pe-first-1');
  });

  it('a cross-tenant session refuses with sale_not_found (no leak)', async () => {
    const events: SaleAuditEvent[] = [];
    const otherTenant: OperatorSessionForSales = { ...REPRINTER, tenant_id: 'tenant-OTHER' };
    const bridge = makeBridge(db, events, otherTenant);

    const res = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });

    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('sale_not_found');
  });

  it('no session refuses with no_session', async () => {
    const events: SaleAuditEvent[] = [];
    const bridge = makeBridge(db, events, null);

    const res = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });

    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('no_session');
  });
});

describe('T412 — receipts.reprint role rule (RT-546 / OD-534-2)', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
    seedSuccessfulFirstPrint(db, 'pe-first-1');
  });

  it.each(['manager', 'admin'] as const)('role %s can reprint any sale', async (role) => {
    const events: SaleAuditEvent[] = [];
    const bridge = makeBridge(db, events, { ...REPRINTER, role });

    const res = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });

    expect(res.kind).toBe('ok');
  });

  it('a cashier can reprint their own sale', async () => {
    const events: SaleAuditEvent[] = [];
    const seller: OperatorSessionForSales = {
      ...REPRINTER,
      role: 'cashier',
      operator_id: 'op-selling',
    };
    const bridge = makeBridge(db, events, seller);

    const res = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });

    expect(res.kind).toBe('ok');
  });

  it("a cashier cannot reprint another operator's sale (sale_not_found, no print)", async () => {
    const events: SaleAuditEvent[] = [];
    const bridge = makeBridge(db, events, { ...REPRINTER, role: 'cashier' });

    const res = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });

    expect(res).toEqual({ kind: 'refused', reason: 'sale_not_found' });
    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    expect(rows.filter((r) => r.purpose === 'reprint')).toEqual([]);
  });
});
