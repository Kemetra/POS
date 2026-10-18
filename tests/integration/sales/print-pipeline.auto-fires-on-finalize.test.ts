/**
 * T240 — print dispatcher fires on AD-2 finalize completion (RED).
 *
 * The print dispatcher renders the payload, dispatches via the pipeline, then
 * on success INSERTs a `print_events` row (`purpose='first_print',
 * outcome='success'`) and emits a `sale.receipt.printed` audit event carrying
 * `render_path` + `print_event_id` (and NEVER the slip content).
 *
 * Integration-level: a real sql.js DB with the print_events migration, a real
 * print-events repository, and a captured audit sink — only the print
 * *transport* is faked (no hardware).
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
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function payload(over: Partial<ReceiptPayload> = {}): ReceiptPayload {
  return {
    variant: 'first_print',
    sale_id: 'sale-1' as SaleId,
    sale_number: 'TERM-01-2026-05-27-000001' as SaleNumber,
    receipt_number: 'TERM-01-2026-05-27-000001',
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
    ...over,
  };
}

function makeDispatcher(db: SqlJsDatabase, events: SaleAuditEvent[], escposOk = true) {
  const handle = makeSqlJsHandle(db);
  const printEventsRepo = bindPrintEventsRepository(handle);
  const auditEmitter = createSaleAuditEmitter({ sink: { write: (e) => events.push(e) } });
  const pipeline = createPrintPipeline({
    escposAdapter: {
      render_path: 'escpos_direct',
      print: vi.fn(() =>
        Promise.resolve({ ok: true as const, render_path: 'escpos_direct' as const }),
      ),
    },
    osPrintAdapter: {
      render_path: 'os_print',
      print: vi.fn(() => Promise.resolve({ ok: true as const, render_path: 'os_print' as const })),
    },
    probeEscposSupport: () => Promise.resolve(escposOk),
  });
  let seq = 0;
  return createPrintDispatcher({
    pipeline,
    printEventsRepo,
    auditEmitter,
    now: () => '2026-05-27T10:00:07.000Z',
    newPrintEventId: () => `pe-${String(++seq)}`,
  });
}

const CTX = {
  sale_id: 'sale-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  session_id: 'sess-1',
  attribution_operator_id: 'op-clerk-1',
};

describe('T240 — print dispatcher fires on finalize (success path)', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = OFF;'); // print_events FK → sales not seeded here
    for (const sql of MIGRATIONS) db.exec(sql);
  });

  it('renders + dispatches + INSERTs a first_print success row + emits sale.receipt.printed', async () => {
    const events: SaleAuditEvent[] = [];
    const dispatcher = makeDispatcher(db, events);

    const { result } = await dispatcher.dispatchFirstPrint(payload(), CTX);

    expect(result.ok).toBe(true);

    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe('first_print');
    expect(rows[0].outcome).toBe('success');
    expect(rows[0].render_path).toBe('escpos_direct');

    const printed = events.find((e) => e.action_category === 'sale.receipt.printed');
    expect(printed).toBeDefined();
    expect(printed?.payload.render_path).toBe('escpos_direct');
    expect(printed?.payload.print_event_id).toBe('pe-1');
  });

  it('records render_path=os_print when the printer lacks ESC/POS support', async () => {
    const events: SaleAuditEvent[] = [];
    const dispatcher = makeDispatcher(db, events, /* escposOk */ false);

    await dispatcher.dispatchFirstPrint(payload(), CTX);

    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    expect(rows[0].render_path).toBe('os_print');
    const printed = events.find((e) => e.action_category === 'sale.receipt.printed');
    expect(printed?.payload.render_path).toBe('os_print');
  });

  it('works with no injected logger (default no-op) and a null session_id', async () => {
    // Exercises the `logger ?? NOOP_LOGGER` default arm + the
    // `session_id ?? ''` null branch on the print_events row.
    const events: SaleAuditEvent[] = [];
    const dispatcher = makeDispatcher(db, events);
    const { result } = await dispatcher.dispatchFirstPrint(payload(), { ...CTX, session_id: null });
    expect(result.ok).toBe(true);
    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    expect(rows[0].acting_operator_session_id).toBe('');
  });
});
