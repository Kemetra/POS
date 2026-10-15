/**
 * T504 + gate cases — receipts.manualOverride idempotency + refusals (RED).
 *
 *   T504 (Path A, key-on-state): a sale that ALREADY has a manual_override print
 *        is a no-op — a re-fired manualOverride returns the original row's
 *        outcome and does NOT write a second row. The contract's
 *        payload-mismatch arm is unreachable for a sale-scoped key (mirrors
 *        retry's Path A framing).
 *
 *   Gate cases: no_session, tenant-scoped sale_not_found,
 *   forbidden_field_in_request — all refuse BEFORE any write.
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
  role: 'cashier',
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

function bridgeWith(
  db: SqlJsDatabase,
  session: OperatorSessionForSales | null,
  events: SaleAuditEvent[] = [],
) {
  const handle = makeSqlJsHandle(db);
  return createReceiptsBridge({
    getCurrentSession: () => session,
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    printDispatcher: neverDispatcher(),
    auditEmitter: createSaleAuditEmitter({ sink: { write: (e) => events.push(e) } }),
    now: () => '2026-05-27T10:00:11.000Z',
    newPrintEventId: () => 'pe-mo-1',
  });
}

describe('T504 — manualOverride idempotency (already-overridden no-op)', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
  });

  it('a second manualOverride returns the original row and does NOT write a second', async () => {
    const events: SaleAuditEvent[] = [];
    const bridge = bridgeWith(db, SESSION, events);

    const first = await bridge.manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'k1',
    });
    const second = await bridge.manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'k2',
    });

    expect(first.kind).toBe('ok');
    expect(second.kind).toBe('ok');
    if (first.kind === 'ok' && second.kind === 'ok') {
      expect(second.print_event_id).toBe(first.print_event_id);
    }

    const rows = bindPrintEventsRepository(makeSqlJsHandle(db)).readBySale('sale-1');
    expect(rows.filter((r) => r.outcome === 'manual_override')).toHaveLength(1);
    // Only one audit event emitted across the two calls.
    expect(events.filter((e) => e.action_category === 'sale.receipt.manual_override')).toHaveLength(
      1,
    );
  });
});

describe('receipts.manualOverride — gate refusals', () => {
  let db: SqlJsDatabase;
  beforeEach(() => {
    db = new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON;');
    for (const sql of MIGRATIONS) db.exec(sql);
    seedSale(db);
  });

  it('refuses no_session when no operator is signed in', async () => {
    const res = await bridgeWith(db, null).manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'k',
    });
    expect(res).toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it('refuses sale_not_found for a sale in another tenant', async () => {
    const res = await bridgeWith(db, { ...SESSION, tenant_id: 'other' }).manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'k',
    });
    expect(res).toEqual({ kind: 'refused', reason: 'sale_not_found' });
  });

  it('refuses forbidden_field_in_request when the payload carries a forbidden key', async () => {
    const bridge = bridgeWith(db, SESSION);
    const res = await bridge.manualOverride({
      sale_id: 'sale-1' as SaleId,
      idempotency_key: 'k',
      pan: 'forbidden-test-value',
    } as unknown as Parameters<ReturnType<typeof bridgeWith>['manualOverride']>[0]);
    expect(res).toEqual({ kind: 'refused', reason: 'forbidden_field_in_request' });
  });
});
