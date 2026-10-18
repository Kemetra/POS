/**
 * T081 — `sales` repository tests (RED).
 *
 * Surface per tasks.md T081:
 *   - insert(saleRow)
 *   - readById(sale_id)
 *   - findByNumber(sale_number, tenantScope)  — tenant/branch/terminal scoped
 *   - findByHandoffActionId(handoff_action_id) — for AD-2 idempotency check
 *
 * No update/delete — `sales` is append-only at the SQL layer (migration 0021
 * trigger). The repository surface enforces this at the type level by
 * omitting those methods.
 *
 * Uses the same sql.js + DatabaseHandle adapter pattern as 006's
 * payment-attempts.repository.test.ts.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindSalesRepository } from '../../../../../src/main/sales/repositories/sales.repository.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..', '..');
const MIGRATIONS = [
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
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
});

function buildSaleRow(overrides: Record<string, unknown> = {}) {
  return {
    sale_id: 'sale-1',
    sale_number: 'TERM-01-2026-05-27-000001',
    receipt_number: 'TERM-01-2026-05-27-000001',
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
    tender_lines_summary_json: '[{"tender_type":"cash","amount_applied_minor":1500}]',
    settled_at: '2026-05-27T10:00:00.000Z',
    finalized_at: '2026-05-27T10:00:00.500Z',
    tenant_tax_registration_id: 'TRN-123',
    branch_name: 'Maadi Branch',
    branch_address: '12 Road 9, Maadi',
    local_calendar_day: '2026-05-27',
    lines_json: '[]',
    ...overrides,
  };
}

describe('T081 — sales repository: insert + readById', () => {
  it('inserts and reads back a sale row by sale_id', () => {
    const repo = bindSalesRepository(makeSqlJsHandle(db));
    const row = buildSaleRow();
    repo.insert(row);
    const back = repo.readById('sale-1');
    expect(back).toBeDefined();
    expect(back?.sale_id).toBe('sale-1');
    expect(back?.sale_number).toBe('TERM-01-2026-05-27-000001');
    expect(back?.envelope_handoff_action_id).toBe('handoff-1');
    expect(back?.subtotal_minor).toBe(1500);
  });

  it('returns null when sale_id is unknown', () => {
    const repo = bindSalesRepository(makeSqlJsHandle(db));
    expect(repo.readById('does-not-exist')).toBeNull();
  });
});

describe('T081 — sales repository: findByHandoffActionId (AD-2 idempotency)', () => {
  it('returns the existing sale on duplicate handoff_action_id', () => {
    const repo = bindSalesRepository(makeSqlJsHandle(db));
    repo.insert(buildSaleRow({ sale_id: 'sale-a', envelope_handoff_action_id: 'handoff-shared' }));
    const found = repo.findByHandoffActionId('handoff-shared');
    expect(found).toBeDefined();
    expect(found?.sale_id).toBe('sale-a');
  });

  it('returns null when handoff_action_id has no matching sale', () => {
    const repo = bindSalesRepository(makeSqlJsHandle(db));
    expect(repo.findByHandoffActionId('not-yet-finalized')).toBeNull();
  });
});

describe('T081 — sales repository: findByNumber (tenant-scoped)', () => {
  it('finds the sale when tenant/branch/terminal match', () => {
    const repo = bindSalesRepository(makeSqlJsHandle(db));
    repo.insert(buildSaleRow());
    const found = repo.findByNumber('TERM-01-2026-05-27-000001', {
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
    });
    expect(found?.sale_id).toBe('sale-1');
  });

  it('returns null on cross-tenant lookup (no information leak)', () => {
    const repo = bindSalesRepository(makeSqlJsHandle(db));
    repo.insert(buildSaleRow());
    const found = repo.findByNumber('TERM-01-2026-05-27-000001', {
      tenant_id: 'tenant-other',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
    });
    expect(found).toBeNull();
  });

  it('returns null on cross-branch lookup within same tenant', () => {
    const repo = bindSalesRepository(makeSqlJsHandle(db));
    repo.insert(buildSaleRow());
    const found = repo.findByNumber('TERM-01-2026-05-27-000001', {
      tenant_id: 'tenant-1',
      branch_id: 'branch-other',
      terminal_id: 'terminal-1',
    });
    expect(found).toBeNull();
  });
});

describe('T081 — sales repository: append-only invariant', () => {
  it('UPDATE on an inserted sale row is denied by trigger', () => {
    const repo = bindSalesRepository(makeSqlJsHandle(db));
    repo.insert(buildSaleRow());
    expect(() =>
      db.exec("UPDATE sales SET sale_number = 'TAMPERED' WHERE sale_id = 'sale-1'"),
    ).toThrow(/sales is append-only/);
  });

  it('DELETE on an inserted sale row is denied by trigger', () => {
    const repo = bindSalesRepository(makeSqlJsHandle(db));
    repo.insert(buildSaleRow());
    expect(() => db.exec("DELETE FROM sales WHERE sale_id = 'sale-1'")).toThrow(
      /sales is append-only/,
    );
  });
});
