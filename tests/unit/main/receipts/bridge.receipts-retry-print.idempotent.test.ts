/**
 * T253 + gate cases — receipts.retryPrint idempotency + refusals (RED).
 *
 *   T253 (Path A, key-on-state): a sale that ALREADY has a successful (or
 *        manual_override) print is a no-op — the retry returns the original
 *        success outcome and does NOT re-dispatch the pipeline (FR-052
 *        double-print guard). The contract's payload-mismatch arm is
 *        unreachable for a sale-scoped key (Ahmed 2026-05-29).
 *
 *   Gate cases: no_session, tenant-scoped sale_not_found,
 *   forbidden_field_in_request — all refuse BEFORE any print.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createReceiptsBridge } from '../../../../src/main/receipts/receipts-bridge.js';
import { bindPrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import type { OperatorSessionForSales } from '../../../../src/main/sales/sales-bridge.js';
import type { PrintDispatcher } from '../../../../src/main/receipts/print-dispatcher.js';
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

const SESSION: OperatorSessionForSales = {
  role: 'manager',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  operator_id: 'op-retry',
  operator_session_id: 'sess-retry',
};

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
       'op-abc','Mohamed Ahmed','sess-1',
       5500,0,0,'[{"tender_type":"cash","amount_applied_minor":5500,"change_due_minor":0}]',
       '2026-05-27T10:00:05.000Z','2026-05-27T10:00:06.000Z','TRN-100','Maadi Branch','12 Road 9',
       '2026-05-27','[{"line_id":"l1","item_ref":"SKU-001","display_name":"Paracetamol","quantity":1,"unit_price_minor":5500,"line_subtotal_minor":5500,"note":null,"version":1,"last_action_id":"a1"}]'
     )`,
  );
}

function seedSuccessPrint(db: SqlJsDatabase): void {
  db.run(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES ('pe-ok-1', 'sale-1', 'success', 'first_print', 'escpos_direct',
       'op-abc', 'sess-1', NULL, NULL, NULL, '2026-05-27T10:00:08.000Z')`,
  );
}

function neverDispatcher(): Pick<PrintDispatcher, 'dispatchRetryPrint'> {
  return {
    dispatchRetryPrint: vi.fn(() =>
      Promise.resolve({
        result: { ok: true as const, render_path: 'escpos_direct' as const },
        print_event_id: 'should-not-happen',
        printed_at: 'x',
      }),
    ),
  };
}

describe('T253 — retryPrint idempotency (already-printed no-op)', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
    seedSuccessPrint(db);
  });

  it('returns the original success outcome and does NOT re-dispatch', async () => {
    const handle = makeSqlJsHandle(db);
    const dispatcher = neverDispatcher();
    const bridge = createReceiptsBridge({
      getCurrentSession: () => SESSION,
      salesRepo: bindSalesRepository(handle),
      printEventsRepo: bindPrintEventsRepository(handle),
      printDispatcher: dispatcher,
    });

    const res = await bridge.retryPrint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-x' });

    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.outcome).toBe('success');
      expect(res.print_event_id).toBe('pe-ok-1');
    }
    expect(dispatcher.dispatchRetryPrint).not.toHaveBeenCalled();
  });

  it('treats a prior manual_override as NON-terminal — a later retry runs (Slice 6, Ahmed 2026-05-30)', async () => {
    // NARROWED in Slice 6: the retry idempotency guard keys on outcome='success'
    // ONLY, not 'manual_override'. A sale that took a manual override can still
    // be retried once the printer is back online (contract
    // §receipts.manualOverride). So the retry DISPATCHES rather than no-opping.
    // Insert the sale FIRST (print_events.sale_id FK → sales.sale_id).
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
         5500,0,0,'[{"tender_type":"cash","amount_applied_minor":5500,"change_due_minor":0}]',
         '2026-05-27T10:00:05.000Z','2026-05-27T10:00:06.000Z','TRN-100','Maadi Branch','12 Road 9',
         '2026-05-27','[{"line_id":"l1","item_ref":"SKU-001","display_name":"X","quantity":1,"unit_price_minor":5500,"line_subtotal_minor":5500,"note":null,"version":1,"last_action_id":"a1"}]'
       )`,
    );
    db.run(
      `INSERT INTO print_events (
         print_event_id, sale_id, outcome, purpose, render_path,
         acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
         failure_reason, previous_failed_print_event_ids, printed_at
       ) VALUES ('pe-mo-1', 'sale-2', 'manual_override', 'first_print', NULL,
         'op-abc', 'sess-1', NULL, NULL, NULL, '2026-05-27T10:00:09.000Z')`,
    );
    const handle = makeSqlJsHandle(db);
    const dispatcher = neverDispatcher();
    const bridge = createReceiptsBridge({
      getCurrentSession: () => SESSION,
      salesRepo: bindSalesRepository(handle),
      printEventsRepo: bindPrintEventsRepository(handle),
      printDispatcher: dispatcher,
    });

    const res = await bridge.retryPrint({ sale_id: 'sale-2' as SaleId, idempotency_key: 'k' });

    // The retry DISPATCHED (manual_override did not block it) — it did not no-op
    // on the pe-mo-1 row.
    expect(dispatcher.dispatchRetryPrint).toHaveBeenCalled();
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok' && res.outcome === 'success') {
      expect(res.print_event_id).not.toBe('pe-mo-1');
    }
  });

  it('refuses sale_not_found when lines_json is malformed (derivation degrades)', async () => {
    db.run(
      `INSERT INTO sales (
         sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
         envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
         selling_operator_id, selling_operator_display_name, selling_operator_session_id,
         subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
         settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
         local_calendar_day, lines_json
       ) VALUES (
         'sale-3-bad','TERM-01-2026-05-27-000003','TERM-01-2026-05-27-000003','handoff-3','pa-3',
         'cart-3','tenant-1','branch-1','terminal-1','TERM-01',
         'op-abc','Mohamed Ahmed','sess-1',
         5500,0,0,'[{"tender_type":"cash","amount_applied_minor":5500}]',
         '2026-05-27T10:00:05.000Z','2026-05-27T10:00:06.000Z','TRN-100','Maadi Branch','12 Road 9',
         '2026-05-27','not-json'
       )`,
    );
    const handle = makeSqlJsHandle(db);
    const bridge = createReceiptsBridge({
      getCurrentSession: () => SESSION,
      salesRepo: bindSalesRepository(handle),
      printEventsRepo: bindPrintEventsRepository(handle),
      printDispatcher: neverDispatcher(),
    });
    const res = await bridge.retryPrint({ sale_id: 'sale-3-bad' as SaleId, idempotency_key: 'k' });
    expect(res).toEqual({ kind: 'refused', reason: 'sale_not_found' });
  });
});

describe('receipts.retryPrint — gate refusals', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
  });

  function bridgeWith(session: OperatorSessionForSales | null) {
    const handle = makeSqlJsHandle(db);
    return createReceiptsBridge({
      getCurrentSession: () => session,
      salesRepo: bindSalesRepository(handle),
      printEventsRepo: bindPrintEventsRepository(handle),
      printDispatcher: neverDispatcher(),
    });
  }

  it('refuses no_session when no operator is signed in', async () => {
    const res = await bridgeWith(null).retryPrint({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'k',
    });
    expect(res).toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it('refuses sale_not_found for a sale in another tenant', async () => {
    const res = await bridgeWith({ ...SESSION, tenant_id: 'other-tenant' }).retryPrint({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'k',
    });
    expect(res).toEqual({ kind: 'refused', reason: 'sale_not_found' });
  });

  it('refuses sale_not_found for an unknown sale id', async () => {
    const res = await bridgeWith(SESSION).retryPrint({
      sale_id: 'no-such-sale' as SaleId,
      idempotency_key: 'k',
    });
    expect(res).toEqual({ kind: 'refused', reason: 'sale_not_found' });
  });

  it('refuses forbidden_field_in_request when the payload carries a forbidden key', async () => {
    const res = await bridgeWith(SESSION).retryPrint({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'k',
      // The forbidden KEY ('pan') is what trips the guard — the value is
      // irrelevant. A non-card placeholder avoids PAN-like literals in source
      // (CodeRabbit #280: compliance/secret-scanner hygiene).
      pan: 'forbidden-test-value',
    } as unknown as Parameters<ReturnType<typeof bridgeWith>['retryPrint']>[0]);
    expect(res).toEqual({ kind: 'refused', reason: 'forbidden_field_in_request' });
  });

  it('degrades to sale_not_found when the dispatcher throws an INFRA error', async () => {
    // No-unhandled-rejection guard (CodeRabbit #280): a dispatcher throw must
    // not reject the IPC call with an unstructured error.
    const handle = makeSqlJsHandle(db);
    const bridge = createReceiptsBridge({
      getCurrentSession: () => SESSION,
      salesRepo: bindSalesRepository(handle),
      printEventsRepo: bindPrintEventsRepository(handle),
      printDispatcher: {
        dispatchRetryPrint: vi.fn(() => Promise.reject(new Error('db exploded'))),
      },
    });
    const res = await bridge.retryPrint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'k' });
    expect(res).toEqual({ kind: 'refused', reason: 'sale_not_found' });
  });
});
