/**
 * T352 (retry seam) — receipts.retryPrint chains the drawer-kick on success.
 *
 * FR-052: a retry that succeeds IS the canonical first print, so it must run
 * the SAME drawer gating an auto-fired first print does (cash-inclusive →
 * kick). This is the second drawer-kick wiring point (the first is
 * `dispatchFirstPrintOnFinalize`); a cash sale whose first print FAILED, then
 * succeeds on cashier Retry, MUST open the drawer — otherwise the till stays
 * shut with no open path (PRODUCT.md Principle 3, silent-behavior class).
 *
 * Real sql.js DB (sales + print_events + drawer_events), real repos + dispatcher
 * + drawer dispatcher; only the two hardware transports are faked.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createReceiptsBridge } from '../../../../src/main/receipts/receipts-bridge.js';
import { createPrintDispatcher } from '../../../../src/main/receipts/print-dispatcher.js';
import { createPrintPipeline } from '../../../../src/main/receipts/print-pipeline.js';
import { createDrawerKickDispatcher } from '../../../../src/main/drawer/drawer-kick.js';
import type {
  DrawerKickTransport,
  DrawerKickResult,
} from '../../../../src/main/drawer/drawer-kick-transport.js';
import { bindPrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import { bindDrawerEventsRepository } from '../../../../src/main/sales/repositories/drawer-events.repository.js';
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
  '0023_create_drawer_events.sql',
  '0028_extend_sales_with_lines_json.sql',
  '0052_drawer_events_suppression_no_drawer.sql',
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
  operator_id: 'op-retry',
  operator_session_id: 'sess-retry',
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
       'op-abc','Mohamed Ahmed','sess-1',
       5500,0,0,'[{"tender_type":"cash","amount_applied_minor":5500,"change_due_minor":0}]',
       '2026-05-27T10:00:05.000Z','2026-05-27T10:00:06.000Z','TRN-100','Maadi Branch','12 Road 9',
       '2026-05-27','[{"line_id":"l1","item_ref":"SKU-001","display_name":"Paracetamol","quantity":1,"unit_price_minor":5500,"line_subtotal_minor":5500,"note":null,"version":1,"last_action_id":"a1"}]'
     )`,
  );
}

function seedCashlessSale(db: SqlJsDatabase): void {
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (
       'sale-2','TERM-01-2026-05-27-000002','TERM-01-2026-05-27-000002','handoff-2','pa-2',
       'cart-2','tenant-1','branch-1','terminal-1','TERM-01',
       'op-abc','Mohamed Ahmed','sess-1',
       5500,0,0,'[{"tender_type":"external_card_terminal","amount_applied_minor":5500,"external_reference":"AUTH-9"}]',
       '2026-05-27T10:00:05.000Z','2026-05-27T10:00:06.000Z','TRN-100','Maadi Branch','12 Road 9',
       '2026-05-27','[{"line_id":"l1","item_ref":"SKU-001","display_name":"Paracetamol","quantity":1,"unit_price_minor":5500,"line_subtotal_minor":5500,"note":null,"version":1,"last_action_id":"a1"}]'
     )`,
  );
}

function seedFailedPrint(db: SqlJsDatabase, id: string, sale_id = 'sale-1'): void {
  db.run(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES (?, ?, 'failure', 'first_print', 'escpos_direct',
       'op-abc', 'sess-1', NULL, 'printer_offline', NULL, '2026-05-27T10:00:07.000Z')`,
    [id, sale_id],
  );
}

function makeBridge(db: SqlJsDatabase, kickResult: DrawerKickResult) {
  const handle = makeSqlJsHandle(db);
  const events: SaleAuditEvent[] = [];
  const auditEmitter = createSaleAuditEmitter({ sink: { write: (e) => events.push(e) } });
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
  let pseq = 0;
  const printDispatcher = createPrintDispatcher({
    pipeline,
    printEventsRepo: bindPrintEventsRepository(handle),
    auditEmitter,
    now: () => '2026-05-27T10:00:09.000Z',
    newPrintEventId: () => `pe-retry-${String((pseq += 1))}`,
  });
  const kick = vi.fn((): Promise<DrawerKickResult> => Promise.resolve(kickResult));
  const transport: DrawerKickTransport = { kick };
  let dseq = 0;
  const drawerKickDispatcher = createDrawerKickDispatcher({
    drawerEventsRepo: bindDrawerEventsRepository(handle),
    transport,
    auditEmitter,
    now: () => '2026-05-27T10:00:10.000Z',
    newDrawerEventId: () => `de-${String((dseq += 1))}`,
  });
  const bridge = createReceiptsBridge({
    getCurrentSession: () => SESSION,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    printDispatcher,
    drawerKickDispatcher,
  });
  return { bridge, events, kick };
}

describe('T352 retry seam — drawer-kick chains on retry success', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
  });

  it('cash sale: a successful Retry opens the drawer + writes an opened row (FR-052)', async () => {
    seedCashSale(db);
    seedFailedPrint(db, 'pe-failed-1');
    const { bridge, events, kick } = makeBridge(db, { ok: true });

    const res = await bridge.retryPrint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.outcome).toBe('success');

    // The drawer kicked exactly once, and an opened row was written, FK'd to
    // the RETRY print event (not the failed first print).
    expect(kick).toHaveBeenCalledTimes(1);
    const drawerRow = bindDrawerEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    expect(drawerRow?.outcome).toBe('opened');
    expect(drawerRow?.triggering_print_event_id).toBe('pe-retry-1');
    expect(events.some((e) => e.action_category === 'sale.drawer.opened')).toBe(true);
  });

  it('cash sale: a successful Retry on a terminal with no drawer writes a suppressed row, no failure (RT-531)', async () => {
    seedCashSale(db);
    seedFailedPrint(db, 'pe-failed-1');
    const { bridge, events } = makeBridge(db, {
      ok: false,
      failure_reason: 'no_drawer_configured',
    });

    const res = await bridge.retryPrint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.outcome).toBe('success');
    const drawerRow = bindDrawerEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    expect(drawerRow?.outcome).toBe('suppressed');
    expect(drawerRow?.suppression_reason).toBe('no_drawer_configured');
    expect(drawerRow?.failure_reason).toBeNull();
    expect(events.some((e) => e.action_category === 'sale.drawer.suppressed')).toBe(true);
    expect(events.some((e) => e.action_category === 'sale.drawer.failed')).toBe(false);
  });

  it('cash sale: a successful Retry whose configured drawer fails still writes a failed row + banner anchor', async () => {
    seedCashSale(db);
    seedFailedPrint(db, 'pe-failed-1');
    const { bridge, events } = makeBridge(db, {
      ok: false,
      failure_reason: 'printer_dk_failure',
    });

    const res = await bridge.retryPrint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });
    // The print retry still succeeds — the drawer fault does NOT refuse it.
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.outcome).toBe('success');
    const drawerRow = bindDrawerEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    expect(drawerRow?.outcome).toBe('failed');
    expect(drawerRow?.failure_reason).toBe('printer_dk_failure');
    expect(events.some((e) => e.action_category === 'sale.drawer.failed')).toBe(true);
  });

  it('cashless sale: a successful Retry suppresses the drawer (no kick)', async () => {
    seedCashlessSale(db);
    seedFailedPrint(db, 'pe-failed-2', 'sale-2');
    const { bridge, events, kick } = makeBridge(db, { ok: true });

    const res = await bridge.retryPrint({ sale_id: 'sale-2' as SaleId, idempotency_key: 'idem-2' });
    expect(res.kind).toBe('ok');
    expect(kick).not.toHaveBeenCalled();
    const drawerRow = bindDrawerEventsRepository(makeSqlJsHandle(db)).readBySale('sale-2');
    expect(drawerRow?.outcome).toBe('suppressed');
    expect(drawerRow?.suppression_reason).toBe('cashless_tender_mix');
    expect(events.some((e) => e.action_category === 'sale.drawer.suppressed')).toBe(true);
  });

  it('a still-failed Retry does NOT touch the drawer (no row, no kick)', async () => {
    // The retry print itself fails → no drawer decision yet (the drawer chains
    // ONLY on print success). A later successful retry will make it.
    seedCashSale(db);
    seedFailedPrint(db, 'pe-failed-1');
    const handle = makeSqlJsHandle(db);
    const events: SaleAuditEvent[] = [];
    const auditEmitter = createSaleAuditEmitter({ sink: { write: (e) => events.push(e) } });
    const pipeline = createPrintPipeline({
      escposAdapter: {
        render_path: 'escpos_direct',
        print: () =>
          Promise.resolve({
            ok: false as const,
            render_path: 'escpos_direct' as const,
            failure_reason: 'printer_offline' as const,
          }),
      },
      osPrintAdapter: {
        render_path: 'os_print',
        print: () => Promise.resolve({ ok: true as const, render_path: 'os_print' as const }),
      },
      probeEscposSupport: () => Promise.resolve(true),
    });
    let pseq = 0;
    const printDispatcher = createPrintDispatcher({
      pipeline,
      printEventsRepo: bindPrintEventsRepository(handle),
      auditEmitter,
      now: () => '2026-05-27T10:00:09.000Z',
      newPrintEventId: () => `pe-retry-${String((pseq += 1))}`,
    });
    const kick = vi.fn((): Promise<DrawerKickResult> => Promise.resolve({ ok: true }));
    const drawerKickDispatcher = createDrawerKickDispatcher({
      drawerEventsRepo: bindDrawerEventsRepository(handle),
      transport: { kick },
      auditEmitter,
      now: () => '2026-05-27T10:00:10.000Z',
      newDrawerEventId: () => 'de-x',
    });
    const bridge = createReceiptsBridge({
      getCurrentSession: () => SESSION,
      salesRepo: bindSalesRepository(handle),
      printEventsRepo: bindPrintEventsRepository(handle),
      printDispatcher,
      drawerKickDispatcher,
    });

    const res = await bridge.retryPrint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-3' });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.outcome).toBe('failure');
    expect(kick).not.toHaveBeenCalled();
    expect(bindDrawerEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1')).toBeNull();
  });
});
