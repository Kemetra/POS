/**
 * T053 — AD-2 finalize-transaction rollback integration test (RED → GREEN).
 *
 * Per tasks.md T053 + plan §AD-2:
 *
 * The 7-step AD-2 atomic finalize transaction runs steps 4-7 inside a single
 * `db.transaction(...)` so a failure between (4) and (7) rolls back ALL
 * partial state — including the allocator's sequence increment, which is
 * the only mutable state in 008.
 *
 * Test strategy: better-sqlite3's `db.transaction(fn)` rolls back on `throw`
 * inside `fn`. The sql.js adapter mirrors that contract (BEGIN/ROLLBACK
 * around the wrapped callback). We exercise the rollback by injecting a
 * throwing outboxRepo or auditEmitter into the finalize-transaction's deps
 * — they're the steps after the sales INSERT, so a throw there exercises
 * the load-bearing "sales row written, then aborted" rollback path.
 *
 * Acceptance:
 *   - No orphan sales row.
 *   - No orphan sale_sync_outbox row.
 *   - sale_number_sequences row reverted (not incremented).
 *   - The thrown error propagates out of finalize() so the AD-2 worker can
 *     observe the failure and re-queue (idempotency on next tick).
 *
 * The process-kill form (kill the dev process mid-transaction; verify
 * recovery scan re-fires on restart) is the T112 manual smoke — that
 * requires a real OS process to kill and an Electron restart, which
 * isn't testable in vitest.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindFinalizeTransaction } from '../../../src/main/sales/finalize-transaction.js';
import { bindSalesRepository } from '../../../src/main/sales/repositories/sales.repository.js';
import { bindSaleSyncOutboxRepository } from '../../../src/main/sync-outbox/sale-sync-outbox.repository.js';
import { bindSaleNumberAllocator } from '../../../src/main/sales/sale-number-allocator.js';
import { createSaleAuditEmitter } from '../../../src/main/sales/audit-emitter.js';
import { makeSqlJsHandle } from '../../unit/main/cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
const MIGRATIONS = [
  // RT-551 — the once-per-terminal switch marker is read from audit_events.
  '0004_audit_events.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0024_create_sale_sync_outbox.sql',
  '0025_create_sale_number_sequences.sql',
  '0028_extend_sales_with_lines_json.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);

  // Seed a settled payment attempt + one tender line so the refusal guard passes.
  db.exec(
    `INSERT INTO payment_attempts (
       payment_attempt_id, tenant_id, branch_id, terminal_id,
       acting_operator_id, operator_session_id,
       envelope_handoff_action_id, envelope_cart_id, envelope_subtotal_minor,
       state, started_at, settled_at, failure_reason, force_fail_attribution_operator_id,
       last_action_id
     ) VALUES (
       'pa-1', 'tenant-1', 'branch-1', 'terminal-1',
       'op-clerk-user-abc', 'sess-1',
       'handoff-1', 'cart-1', 1500,
       'settled', '2026-05-28T09:59:00.000Z', '2026-05-28T10:00:00.000Z',
       NULL, NULL, 'action-1'
     )`,
  );
  db.exec(
    `INSERT INTO payment_tender_lines (
       tender_line_id, payment_attempt_id, tender_type, amount_applied_minor,
       state, applied_at, attribution_operator_id, apply_order, last_action_id
     ) VALUES (
       'tl-1', 'pa-1', 'cash', 1500,
       'applied', '2026-05-28T10:00:00.000Z', 'op-clerk-user-abc', 1, 'action-1'
     )`,
  );
});

function buildInput() {
  return {
    envelope_handoff_action_id: 'handoff-1',
    payment_attempt_id: 'pa-1',
    envelope_cart_id: 'cart-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    terminal_label: 'TERM-01',
    selling_operator_id: 'op-clerk-user-abc',
    selling_operator_display_name: 'Ahmed',
    selling_operator_session_id: 'sess-1',
    subtotal_minor: 1500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary: [{ tender_type: 'cash' as const, amount_applied_minor: 1500 }],
    settled_at: '2026-05-28T10:00:00.000Z',
    tenant_tax_registration_id: 'TRN-123',
    branch_name: 'Maadi',
    branch_address: '12 Road 9',
    lines: [
      {
        line_id: 'line-1',
        item_ref: 'SKU-001',
        display_name: 'Paracetamol 500mg',
        quantity: 1,
        unit_price_minor: 1500,
        line_subtotal_minor: 1500,
        note: null,
        version: 1,
        last_action_id: 'action-1',
      },
    ],
  };
}

describe('T053 — AD-2 finalize-transaction rollback discipline', () => {
  it('rollback on outbox INSERT failure leaves no orphan sales row', () => {
    const handle = makeSqlJsHandle(db);
    const realOutbox = bindSaleSyncOutboxRepository(handle);
    const wrappedOutbox: typeof realOutbox = {
      insert: () => {
        throw new Error('simulated outbox write failure');
      },
      readBySale: (sale_id: string) => realOutbox.readBySale(sale_id),
    };
    const finalize = bindFinalizeTransaction({
      db: handle,
      salesRepo: bindSalesRepository(handle),
      outboxRepo: wrappedOutbox,
      allocator: bindSaleNumberAllocator(handle),
      auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
      now: () => '2026-05-28T10:00:00.500Z',
      saleIdGenerator: () => 'sale-uuid-1',
      outboxRowIdGenerator: () => 'ob-uuid-1',
    });

    expect(() => finalize.finalize(buildInput())).toThrow(/simulated outbox write failure/);

    // No orphan sales row.
    const sales = db.exec('SELECT COUNT(*) FROM sales');
    expect(sales[0]?.values[0]?.[0]).toBe(0);
    // No orphan outbox row.
    const outbox = db.exec('SELECT COUNT(*) FROM sale_sync_outbox');
    expect(outbox[0]?.values[0]?.[0]).toBe(0);
    // Sequence row reverted (the allocator's UPSERT was inside the rolled-back txn).
    const seq = db.exec('SELECT COUNT(*) FROM sale_number_sequences');
    expect(seq[0]?.values[0]?.[0]).toBe(0);
  });

  it('rollback on audit-emitter failure leaves no orphan sales or outbox row', () => {
    const handle = makeSqlJsHandle(db);
    const throwingEmitter = {
      emitSaleFinalized: () => {
        throw new Error('simulated audit emit failure');
      },
      emitSaleFinalizationRefused: () => {},
      emitRaw: () => {},
    };
    const finalize = bindFinalizeTransaction({
      db: handle,
      salesRepo: bindSalesRepository(handle),
      outboxRepo: bindSaleSyncOutboxRepository(handle),
      allocator: bindSaleNumberAllocator(handle),
      auditEmitter: throwingEmitter,
      now: () => '2026-05-28T10:00:00.500Z',
      saleIdGenerator: () => 'sale-uuid-1',
      outboxRowIdGenerator: () => 'ob-uuid-1',
    });

    expect(() => finalize.finalize(buildInput())).toThrow(/simulated audit emit failure/);

    const sales = db.exec('SELECT COUNT(*) FROM sales');
    expect(sales[0]?.values[0]?.[0]).toBe(0);
    const outbox = db.exec('SELECT COUNT(*) FROM sale_sync_outbox');
    expect(outbox[0]?.values[0]?.[0]).toBe(0);
    const seq = db.exec('SELECT COUNT(*) FROM sale_number_sequences');
    expect(seq[0]?.values[0]?.[0]).toBe(0);
  });

  it('retry after rollback succeeds — idempotency anchor still uses the original handoff_action_id', () => {
    const handle = makeSqlJsHandle(db);
    let outboxThrows = true;
    const realOutbox = bindSaleSyncOutboxRepository(handle);
    const flakyOutbox: typeof realOutbox = {
      insert: (row) => {
        if (outboxThrows) {
          outboxThrows = false;
          throw new Error('simulated transient outbox failure');
        }
        realOutbox.insert(row);
      },
      readBySale: (sale_id: string) => realOutbox.readBySale(sale_id),
    };
    const finalize = bindFinalizeTransaction({
      db: handle,
      salesRepo: bindSalesRepository(handle),
      outboxRepo: flakyOutbox,
      allocator: bindSaleNumberAllocator(handle),
      auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
      now: () => '2026-05-28T10:00:00.500Z',
      saleIdGenerator: () => 'sale-uuid-1',
      outboxRowIdGenerator: () => 'ob-uuid-1',
    });

    // First attempt — throws.
    expect(() => finalize.finalize(buildInput())).toThrow();
    // Second attempt — succeeds. The handoff_action_id is the same, so the
    // idempotency anchor proves we're not double-issuing a sale_number.
    const result = finalize.finalize(buildInput());
    expect(result.kind).toBe('finalized');
    if (result.kind !== 'finalized') return;
    // Sequence starts fresh because the first attempt's increment rolled back.
    expect(result.sale_number).toBe('TERM-01-2026-05-28-000001');
  });
});
