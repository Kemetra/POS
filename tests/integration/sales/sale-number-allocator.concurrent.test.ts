/**
 * T042 — 008 Slice 1b AD-7 allocator: concurrency safety.
 *
 * Per data-model.md §"Entity: SaleNumberSequences" Invariant 2 (UPSERT-and-
 * increment is the ONLY DML; SQLite's transaction-level isolation makes
 * the increment safe under concurrent finalize attempts).
 *
 * **Test limitation acknowledged:** JS is single-threaded; we cannot
 * model true OS-thread concurrency. What we CAN test is the
 * collision-impossibility of the composite-primary-key on
 * (terminal_id, calendar_day_local): if two sequential SQLite
 * transactions independently allocate against the same key, they MUST
 * produce two different sale numbers — guaranteed by SQLite's
 * read-then-write semantics inside the allocator's UPSERT-and-increment.
 *
 * The production deployment additionally relies on 006's per-terminal
 * partial unique index on payment_attempts (state='started') to serialise
 * finalizes per terminal, which means in practice the allocator is never
 * called concurrently on the same (terminal_id, day). The schema-layer
 * PK is the defense-in-depth guarantee.
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

describe('T042 — AD-7 sale-number allocator: concurrency safety', () => {
  it('two sequential allocations on the same (terminal, day) produce different sale numbers', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    const input = {
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    };
    const a = allocator.allocate(input);
    const b = allocator.allocate(input);
    expect(a).not.toBe(b);
    expect(a).toBe('TERM-01-2026-05-27-000001');
    expect(b).toBe('TERM-01-2026-05-27-000002');
  });

  it('1000 sequential allocations on the same key are strictly monotonic and unique', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    const input = {
      terminal_id: 'terminal-1',
      terminal_label: 'TERM-01',
      local_calendar_day: '2026-05-27',
    };
    const seen = new Set<string>();
    let previous: string | null = null;
    for (let i = 0; i < 1000; i += 1) {
      const next = allocator.allocate(input);
      // Each value is unique.
      expect(seen.has(next)).toBe(false);
      seen.add(next);
      // Each value sorts strictly after the previous one (lexicographic
      // because of the zero-padded 6-digit suffix).
      if (previous !== null) {
        expect(next > previous).toBe(true);
      }
      previous = next;
    }
    expect(seen.size).toBe(1000);
    // Final allocation is N=1000 → ...-001000 → strictly greater than ...-000999.
    expect(previous).toBe('TERM-01-2026-05-27-001000');
  });

  it('allocations on different (terminal, day) keys do not interfere', () => {
    const allocator = bindSaleNumberAllocator(makeSqlJsHandle(db));
    // Interleave allocations across 3 different (terminal, day) keys.
    const a1 = allocator.allocate({
      terminal_id: 'T-1',
      terminal_label: 'A',
      local_calendar_day: '2026-05-27',
    });
    const b1 = allocator.allocate({
      terminal_id: 'T-2',
      terminal_label: 'B',
      local_calendar_day: '2026-05-27',
    });
    const a2 = allocator.allocate({
      terminal_id: 'T-1',
      terminal_label: 'A',
      local_calendar_day: '2026-05-27',
    });
    const c1 = allocator.allocate({
      terminal_id: 'T-1',
      terminal_label: 'A',
      local_calendar_day: '2026-05-28',
    });
    const b2 = allocator.allocate({
      terminal_id: 'T-2',
      terminal_label: 'B',
      local_calendar_day: '2026-05-27',
    });

    expect(a1).toBe('A-2026-05-27-000001');
    expect(b1).toBe('B-2026-05-27-000001');
    expect(a2).toBe('A-2026-05-27-000002');
    expect(c1).toBe('A-2026-05-28-000001');
    expect(b2).toBe('B-2026-05-27-000002');
  });
});
