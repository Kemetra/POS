/**
 * T082 — `print_events` repository tests (RED).
 *
 * Surface per tasks.md T082:
 *   - insert(row)
 *   - readBySale(sale_id) — ordered by printed_at DESC
 *   - hasSuccessfulPrint(sale_id) — boolean (AD-10 reprint precondition)
 *   - countReprints(sale_id) — used to allocate duplicate_copy_sequence_number
 *
 * Append-only: no update / no delete (migration 0022 triggers).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindPrintEventsRepository } from '../../../../../src/main/sales/repositories/print-events.repository.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..', '..');
const MIGRATIONS = [
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
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
  // Insert a parent sale row for FK targets.
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

function buildPrintEvent(overrides: Record<string, unknown> = {}) {
  return {
    print_event_id: 'pe-1',
    sale_id: 'sale-1',
    outcome: 'success' as const,
    purpose: 'first_print' as const,
    render_path: 'escpos_direct' as const,
    acting_operator_id: 'op-abc',
    acting_operator_session_id: 'sess-1',
    duplicate_copy_sequence_number: null,
    failure_reason: null,
    previous_failed_print_event_ids: null,
    printed_at: '2026-05-27T10:00:01.000Z',
    ...overrides,
  };
}

describe('T082 — print_events repository: insert + readBySale', () => {
  it('inserts a first_print event and reads it back', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    repo.insert(buildPrintEvent());
    const rows = repo.readBySale('sale-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.print_event_id).toBe('pe-1');
    expect(rows[0]?.outcome).toBe('success');
  });

  it('readBySale returns rows ordered by printed_at DESC', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    repo.insert(
      buildPrintEvent({ print_event_id: 'pe-old', printed_at: '2026-05-27T09:00:00.000Z' }),
    );
    repo.insert(
      buildPrintEvent({ print_event_id: 'pe-new', printed_at: '2026-05-27T11:00:00.000Z' }),
    );
    const rows = repo.readBySale('sale-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.print_event_id).toBe('pe-new');
    expect(rows[1]?.print_event_id).toBe('pe-old');
  });

  it('readBySale returns [] when sale has no print events', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    expect(repo.readBySale('sale-1')).toEqual([]);
  });
});

describe('T082 — print_events repository: hasSuccessfulPrint (AD-10 precondition)', () => {
  it('returns true after a success print event', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    repo.insert(buildPrintEvent({ outcome: 'success' }));
    expect(repo.hasSuccessfulPrint('sale-1')).toBe(true);
  });

  it('returns false when only failure events exist', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    repo.insert(
      buildPrintEvent({
        outcome: 'failure',
        failure_reason: 'printer_offline',
      }),
    );
    expect(repo.hasSuccessfulPrint('sale-1')).toBe(false);
  });

  it('returns false when only manual_override events exist (no actual print)', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    repo.insert(
      buildPrintEvent({
        outcome: 'manual_override',
        render_path: null,
      }),
    );
    expect(repo.hasSuccessfulPrint('sale-1')).toBe(false);
  });

  it('returns false when sale has no print events', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    expect(repo.hasSuccessfulPrint('sale-1')).toBe(false);
  });
});

describe('T082 — print_events repository: countReprints', () => {
  it('returns 0 when no reprints have occurred', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    repo.insert(buildPrintEvent({ purpose: 'first_print' }));
    expect(repo.countReprints('sale-1')).toBe(0);
  });

  it('counts successful reprints only', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    repo.insert(buildPrintEvent({ print_event_id: 'pe-1', purpose: 'first_print' }));
    repo.insert(
      buildPrintEvent({
        print_event_id: 'pe-2',
        purpose: 'reprint',
        outcome: 'success',
        duplicate_copy_sequence_number: 1,
        printed_at: '2026-05-27T11:00:00.000Z',
      }),
    );
    repo.insert(
      buildPrintEvent({
        print_event_id: 'pe-3',
        purpose: 'reprint',
        outcome: 'success',
        duplicate_copy_sequence_number: 2,
        printed_at: '2026-05-27T12:00:00.000Z',
      }),
    );
    expect(repo.countReprints('sale-1')).toBe(2);
  });
});

describe('T082 — print_events repository: append-only invariant', () => {
  it('UPDATE is denied by trigger', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    repo.insert(buildPrintEvent());
    expect(() =>
      db.exec(
        "UPDATE print_events SET acting_operator_id = 'tampered' WHERE print_event_id = 'pe-1'",
      ),
    ).toThrow(/print_events is append-only/);
  });

  it('DELETE is denied by trigger', () => {
    const repo = bindPrintEventsRepository(makeSqlJsHandle(db));
    repo.insert(buildPrintEvent());
    expect(() => db.exec("DELETE FROM print_events WHERE print_event_id = 'pe-1'")).toThrow(
      /print_events is append-only/,
    );
  });
});
