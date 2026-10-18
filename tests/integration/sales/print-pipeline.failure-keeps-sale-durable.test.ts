/**
 * T241 — print failure keeps the Sale durable (RED).
 *
 * On a failed print the dispatcher INSERTs a `print_events` row with
 * `outcome='failure'` + a closed `failure_reason`, emits a
 * `sale.receipt.print_failed` audit event, and the Sale row remains
 * untouched (the print is NOT part of the AD-2 atomic transaction).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPrintDispatcher } from '../../../src/main/receipts/print-dispatcher.js';
import { createPrintPipeline } from '../../../src/main/receipts/print-pipeline.js';
import { bindPrintEventsRepository } from '../../../src/main/sales/repositories/print-events.repository.js';
import { createSaleAuditEmitter } from '../../../src/main/sales/audit-emitter.js';
import type { SaleAuditEvent } from '../../../src/main/sales/audit-emitter.js';
import { makeSqlJsHandle } from '../../unit/main/cart/__helpers__/sql-js-handle.js';
import type { ReceiptPayload } from '../../../src/shared/receipts/types.js';
import type { SaleId, SaleNumber } from '../../../src/shared/sales/types.js';

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

function payload(): ReceiptPayload {
  return {
    variant: 'first_print',
    sale_id: 'sale-9' as SaleId,
    sale_number: 'TERM-01-2026-05-27-000009' as SaleNumber,
    receipt_number: 'TERM-01-2026-05-27-000009',
    tenant_tax_registration_id: 'TRN-100',
    branch_name: 'Maadi Branch',
    branch_address: '12 Road 9',
    terminal_label: 'TERM-01',
    selling_operator_display_name: 'Mohamed Ahmed',
    subtotal_minor: 5500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    lines: [
      {
        item_ref: 'SKU-001',
        display_name: 'Paracetamol 500mg',
        quantity: 1,
        unit_price_minor: 5500,
        line_subtotal_minor: 5500,
        note: null,
      },
    ],
    tender_lines_summary: [
      { tender_type: 'cash', amount_applied_minor: 5500, change_due_minor: 0 },
    ],
    settled_at: '2026-05-27T10:00:05.000Z',
    finalized_at: '2026-05-27T10:00:06.000Z',
    local_calendar_day: '2026-05-27',
  };
}

const CTX = {
  sale_id: 'sale-9',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  session_id: 'sess-1',
  attribution_operator_id: 'op-clerk-1',
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
       'sale-9','TERM-01-2026-05-27-000009','TERM-01-2026-05-27-000009','handoff-9','pa-9',
       'cart-9','tenant-1','branch-1','terminal-1','TERM-01',
       'op-abc','Mohamed Ahmed','sess-1',
       5500,0,0,'[{"tender_type":"cash","amount_applied_minor":5500,"change_due_minor":0}]',
       '2026-05-27T10:00:05.000Z','2026-05-27T10:00:06.000Z','TRN-100','Maadi Branch','12 Road 9',
       '2026-05-27','[]'
     )`,
  );
}

function failingDispatcher(db: SqlJsDatabase, events: SaleAuditEvent[]) {
  const handle = makeSqlJsHandle(db);
  const pipeline = createPrintPipeline({
    escposAdapter: {
      render_path: 'escpos_direct',
      print: vi.fn(() =>
        Promise.resolve({
          ok: false as const,
          render_path: 'escpos_direct' as const,
          failure_reason: 'printer_out_of_paper' as const,
        }),
      ),
    },
    osPrintAdapter: {
      render_path: 'os_print',
      print: vi.fn(() => Promise.resolve({ ok: true as const, render_path: 'os_print' as const })),
    },
    probeEscposSupport: () => Promise.resolve(true),
  });
  let seq = 0;
  return createPrintDispatcher({
    pipeline,
    printEventsRepo: bindPrintEventsRepository(handle),
    auditEmitter: createSaleAuditEmitter({ sink: { write: (e) => events.push(e) } }),
    now: () => '2026-05-27T10:00:07.000Z',
    newPrintEventId: () => `pe-${String(++seq)}`,
  });
}

describe('T241 — print failure keeps the Sale durable', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
  });

  it('writes a failure row + emits print_failed + leaves the Sale row unchanged', async () => {
    const events: SaleAuditEvent[] = [];
    const dispatcher = failingDispatcher(db, events);

    const { result } = await dispatcher.dispatchFirstPrint(payload(), CTX);

    expect(result.ok).toBe(false);

    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-9');
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failure');
    expect(rows[0].failure_reason).toBe('printer_out_of_paper');

    const failed = events.find((e) => e.action_category === 'sale.receipt.print_failed');
    expect(failed).toBeDefined();
    expect(failed?.payload.failure_reason).toBe('printer_out_of_paper');
    // render_path is structural metadata present on BOTH success + failure
    // audits (CodeRabbit #280) — T242-safe (not slip content).
    expect(failed?.payload.render_path).toBe('escpos_direct');

    // Sale row durable: subtotal/finalized_at unchanged, exactly one row.
    const saleStmt = db.prepare(`SELECT subtotal_minor, finalized_at FROM sales WHERE sale_id = ?`);
    saleStmt.bind(['sale-9']);
    saleStmt.step();
    const sale = saleStmt.getAsObject();
    saleStmt.free();
    expect(sale.subtotal_minor).toBe(5500);
    expect(sale.finalized_at).toBe('2026-05-27T10:00:06.000Z');
  });
});
