/**
 * RT-541 — `sales` repository range read (`listByFinalizedRange`).
 *
 *   • A half-open `[start, end)` window over `finalized_at`, newest first,
 *     ties broken by `sale_id` descending (a stable keyset order).
 *   • Scoped to the given tenant / branch / terminal, and to one selling
 *     operator when a filter is given.
 *   • Keyset pages: a page walk returns every row once, in order.
 *   • Only the list columns are read (no lines, no main-only fields).
 *   • The query uses migration 0055's index, with and without a cursor.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  SALES_LIST_SQL,
  SALES_LIST_AFTER_SQL,
  bindSalesRepository,
  type SaleListQuery,
  type SalesRepository,
} from '../../../../../src/main/sales/repositories/sales.repository.js';
import { makeSqlJsHandle } from '../../cart/__helpers__/sql-js-handle.js';

// Vitest runs from the repository root.
const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b))
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
let repo: SalesRepository;

const SCOPE = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };

interface Seed {
  id: string;
  at: string;
  seller?: string;
  tenant?: string;
  branch?: string;
  terminal?: string;
}

let seq = 0;
function seed(s: Seed): void {
  seq += 1;
  db.run(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (?, ?, ?, ?, 'pa', 'cart', ?, ?, ?, 'TERM-01', ?, 'Seller', 'sess',
       1000, 0, 0, '[]', ?, ?, 'TRN-1', 'Branch', 'Address', '2026-10-16', '[]')`,
    [
      s.id,
      `TERM-01-2026-10-16-${String(seq).padStart(6, '0')}`,
      `R-${String(seq)}`,
      `handoff-${s.id}`,
      s.tenant ?? SCOPE.tenant_id,
      s.branch ?? SCOPE.branch_id,
      s.terminal ?? SCOPE.terminal_id,
      s.seller ?? 'op-a',
      s.at,
      s.at,
    ],
  );
}

function query(over: Partial<SaleListQuery> = {}): SaleListQuery {
  return {
    scope: SCOPE,
    selling_operator_id: null,
    start_inclusive: '2026-10-15T21:00:00.000Z',
    end_exclusive: '2026-10-16T21:00:00.000Z',
    after: null,
    limit: 50,
    ...over,
  };
}

const ids = (rows: ReadonlyArray<{ sale_id: string }>): string[] => rows.map((r) => r.sale_id);

beforeEach(() => {
  seq = 0;
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of ALL_MIGRATIONS) db.exec(sql);
  repo = bindSalesRepository(makeSqlJsHandle(db));
});

describe('RT-541 — listByFinalizedRange: window and order', () => {
  it('includes the first instant, excludes the end instant, newest first', () => {
    seed({ id: 'before', at: '2026-10-15T20:59:59.999Z' });
    seed({ id: 'first', at: '2026-10-15T21:00:00.000Z' });
    seed({ id: 'middle', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 'last', at: '2026-10-16T20:59:59.999Z' });
    seed({ id: 'end', at: '2026-10-16T21:00:00.000Z' });
    expect(ids(repo.listByFinalizedRange(query()))).toEqual(['last', 'middle', 'first']);
  });

  it('breaks a finalized_at tie by sale_id descending', () => {
    seed({ id: 'sale-a', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 'sale-c', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 'sale-b', at: '2026-10-16T09:00:00.000Z' });
    expect(ids(repo.listByFinalizedRange(query()))).toEqual(['sale-c', 'sale-b', 'sale-a']);
  });

  it('reads only the list columns', () => {
    seed({ id: 'only', at: '2026-10-16T09:00:00.000Z' });
    const [row] = repo.listByFinalizedRange(query());
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'finalized_at',
        'sale_id',
        'sale_number',
        'selling_operator_display_name',
        'subtotal_minor',
        'terminal_label',
        'total_tax_minor',
      ].sort(),
    );
  });
});

describe('RT-541 — listByFinalizedRange: scope', () => {
  it('keeps to the tenant, branch and terminal of the query', () => {
    seed({ id: 'mine', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 'other-tenant', at: '2026-10-16T09:00:00.000Z', tenant: 'tenant-2' });
    seed({ id: 'other-branch', at: '2026-10-16T09:00:00.000Z', branch: 'branch-2' });
    seed({ id: 'other-terminal', at: '2026-10-16T09:00:00.000Z', terminal: 'terminal-2' });
    expect(ids(repo.listByFinalizedRange(query()))).toEqual(['mine']);
  });

  it('keeps to one selling operator when a filter is given', () => {
    seed({ id: 'a1', at: '2026-10-16T08:00:00.000Z', seller: 'op-a' });
    seed({ id: 'b1', at: '2026-10-16T09:00:00.000Z', seller: 'op-b' });
    seed({ id: 'a2', at: '2026-10-16T10:00:00.000Z', seller: 'op-a' });
    expect(ids(repo.listByFinalizedRange(query({ selling_operator_id: 'op-a' })))).toEqual([
      'a2',
      'a1',
    ]);
    expect(ids(repo.listByFinalizedRange(query()))).toEqual(['a2', 'b1', 'a1']);
  });
});

describe('RT-541 — listByFinalizedRange: keyset pages', () => {
  it('returns at most `limit` rows', () => {
    for (let i = 0; i < 5; i += 1)
      seed({ id: `s${String(i)}`, at: `2026-10-16T0${String(i)}:00:00.000Z` });
    expect(repo.listByFinalizedRange(query({ limit: 2 }))).toHaveLength(2);
  });

  it('walks every row exactly once, including ties that straddle a page edge', () => {
    seed({ id: 's1', at: '2026-10-16T08:00:00.000Z' });
    seed({ id: 's2', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 's3', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 's4', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 's5', at: '2026-10-16T10:00:00.000Z' });
    const walked: string[] = [];
    let after: SaleListQuery['after'] = null;
    for (let page = 0; page < 10; page += 1) {
      const rows = repo.listByFinalizedRange(query({ limit: 2, after }));
      walked.push(...ids(rows));
      const last = rows.at(-1);
      if (rows.length < 2 || last === undefined) break;
      after = { finalized_at: last.finalized_at, sale_id: last.sale_id };
    }
    expect(walked).toEqual(['s5', 's4', 's3', 's2', 's1']);
  });

  it('keeps the window with a cursor: the cursor never widens the range', () => {
    seed({ id: 'in', at: '2026-10-16T09:00:00.000Z' });
    seed({ id: 'out', at: '2026-10-15T09:00:00.000Z' });
    const rows = repo.listByFinalizedRange(
      query({ after: { finalized_at: '2026-10-17T00:00:00.000Z', sale_id: 'zzz' } }),
    );
    expect(ids(rows)).toEqual(['in']);
  });
});

describe('RT-541 — listByFinalizedRange: uses the 0055 index', () => {
  function plan(sql: string, params: unknown[]): string {
    return (
      db
        .exec(`EXPLAIN QUERY PLAN ${sql}`, params as never[])[0]
        ?.values.map((row) => String(row[3]))
        .join(' | ') ?? ''
    );
  }

  const base = ['tenant-1', 'branch-1', 'terminal-1', null, null, 's', 'e'];

  it.each([
    ['first page', SALES_LIST_SQL, [...base, 51]],
    ['a later page', SALES_LIST_AFTER_SQL, [...base, 'c', 'c', 'x', 51]],
  ])('%s searches idx_sales_tenant_branch_finalized_at, never scans', (_label, sql, params) => {
    // A realistic month on one till, so the planner has rows to weigh.
    for (let i = 0; i < 3000; i += 1) {
      const minute = String(i % 60).padStart(2, '0');
      const day = String(1 + (i % 28)).padStart(2, '0');
      seed({
        id: `p${String(i)}`,
        at: `2026-10-${day}T10:${minute}:00.000Z`,
        seller: `op-${String(i % 4)}`,
      });
    }
    db.exec('ANALYZE');
    const text = plan(sql, params);
    expect(text).toContain('USING INDEX idx_sales_tenant_branch_finalized_at');
    expect(text).not.toMatch(/SCAN sales/);
  });

  it('would not use it before 0055 (the index is what makes the range read cheap)', () => {
    db.exec('DROP INDEX idx_sales_tenant_branch_finalized_at');
    expect(plan(SALES_LIST_SQL, [...base, 51])).not.toContain(
      'idx_sales_tenant_branch_finalized_at',
    );
  });
});
