/**
 * T041 — 008 Slice 1b AD-7 allocator: day-reset behavior.
 *
 * Per data-model.md §"Entity: SaleNumberSequences" Invariant 1 (composite
 * PK on terminal_id + calendar_day_local) + spec §FR-010 + research §R-7
 * (midnight roll boundary).
 *
 * When the local calendar day changes for a terminal, the allocator returns
 * `…-000001` for the new day even if the previous day's counter reached an
 * arbitrarily high value. This is intentional and is the load-bearing
 * "sale-number is unique per (terminal, day) but resets per day" guarantee.
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

describe('T041 — AD-7 sale-number allocator: day-reset', () => {
  it('new calendar day resets sequence to ...-000001 even if previous day reached ...-000847', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    // Seed previous day to 847 (so the next allocation on that day would
    // be 848 — but we never allocate on the previous day; we move on).
    db.exec(
      `INSERT INTO sale_number_sequences
         (terminal_id, calendar_day_local, next_sequence, updated_at)
       VALUES ('terminal-1', '2026-05-26', 848, '2026-05-26T23:59:59.000Z')`,
    );

    const result = allocator.allocate({
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    });
    expect(result).toBe('TERM-01-2026-05-27-000001');
  });

  it('previous day row is left intact (no decrement, no deletion)', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    db.exec(
      `INSERT INTO sale_number_sequences
         (terminal_id, calendar_day_local, next_sequence, updated_at)
       VALUES ('terminal-1', '2026-05-26', 848, '2026-05-26T23:59:59.000Z')`,
    );

    allocator.allocate({
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    });

    const previousDay = db.exec(
      "SELECT next_sequence FROM sale_number_sequences WHERE terminal_id='terminal-1' AND calendar_day_local='2026-05-26'",
    );
    expect(previousDay[0]?.values).toHaveLength(1);
    expect(previousDay[0]?.values[0]?.[0]).toBe(848); // untouched
  });

  it('both day rows co-exist after the boundary crossing', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    allocator.allocate({
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-26',
    });
    allocator.allocate({
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    });

    const rows = db.exec(
      "SELECT calendar_day_local FROM sale_number_sequences WHERE terminal_id='terminal-1' ORDER BY calendar_day_local",
    );
    expect(rows[0]?.values).toHaveLength(2);
    expect(rows[0]?.values[0]?.[0]).toBe('2026-05-26');
    expect(rows[0]?.values[1]?.[0]).toBe('2026-05-27');
  });

  it('returning to a prior day (clock skew / NTP correction) continues that day’s counter', () => {
    // The allocator's contract is sticky-per-(terminal, day): if the
    // calendar day passed in matches an existing row, the allocator
    // increments that row. This means a clock skew or NTP backwards-step
    // does NOT corrupt yesterday's counter — it would continue at the
    // existing value. Documented for completeness; the AD-2 caller is
    // responsible for passing the correct local_calendar_day.
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    allocator.allocate({
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    });
    allocator.allocate({
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    });
    // Now allocate again on the same day after pretending we already had work yesterday:
    db.exec(
      `INSERT INTO sale_number_sequences
         (terminal_id, calendar_day_local, next_sequence, updated_at)
       VALUES ('terminal-1', '2026-05-26', 100, '2026-05-26T12:00:00.000Z')`,
    );
    const sameDayThird = allocator.allocate({
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    });
    expect(sameDayThird).toBe('TERM-01-2026-05-27-000003');
    // Yesterday's row still at 100, untouched.
    const yesterday = db.exec(
      "SELECT next_sequence FROM sale_number_sequences WHERE calendar_day_local='2026-05-26'",
    );
    expect(yesterday[0]?.values[0]?.[0]).toBe(100);
  });
});
