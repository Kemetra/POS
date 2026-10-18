/**
 * T043 — 008 Slice 1b AD-7 allocator: txn-rollback safety.
 *
 * Per data-model.md §"Entity: SaleNumberSequences" Invariant 3 (the
 * allocator never decrements; a failed finalize after the sequence has
 * incremented leaves a "gap") + research §R-7 (the increment happens
 * inside the AD-2 atomic finalize transaction; rollback-safety is
 * required, gap-free is NOT).
 *
 * What this test asserts:
 *
 *   • The allocator is callable inside an outer transaction (the caller —
 *     AD-2 finalize — opens BEGIN before calling the allocator and
 *     COMMIT/ROLLBACK after).
 *   • If the outer transaction rolls back, the sequence-table increment
 *     is also rolled back (i.e. the allocator does NOT silently commit
 *     its own UPSERT in a nested transaction).
 *   • A subsequent successful allocation against the same key gets the
 *     same sale-number that the rolled-back allocation would have
 *     received (gap-free under happy-path serial execution; failed
 *     transactions DO leave gaps under genuinely concurrent execution,
 *     which is not a property this test models).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindSaleNumberAllocator } from '../../../src/main/sales/sale-number-allocator.js';
import { makeSqlJsHandle } from '../../unit/main/cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
const MIGRATIONS = ['0025_create_sale_number_sequences.sql'].map((f) =>
  readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'),
);

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

describe('T043 — AD-7 sale-number allocator: txn-rollback safety', () => {
  it('rolled-back outer transaction reverts the sequence increment', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    const input = {
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    };

    // Outer transaction calls allocator then rolls back.
    db.exec('BEGIN');
    const rolledBack = allocator.allocate(input);
    expect(rolledBack).toBe('TERM-01-2026-05-27-000001');
    db.exec('ROLLBACK');

    // Sequence-table row should NOT exist (or be reverted to absent),
    // because the row was created inside the rolled-back transaction.
    const rows = db.exec(
      "SELECT next_sequence FROM sale_number_sequences WHERE terminal_id='terminal-1' AND calendar_day_local='2026-05-27'",
    );
    expect(rows[0]?.values ?? []).toHaveLength(0);
  });

  it('after rollback, a fresh allocation re-issues the same sale-number', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    const input = {
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    };

    db.exec('BEGIN');
    allocator.allocate(input);
    db.exec('ROLLBACK');

    // A new outer transaction runs the allocator again on the same key.
    // Because the previous transaction rolled back, the sequence is
    // still at its initial state and the allocator returns ...-000001.
    db.exec('BEGIN');
    const retried = allocator.allocate(input);
    db.exec('COMMIT');
    expect(retried).toBe('TERM-01-2026-05-27-000001');
  });

  it('successful txn commit + failed retry leaves the sequence at the committed value', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    const input = {
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    };

    // First call: commit successfully → sequence advances to 2.
    db.exec('BEGIN');
    expect(allocator.allocate(input)).toBe('TERM-01-2026-05-27-000001');
    db.exec('COMMIT');

    // Second call inside a rolled-back transaction.
    db.exec('BEGIN');
    expect(allocator.allocate(input)).toBe('TERM-01-2026-05-27-000002');
    db.exec('ROLLBACK');

    // Third call should reuse '000002' because the previous one's
    // increment was rolled back.
    db.exec('BEGIN');
    expect(allocator.allocate(input)).toBe('TERM-01-2026-05-27-000002');
    db.exec('COMMIT');

    // Sequence-table next_sequence is now 3 (after the two committed
    // allocations).
    const row = db.exec(
      "SELECT next_sequence FROM sale_number_sequences WHERE terminal_id='terminal-1' AND calendar_day_local='2026-05-27'",
    );
    expect(row[0]?.values[0]?.[0]).toBe(3);
  });

  it('error thrown inside the outer transaction does not leak partial state', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    const input = {
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    };

    db.exec('BEGIN');
    allocator.allocate(input);
    try {
      // Simulate a downstream finalize-time failure after the allocator
      // has done its work — the caller catches and rolls back.
      throw new Error('simulated downstream finalize failure');
    } catch {
      db.exec('ROLLBACK');
    }

    // Sequence-table row absent — the allocator's write was inside the
    // rolled-back transaction.
    const rows = db.exec(
      "SELECT next_sequence FROM sale_number_sequences WHERE terminal_id='terminal-1' AND calendar_day_local='2026-05-27'",
    );
    expect(rows[0]?.values ?? []).toHaveLength(0);
  });
});
