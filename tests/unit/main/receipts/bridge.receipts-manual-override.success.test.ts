/**
 * T500 — receipts.manualOverride success (RED).
 *
 * Cashier invokes manual-receipt override after a print failure. The handler:
 *   - INSERTs a print_events row with purpose='first_print',
 *     outcome='manual_override', render_path=NULL (no print happened);
 *   - emits a sale.receipt.manual_override audit event with overrider
 *     attribution (the CURRENT signed-in operator);
 *   - returns { kind:'ok', print_event_id, purpose:'first_print',
 *     outcome:'manual_override', overridden_at }.
 *
 * No pipeline render runs (there is no slip); the CHECK constraint requires
 * render_path NULL on a manual_override row.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createReceiptsBridge } from '../../../../src/main/receipts/receipts-bridge.js';
import { bindPrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { createSaleAuditEmitter } from '../../../../src/main/sales/audit-emitter.js';
import type { SaleAuditEvent } from '../../../../src/main/sales/audit-emitter.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import type { OperatorSessionForSales } from '../../../../src/main/sales/sales-bridge.js';
import type { PrintDispatcher } from '../../../../src/main/receipts/print-dispatcher.js';
import type { SaleId } from '../../../../src/shared/sales/types.js';

/** manualOverride never touches the dispatcher (no slip is rendered). */
function neverDispatcher(): Pick<PrintDispatcher, 'dispatchRetryPrint' | 'dispatchReprint'> {
  const fail = (): never => {
    throw new Error('dispatcher must not be called by manualOverride');
  };
  return { dispatchRetryPrint: fail, dispatchReprint: fail };
}

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
  operator_id: 'op-overrider',
  operator_session_id: 'sess-overrider',
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
       'op-selling','Mohamed Ahmed','sess-1',
       5500,0,0,'[{"tender_type":"cash","amount_applied_minor":5500,"change_due_minor":0}]',
       '2026-05-27T10:00:05.000Z','2026-05-27T10:00:06.000Z','TRN-100','Maadi Branch','12 Road 9',
       '2026-05-27','[{"line_id":"l1","item_ref":"SKU-001","display_name":"Paracetamol","quantity":1,"unit_price_minor":5500,"line_subtotal_minor":5500,"note":null,"version":1,"last_action_id":"a1"}]'
     )`,
  );
}

function seedFailedPrint(db: SqlJsDatabase, id: string): void {
  db.run(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES (?, 'sale-1', 'failure', 'first_print', 'escpos_direct',
       'op-selling', 'sess-1', NULL, 'printer_offline', NULL, '2026-05-27T10:00:07.000Z')`,
    [id],
  );
}

function makeBridge(db: SqlJsDatabase, events: SaleAuditEvent[]) {
  const handle = makeSqlJsHandle(db);
  return createReceiptsBridge({
    getCurrentSession: () => SESSION,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    // manualOverride writes a print_events row directly via the auditEmitter +
    // repo; it does NOT use the print dispatcher (no slip is rendered). The
    // dispatcher is required by the deps type, so a never-called stub is passed.
    printDispatcher: neverDispatcher(),
    auditEmitter: createSaleAuditEmitter({ sink: { write: (e) => events.push(e) } }),
    now: () => '2026-05-27T10:00:11.000Z',
    newPrintEventId: () => 'pe-mo-1',
  });
}

describe('T500 — receipts.manualOverride success', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
    seedFailedPrint(db, 'pe-failed-1');
  });

  it('writes a manual_override print_events row (render_path NULL) + emits the audit event', async () => {
    const events: SaleAuditEvent[] = [];
    const bridge = makeBridge(db, events);

    const res = await bridge.manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'idem-1',
    });

    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.purpose).toBe('first_print');
      expect(res.outcome).toBe('manual_override');
      expect(res.print_event_id).toBe('pe-mo-1');
      expect(typeof res.overridden_at).toBe('string');
    }

    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    const moRow = rows.find((r) => r.outcome === 'manual_override');
    expect(moRow).toBeDefined();
    expect(moRow?.purpose).toBe('first_print');
    expect(moRow?.render_path).toBeNull();
    // Attribution is the CURRENT (overriding) operator.
    expect(moRow?.acting_operator_id).toBe('op-overrider');

    const audit = events.find((e) => e.action_category === 'sale.receipt.manual_override');
    expect(audit).toBeDefined();
    expect(audit?.payload.sale_id).toBe('sale-1');
  });

  it('degrades to sale_not_found when the durable INSERT throws (infra-throw guard, CodeRabbit #294)', async () => {
    // A code/DB bug in the INSERT (here: a forced throw) must NOT escape as an
    // unstructured IPC rejection — runManualOverride is called synchronously
    // inside Promise.resolve(...), so a throw would reject before a typed
    // refusal could be returned. The handler maps it to sale_not_found (the
    // generic refusal the sibling handlers use), keeping the banner raised.
    const handle = makeSqlJsHandle(db);
    const realRepo = bindPrintEventsRepository(handle);
    const throwingRepo = {
      readBySale: realRepo.readBySale.bind(realRepo),
      hasSuccessfulPrint: realRepo.hasSuccessfulPrint.bind(realRepo),
      countReprints: realRepo.countReprints.bind(realRepo),
      insert: (): never => {
        throw new Error('simulated CHECK / write failure');
      },
    };
    const bridge = createReceiptsBridge({
      getCurrentSession: () => SESSION,
      salesRepo: bindSalesRepository(handle),
      printEventsRepo: throwingRepo,
      printDispatcher: neverDispatcher(),
      auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
      now: () => '2026-05-27T10:00:11.000Z',
      newPrintEventId: () => 'pe-mo-1',
    });

    const res = await bridge.manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'idem-1',
    });

    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('sale_not_found');
  });

  it('succeeds (ok) even when the best-effort audit emit throws (durable row already landed)', async () => {
    // The override print_events row is written BEFORE the audit emit. An emit
    // failure (forbidden-category/key guard or a sink fault) is best-effort —
    // it must NOT turn a recorded override into a refusal. The handler swallows
    // it and still returns ok.
    const handle = makeSqlJsHandle(db);
    const bridge = createReceiptsBridge({
      getCurrentSession: () => SESSION,
      salesRepo: bindSalesRepository(handle),
      printEventsRepo: bindPrintEventsRepository(handle),
      printDispatcher: neverDispatcher(),
      auditEmitter: {
        emitRaw: (): never => {
          throw new Error('simulated audit sink failure');
        },
      },
      now: () => '2026-05-27T10:00:11.000Z',
      newPrintEventId: () => 'pe-mo-1',
    });

    const res = await bridge.manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'idem-1',
    });

    expect(res.kind).toBe('ok');
    // The durable override row landed despite the audit failure.
    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    expect(rows.find((r) => r.outcome === 'manual_override')).toBeDefined();
  });

  it('falls back to the override timestamp as the print_event_id when no id generator is injected', async () => {
    // No `newPrintEventId` dep → the handler falls back to `overridden_at` for
    // the row PK (Slice-2-era construction omits the generator).
    const handle = makeSqlJsHandle(db);
    const bridge = createReceiptsBridge({
      getCurrentSession: () => SESSION,
      salesRepo: bindSalesRepository(handle),
      printEventsRepo: bindPrintEventsRepository(handle),
      printDispatcher: neverDispatcher(),
      auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
      now: () => '2026-05-27T10:00:11.000Z',
      // newPrintEventId intentionally omitted.
    });

    const res = await bridge.manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'idem-1',
    });

    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      // The id falls back to the override timestamp.
      expect(res.print_event_id).toBe('2026-05-27T10:00:11.000Z');
      expect(res.overridden_at).toBe('2026-05-27T10:00:11.000Z');
    }
  });
});
