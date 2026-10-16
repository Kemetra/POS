/**
 * T403 / T403a — reprint does NOT mutate the Sale + receipt-number invariance (RED).
 *
 *   T403  snapshot the `sales` row before and after a reprint cycle; assert it
 *         is byte-identical. The AD-3 append-only trigger would reject any
 *         UPDATE anyway — this asserts the application code never even tries.
 *   T403a receipt-number invariance (FR-011): finalize → reprint → reprint;
 *         (a) the rendered payload's receipt_number is the SAME on every copy;
 *         (b) the sales.receipt_number column is unchanged at every step;
 *         (c) duplicate_copy_sequence_number is NULL on first print, 1 on the
 *             first reprint, 2 on the second reprint.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createReceiptsBridge } from '../../../src/main/receipts/receipts-bridge.js';
import { createPrintDispatcher } from '../../../src/main/receipts/print-dispatcher.js';
import { createPrintPipeline } from '../../../src/main/receipts/print-pipeline.js';
import { bindPrintEventsRepository } from '../../../src/main/sales/repositories/print-events.repository.js';
import { bindSalesRepository } from '../../../src/main/sales/repositories/sales.repository.js';
import { createSaleAuditEmitter } from '../../../src/main/sales/audit-emitter.js';
import { deriveReceiptPayload } from '../../../src/main/receipts/receipts-payload.js';
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

function snapshotSaleRow(db: SqlJsDatabase): string {
  const stmt = db.prepare('SELECT * FROM sales WHERE sale_id = ?');
  stmt.bind(['sale-1']);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return JSON.stringify(row);
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
  let seq = 0;
  const printDispatcher = createPrintDispatcher({
    pipeline,
    printEventsRepo: bindPrintEventsRepository(handle),
    auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
    now: () => '2026-05-27T10:00:09.000Z',
    newPrintEventId: () => `pe-reprint-${String(++seq)}`,
  });
  return createReceiptsBridge({
    getCurrentSession: () => SESSION,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    printDispatcher,
  });
}

describe('T403 — reprint does not mutate the Sale row', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
    seedSuccessfulFirstPrint(db, 'pe-first-1');
  });

  it('the sales row is byte-identical before and after a reprint', async () => {
    const bridge = makeBridge(db);
    const before = snapshotSaleRow(db);

    const res = await bridge.reprint({ sale_id: 'sale-1' as SaleId, idempotency_key: 'idem-1' });
    expect(res.kind).toBe('ok');

    const after = snapshotSaleRow(db);
    expect(after).toBe(before);
  });
});

describe('T403a — receipt-number invariance across reprints', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
    seedSuccessfulFirstPrint(db, 'pe-first-1');
  });

  it('receipt_number is invariant; duplicate seq is null/1/2 across first print + two reprints', async () => {
    const bridge = makeBridge(db);
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));

    const firstReprint = await bridge.reprint({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'idem-1',
    });
    const secondReprint = await bridge.reprint({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'idem-2',
    });

    expect(firstReprint.kind).toBe('ok');
    expect(secondReprint.kind).toBe('ok');
    if (firstReprint.kind === 'ok') expect(firstReprint.duplicate_copy_sequence_number).toBe(1);
    if (secondReprint.kind === 'ok') expect(secondReprint.duplicate_copy_sequence_number).toBe(2);

    // (b) sales.receipt_number unchanged.
    const sale = bindSalesRepository(makeSqlJsHandle(db)).readById('sale-1');
    expect(sale?.receipt_number).toBe('TERM-01-2026-05-27-000001');

    // (a) the RENDERED payload's receipt_number is invariant on every copy
    // (first_print + each reprint_duplicate) — asserted through the
    // payload-derivation path the slip actually uses (G1 remediation).
    if (sale !== null) {
      const firstPrintPayload = deriveReceiptPayload(sale, { variant: 'first_print' });
      const reprint1Payload = deriveReceiptPayload(sale, {
        variant: 'reprint_duplicate',
        duplicate_copy_sequence_number: 1,
        reprinted_at: '2026-05-27T10:00:09.000Z',
      });
      const reprint2Payload = deriveReceiptPayload(sale, {
        variant: 'reprint_duplicate',
        duplicate_copy_sequence_number: 2,
        reprinted_at: '2026-05-27T10:00:10.000Z',
      });
      expect(firstPrintPayload.receipt_number).toBe('TERM-01-2026-05-27-000001');
      expect(reprint1Payload.receipt_number).toBe('TERM-01-2026-05-27-000001');
      expect(reprint2Payload.receipt_number).toBe('TERM-01-2026-05-27-000001');
    }

    // (c) first print seq NULL, reprints 1 and 2.
    const rows = repo.readBySale('sale-1');
    const firstPrint = rows.find((r) => r.purpose === 'first_print');
    const reprints = rows
      .filter((r) => r.purpose === 'reprint')
      .sort(
        (a, b) => (a.duplicate_copy_sequence_number ?? 0) - (b.duplicate_copy_sequence_number ?? 0),
      );
    expect(firstPrint?.duplicate_copy_sequence_number).toBeNull();
    expect(reprints.map((r) => r.duplicate_copy_sequence_number)).toEqual([1, 2]);
  });
});
