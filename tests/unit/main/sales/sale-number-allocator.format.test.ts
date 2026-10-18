/**
 * T040 — 008 Slice 1b AD-7 allocator: sale-number format test.
 *
 * Per spec §FR-010 + plan §AD-7 + data-model.md §"Entity: SaleNumberSequences":
 *
 *   sale_number = `<terminal_label>-<YYYY-MM-DD>-<NNNNNN>`
 *
 *   • `<terminal_label>` is embedded verbatim from the operator session's
 *     terminal config (per `visual-direction/README.md` (a) composition
 *     decision #4: NO truncation, NO hash, regex `^[A-Z0-9-]{1,16}$`).
 *   • `<YYYY-MM-DD>` is the local calendar day from the terminal's local
 *     timezone.
 *   • `<NNNNNN>` is the per-terminal per-day monotonic counter, zero-
 *     padded to 6 digits, starting at `000001` for each new
 *     (terminal_id, calendar_day_local) pair.
 *
 * This test asserts the format on the happy path: first allocation returns
 * `…-000001`, second `…-000002`, third `…-000003`. The day-reset, concurrency,
 * and txn-rollback behaviors are covered by T041 / T042 / T043 in sister
 * test files.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindSaleNumberAllocator } from '../../../../src/main/sales/sale-number-allocator.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
// We only need migration 0025 (sale_number_sequences) for the allocator
// unit tests; the allocator never reads from `sales` or other tables.
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

describe('T040 — AD-7 sale-number allocator: format', () => {
  it('first allocation returns ...-000001', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    const result = allocator.allocate({
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    });
    expect(result).toBe('TERM-01-2026-05-27-000001');
  });

  it('second allocation on same (terminal_id, day) returns ...-000002', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    const input = {
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    };
    allocator.allocate(input);
    expect(allocator.allocate(input)).toBe('TERM-01-2026-05-27-000002');
  });

  it('third allocation returns ...-000003 (monotonic)', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    const input = {
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    };
    allocator.allocate(input);
    allocator.allocate(input);
    expect(allocator.allocate(input)).toBe('TERM-01-2026-05-27-000003');
  });

  it('different terminal_label on same calendar day starts at ...-000001', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    allocator.allocate({
      terminal_id: 'terminal-A',
      terminal_label: 'TERM-A',
      local_calendar_day: '2026-05-27',
    });
    const result = allocator.allocate({
      terminal_id: 'terminal-B',
      terminal_label: 'TERM-B',
      local_calendar_day: '2026-05-27',
    });
    expect(result).toBe('TERM-B-2026-05-27-000001');
  });

  it('6-digit zero padding holds at the 1000-mark boundary', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    const input = {
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    };
    // Seed the sequence to 999 directly so we can observe the 1000th allocation.
    db.exec(
      `INSERT INTO sale_number_sequences
         (terminal_id, calendar_day_local, next_sequence, updated_at)
       VALUES ('terminal-1', '2026-05-27', 1000, '2026-05-27T08:00:00.000Z')`,
    );
    expect(allocator.allocate(input)).toBe('TERM-01-2026-05-27-001000');
  });

  it('updates updated_at on every allocation', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    allocator.allocate({
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    });
    const row = db.exec(
      "SELECT next_sequence, updated_at FROM sale_number_sequences WHERE terminal_id='terminal-1' AND calendar_day_local='2026-05-27'",
    );
    expect(row[0]?.values).toHaveLength(1);
    expect(row[0]?.values[0]?.[0]).toBe(2); // next_sequence is 2 after first allocation
    expect(typeof row[0]?.values[0]?.[1]).toBe('string'); // updated_at is set
  });
});
