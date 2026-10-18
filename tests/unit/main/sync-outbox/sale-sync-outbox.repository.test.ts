/**
 * T084 — `sale_sync_outbox` repository tests (RED).
 *
 * Surface per tasks.md T084:
 *   - insert(row)
 *   - readBySale(sale_id)
 *
 * No update method — state column is never transitioned by 008 (AD-11).
 * Append-only at the SQL layer (migration 0024 triggers).
 * UNIQUE(sale_id): exactly one outbox row per finalized sale (FR-060).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindSaleSyncOutboxRepository } from '../../../../src/main/sync-outbox/sale-sync-outbox.repository.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0024_create_sale_sync_outbox.sql',
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
  db.exec(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day
     ) VALUES (
       'sale-1', 'TERM-01-2026-05-27-000001', 'TERM-01-2026-05-27-000001', 'handoff-1', 'pa-1',
       'cart-1', 'tenant-1', 'branch-1', 'terminal-1', 'TERM-01',
       'op-abc', 'Ahmed', 'sess-1',
       1500, 0, 0, '[]',
       '2026-05-27T10:00:00.000Z', '2026-05-27T10:00:00.500Z', 'TRN', 'B', 'A',
       '2026-05-27'
     )`,
  );
});

function buildOutboxRow(overrides: Record<string, unknown> = {}) {
  return {
    outbox_row_id: 'ob-1',
    sale_id: 'sale-1',
    envelope_handoff_action_id: 'handoff-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    state: 'pending' as const,
    enqueued_at: '2026-05-27T10:00:00.600Z',
    ...overrides,
  };
}

describe('T084 — sale_sync_outbox repository: insert + readBySale', () => {
  it('inserts and reads back an outbox row', () => {
    const repo = bindSaleSyncOutboxRepository(makeSqlJsHandle(db));
    repo.insert(buildOutboxRow());
    const row = repo.readBySale('sale-1');
    expect(row).toBeDefined();
    expect(row?.outbox_row_id).toBe('ob-1');
    expect(row?.state).toBe('pending');
    expect(row?.envelope_handoff_action_id).toBe('handoff-1');
  });

  it('readBySale returns null when sale has no outbox row', () => {
    const repo = bindSaleSyncOutboxRepository(makeSqlJsHandle(db));
    expect(repo.readBySale('sale-1')).toBeNull();
  });

  it('UNIQUE(sale_id) prevents a second outbox row per sale (FR-060)', () => {
    const repo = bindSaleSyncOutboxRepository(makeSqlJsHandle(db));
    repo.insert(buildOutboxRow());
    expect(() => {
      repo.insert(buildOutboxRow({ outbox_row_id: 'ob-2' }));
    }).toThrow(/UNIQUE constraint failed/);
  });

  it("CHECK constraint forbids state != 'pending' at insert", () => {
    const repo = bindSaleSyncOutboxRepository(makeSqlJsHandle(db));
    expect(() => {
      repo.insert(buildOutboxRow({ state: 'sent' as unknown as 'pending' }));
    }).toThrow(/CHECK constraint failed/);
  });
});

describe('T084 — sale_sync_outbox repository: append-only invariant', () => {
  it('UPDATE is denied by trigger', () => {
    const repo = bindSaleSyncOutboxRepository(makeSqlJsHandle(db));
    repo.insert(buildOutboxRow());
    expect(() =>
      db.exec("UPDATE sale_sync_outbox SET tenant_id = 'tampered' WHERE outbox_row_id = 'ob-1'"),
    ).toThrow(/sale_sync_outbox is append-only/);
  });

  it('DELETE is denied by trigger', () => {
    const repo = bindSaleSyncOutboxRepository(makeSqlJsHandle(db));
    repo.insert(buildOutboxRow());
    expect(() => db.exec("DELETE FROM sale_sync_outbox WHERE outbox_row_id = 'ob-1'")).toThrow(
      /sale_sync_outbox is append-only/,
    );
  });
});
