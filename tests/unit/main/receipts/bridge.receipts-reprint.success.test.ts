/**
 * T400 / T402 — receipts.reprint bridge handler success (RED).
 *
 *   T400 succeeds when a prior PrintEvent with
 *        (purpose='first_print' OR purpose='retry_after_failure') AND
 *        outcome='success' exists; renders via the `reprint_duplicate` variant;
 *        INSERTs a print_events row with purpose='reprint', outcome='success',
 *        duplicate_copy_sequence_number=1 for the first reprint.
 *   T402 the n-th reprint INSERTs duplicate_copy_sequence_number=n, derived from
 *        countReprints(sale_id) (counts only successful reprints).
 *
 * Reprint is TWO-way (success | refused) — NOT three-way like retry. A print
 * failure refuses with `printer_unavailable` (see contracts/bridge-api.md
 * §"receipts.reprint"). Reprint is repeatable (no state-keyed idempotency
 * no-op) and never kicks the drawer (no drawerKickDispatcher wired).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

const SESSION: OperatorSessionForSales = {
  role: 'manager',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  operator_id: 'op-reprinter',
  operator_session_id: 'sess-reprinter',
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

function seedSuccessfulFirstPrint(db: SqlJsDatabase, id: string): void {
  db.run(
    `INSERT INTO print_events (
       print_event_id, sale_id, outcome, purpose, render_path,
       acting_operator_id, acting_operator_session_id, duplicate_copy_sequence_number,
       failure_reason, previous_failed_print_event_ids, printed_at
     ) VALUES (?, 'sale-1', 'success', 'first_print', 'escpos_direct',
       'op-abc', 'sess-1', NULL, NULL, NULL, '2026-05-27T10:00:07.000Z')`,
    [id],
  );
}

function makeBridge(db: SqlJsDatabase, events: SaleAuditEvent[], escposOk: boolean) {
  const handle = makeSqlJsHandle(db);
  const pipeline = createPrintPipeline({
    escposAdapter: {
      render_path: 'escpos_direct',
      print: () =>
        Promise.resolve(
          escposOk
            ? { ok: true as const, render_path: 'escpos_direct' as const }
            : {
                ok: false as const,
                render_path: 'escpos_direct' as const,
                failure_reason: 'printer_offline' as const,
              },
        ),
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
    getCurrentSession: () => SESSION,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    printDispatcher,
    // Same clock the dispatcher uses → the reprint slip time matches the
    // print_events.printed_at row (one clock read per logical event).
    now: () => '2026-05-27T10:00:09.000Z',
  });
}

describe('T400 — receipts.reprint success', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
    seedSuccessfulFirstPrint(db, 'pe-first-1');
  });

  it('reprints a previously-printed sale: reprint row with seq=1, emits sale.receipt.reprinted', async () => {
    const events: SaleAuditEvent[] = [];
    const bridge = makeBridge(db, events, /* escposOk */ true);

    const res = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });

    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.duplicate_copy_sequence_number).toBe(1);
      expect(res.render_path).toBe('escpos_direct');
      expect(typeof res.print_event_id).toBe('string');
      expect(typeof res.reprinted_at).toBe('string');
    }

    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    const reprintRow = rows.find((r) => r.purpose === 'reprint');
    expect(reprintRow).toBeDefined();
    expect(reprintRow?.outcome).toBe('success');
    expect(reprintRow?.duplicate_copy_sequence_number).toBe(1);

    // One clock read per logical event: the response slip time equals the
    // print_events.printed_at row (no wall-clock divergence on a financial slip).
    if (res.kind === 'ok') expect(res.reprinted_at).toBe(reprintRow?.printed_at);

    const audit = events.find((e) => e.action_category === 'sale.receipt.reprinted');
    expect(audit).toBeDefined();
  });
});

describe('T402 — receipts.reprint sequence number', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
    seedSuccessfulFirstPrint(db, 'pe-first-1');
  });

  it('the n-th reprint gets duplicate_copy_sequence_number=n', async () => {
    const events: SaleAuditEvent[] = [];
    const bridge = makeBridge(db, events, /* escposOk */ true);

    const first = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });
    const second = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-2' });
    const third = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-3' });

    expect(first.kind).toBe('ok');
    expect(second.kind).toBe('ok');
    expect(third.kind).toBe('ok');
    if (first.kind === 'ok') expect(first.duplicate_copy_sequence_number).toBe(1);
    if (second.kind === 'ok') expect(second.duplicate_copy_sequence_number).toBe(2);
    if (third.kind === 'ok') expect(third.duplicate_copy_sequence_number).toBe(3);
  });
});

describe('T400 — receipts.reprint print failure refuses with printer_unavailable', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
    seedSuccessfulFirstPrint(db, 'pe-first-1');
  });

  it('a reprint whose print fails refuses with printer_unavailable (two-way, not ok+failure)', async () => {
    const events: SaleAuditEvent[] = [];
    const bridge = makeBridge(db, events, /* escposOk */ false);

    const res = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-x' });

    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('printer_unavailable');
  });
});
