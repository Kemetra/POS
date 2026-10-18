/**
 * T242 — receipt payload never logged / audited (RED).
 *
 * FR-071 inheritance + AD-9 redaction: the full receipt payload (HTML or
 * ESC/POS bytes) MUST NOT appear in any pino log line, audit-event row, or
 * support bundle.
 *
 * This asserts by VALUE, not by key name. The audit emitter's forbidden-key
 * scan is key-name based and would happily pass a payload carrying the slip
 * under an innocuous key. So the dispatcher's audit + log payloads must carry
 * ONLY structural fields (sale_id / render_path / print_event_id /
 * failure_reason) — never the rendered content. We seed a distinctive item
 * name and assert that string is absent from every captured log arg + event.
 */

import { describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';

import { createPrintDispatcher } from '../../../../src/main/receipts/print-dispatcher.js';
import type { PrintDispatchLogger } from '../../../../src/main/receipts/print-dispatcher.js';
import { createPrintPipeline } from '../../../../src/main/receipts/print-pipeline.js';
import { bindPrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import { createSaleAuditEmitter } from '../../../../src/main/sales/audit-emitter.js';
import type { SaleAuditEvent } from '../../../../src/main/sales/audit-emitter.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReceiptPayload } from '../../../../src/shared/receipts/types.js';
import type { SaleId, SaleNumber } from '../../../../src/shared/sales/types.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0004_audit_events.sql',
  '0020_create_sales.sql',
  '0022_create_print_events.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

const SENTINEL = 'Paracetamol-SENTINEL-500mg';

function payload(): ReceiptPayload {
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
        display_name: SENTINEL,
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
  sale_id: 'sale-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  session_id: 'sess-1',
  attribution_operator_id: 'op-clerk-1',
};

describe('T242 — receipt payload is never logged or audited (by value)', () => {
  it('the sentinel item name appears in NO log arg and NO audit event', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = OFF;');
    for (const sql of MIGRATIONS) db.exec(sql);

    const logArgs: unknown[] = [];
    const capture = (...args: unknown[]): void => {
      logArgs.push(...args);
    };
    const logger: PrintDispatchLogger = {
      info: vi.fn(capture),
      warn: vi.fn(capture),
    };
    const events: SaleAuditEvent[] = [];

    const pipeline = createPrintPipeline({
      escposAdapter: {
        render_path: 'escpos_direct',
        print: vi.fn(() =>
          Promise.resolve({ ok: true as const, render_path: 'escpos_direct' as const }),
        ),
      },
      osPrintAdapter: {
        render_path: 'os_print',
        print: vi.fn(() =>
          Promise.resolve({ ok: true as const, render_path: 'os_print' as const }),
        ),
      },
      probeEscposSupport: () => Promise.resolve(true),
    });
    const dispatcher = createPrintDispatcher({
      pipeline,
      printEventsRepo: bindPrintEventsRepository(makeSqlJsHandle(db)),
      auditEmitter: createSaleAuditEmitter({ sink: { write: (e) => events.push(e) } }),
      now: () => '2026-05-27T10:00:07.000Z',
      newPrintEventId: () => 'pe-1',
      logger,
    });

    await dispatcher.dispatchFirstPrint(payload(), CTX);

    const haystack = JSON.stringify({ logArgs, events });
    expect(haystack).not.toContain(SENTINEL);
    expect(haystack).not.toContain('Paracetamol');
  });
});
