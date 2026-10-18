/**
 * RT-541 (RT-534 S5) — `sales.list`: this device's sales over a range of store
 * business days (Africa/Cairo), behind the RT-546 role gate.
 *
 *   • The day of a sale is `businessDayOf(finalized_at)`, never the stored
 *     `local_calendar_day` (UTC on older rows).
 *   • `from_day` and `to_day` are both inclusive; at most 31 days (OD-534-4),
 *     refused — never truncated — when wider.
 *   • Keyset pages: 50 by default, 1-100 allowed, an opaque `next_cursor`.
 *   • OD-534-1: a cashier lists only their own sales; a manager or admin lists
 *     every sale in the terminal scope. Scope always comes from the session.
 *   • No session or a locked session → `no_session`; a role outside the
 *     allowlist → `role_denied` (audited).
 *   • Every ok answer says the view covers this device only.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  createSalesBridge,
  type OperatorSessionForSales,
} from '../../../../src/main/sales/sales-bridge.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindPrintEventsRepository } from '../../../../src/main/sales/repositories/print-events.repository.js';
import { bindDrawerEventsRepository } from '../../../../src/main/sales/repositories/drawer-events.repository.js';
import type { SaleRawAuditEvent } from '../../../../src/main/sales/audit-emitter.js';
import type { SalesListRequest, SalesListResponse } from '../../../../src/shared/bridge-api.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

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

const SCOPE = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-1' };

/** One signed-in operator per role; `auditor` is outside the RT-546 allowlist. */
const [CASHIER_A, MANAGER, ADMIN, UNKNOWN_ROLE] = (
  [
    ['cashier', 'op-cashier-a'],
    ['manager', 'op-manager'],
    ['admin', 'op-admin'],
    ['auditor', 'op-auditor'],
  ] as const
).map(
  ([role, operator_id]): OperatorSessionForSales => ({
    ...SCOPE,
    role: role as OperatorSessionForSales['role'],
    operator_id,
    operator_session_id: `sess-${operator_id}`,
  }),
) as [
  OperatorSessionForSales,
  OperatorSessionForSales,
  OperatorSessionForSales,
  OperatorSessionForSales,
];

let db: SqlJsDatabase;
let seq = 0;

interface Seed {
  id: string;
  at: string;
  seller?: string;
  /** The stored UTC day (pre-RT-551 allocator); never used for the range. */
  utcDay?: string;
  terminal?: string;
}

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
     ) VALUES (?, ?, ?, ?, 'pa', 'cart', 'tenant-1', 'branch-1', ?, 'TERM-01',
       ?, ?, 'sess', 2500, 0, 0, '[]', ?, ?, 'TRN-1', 'Branch', 'Address', ?, '[]')`,
    [
      s.id,
      `TERM-01-${s.utcDay ?? s.at.slice(0, 10)}-${String(seq).padStart(6, '0')}`,
      `R-${String(seq)}`,
      `handoff-${s.id}`,
      s.terminal ?? SCOPE.terminal_id,
      s.seller ?? CASHIER_A.operator_id,
      s.seller === undefined ? 'Cashier A' : `Name ${s.seller}`,
      s.at,
      s.at,
      s.utcDay ?? s.at.slice(0, 10),
    ],
  );
}

interface Harness {
  locked: boolean;
  audits: SaleRawAuditEvent[];
}

function bridge(current: OperatorSessionForSales | null, h: Harness = harness()) {
  const handle = makeSqlJsHandle(db);
  return createSalesBridge({
    getCurrentSession: () => current,
    isSessionLocked: () => h.locked,
    auditEmitter: { emitRaw: (e: SaleRawAuditEvent) => void h.audits.push(e) },
    salesRepo: bindSalesRepository(handle),
    printEventsRepo: bindPrintEventsRepository(handle),
    drawerEventsRepo: bindDrawerEventsRepository(handle),
  });
}

function harness(): Harness {
  return { locked: false, audits: [] };
}

function okIds(res: SalesListResponse): string[] {
  if (res.kind !== 'ok') throw new Error(`expected ok, got ${res.reason}`);
  return res.sales.map((s) => s.sale_id);
}

function list(
  who: OperatorSessionForSales | null,
  req: Partial<SalesListRequest> & Record<string, unknown>,
): Promise<SalesListResponse> {
  return bridge(who).list({
    from_day: '2026-10-16',
    to_day: '2026-10-16',
    ...req,
  });
}

beforeEach(() => {
  seq = 0;
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of ALL_MIGRATIONS) db.exec(sql);
});

// ── Cairo business day, not the stored UTC day ─────────────────────────────

describe('RT-541 — the day comes from finalized_at in Africa/Cairo', () => {
  it('a 23:30 UTC sale falls on the next Cairo day, whatever local_calendar_day says', async () => {
    // 2026-10-15T23:30Z is 02:30 on 2026-10-16 in Cairo (UTC+3, summer time).
    seed({ id: 'late', at: '2026-10-15T23:30:00.000Z', utcDay: '2026-10-15' });
    const day16 = await list(MANAGER, { from_day: '2026-10-16', to_day: '2026-10-16' });
    const day15 = await list(MANAGER, { from_day: '2026-10-15', to_day: '2026-10-15' });
    expect(okIds(day16)).toEqual(['late']);
    expect(okIds(day15)).toEqual([]);
    expect(day16).toMatchObject({ sales: [{ business_day: '2026-10-16' }] });
  });

  it('includes both bounds and nothing outside them', async () => {
    // Cairo 2026-10-14 starts at 2026-10-13T21:00Z; 2026-10-16 starts at 2026-10-15T21:00Z.
    seed({ id: 'before-from', at: '2026-10-13T20:59:59.999Z' });
    seed({ id: 'first-of-from', at: '2026-10-13T21:00:00.000Z' });
    seed({ id: 'last-of-to', at: '2026-10-15T20:59:59.999Z' });
    seed({ id: 'after-to', at: '2026-10-15T21:00:00.000Z' });
    const res = await list(MANAGER, { from_day: '2026-10-14', to_day: '2026-10-15' });
    expect(okIds(res)).toEqual(['last-of-to', 'first-of-from']);
    expect(res).toMatchObject({
      sales: [{ business_day: '2026-10-15' }, { business_day: '2026-10-14' }],
    });
  });

  it('covers the whole 25-hour fall-back day 2026-10-29', async () => {
    seed({ id: 'first', at: '2026-10-28T21:00:00.000Z' });
    seed({ id: 'second-2330', at: '2026-10-29T21:30:00.000Z' });
    seed({ id: 'next-day', at: '2026-10-29T22:00:00.000Z' });
    const res = await list(MANAGER, { from_day: '2026-10-29', to_day: '2026-10-29' });
    expect(okIds(res)).toEqual(['second-2330', 'first']);
  });
});

// ── Response shape ──────────────────────────────────────────────────────────

describe('RT-541 — the answer', () => {
  it('lists newest first, marks the view as this device only, and projects list fields', async () => {
    seed({ id: 's1', at: '2026-10-16T08:00:00.000Z' });
    seed({ id: 's2', at: '2026-10-16T09:00:00.000Z' });
    const res = await list(MANAGER, {});
    expect(res).toEqual({
      kind: 'ok',
      coverage: 'this_device_only',
      next_cursor: null,
      sales: [
        {
          sale_id: 's2',
          sale_number: 'TERM-01-2026-10-16-000002',
          business_day: '2026-10-16',
          finalized_at: '2026-10-16T09:00:00.000Z',
          terminal_label: 'TERM-01',
          selling_operator_display_name: 'Cashier A',
          subtotal_minor: 2500,
          total_tax_minor: 0,
        },
        expect.objectContaining({ sale_id: 's1' }),
      ],
    });
  });

  it('is an honest empty page when nothing was sold', async () => {
    expect(await list(MANAGER, {})).toEqual({
      kind: 'ok',
      coverage: 'this_device_only',
      next_cursor: null,
      sales: [],
    });
  });

  it("never lists another terminal's sales (the detail read would refuse them)", async () => {
    seed({ id: 'here', at: '2026-10-16T08:00:00.000Z' });
    seed({ id: 'earlier-pairing', at: '2026-10-16T09:00:00.000Z', terminal: 'terminal-old' });
    expect(okIds(await list(MANAGER, {}))).toEqual(['here']);
  });

  it('a stored time it cannot read gives that row a null day; the page still answers', async () => {
    // Minute 61 sorts inside the window but is not a real instant.
    seed({ id: 'bad-time', at: '2026-10-16T09:61:00.000Z' });
    seed({ id: 'good', at: '2026-10-16T08:00:00.000Z' });
    const res = await list(MANAGER, {});
    expect(res).toMatchObject({
      kind: 'ok',
      sales: [
        { sale_id: 'bad-time', business_day: null },
        { sale_id: 'good', business_day: '2026-10-16' },
      ],
    });
  });
});

// ── Pages ───────────────────────────────────────────────────────────────────

describe('RT-541 — keyset pages', () => {
  it('pages 50 by default and hands back a cursor while more remain', async () => {
    for (let i = 0; i < 51; i += 1) {
      seed({
        id: `s${String(i).padStart(2, '0')}`,
        at: `2026-10-16T08:${String(i % 60).padStart(2, '0')}:00.000Z`,
      });
    }
    const res = await list(MANAGER, {});
    if (res.kind !== 'ok') throw new Error('expected ok');
    expect(res.sales).toHaveLength(50);
    expect(res.next_cursor).toEqual(expect.any(String));
  });

  it('walks every sale once across pages, then ends with a null cursor', async () => {
    for (let i = 0; i < 7; i += 1) seed({ id: `s${String(i)}`, at: '2026-10-16T08:00:00.000Z' });
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const res: SalesListResponse = await list(MANAGER, { page_size: 3, cursor });
      if (res.kind !== 'ok') throw new Error('expected ok');
      walked.push(...res.sales.map((s) => s.sale_id));
      cursor = res.next_cursor;
      if (cursor === null) break;
    }
    expect(walked).toEqual(['s6', 's5', 's4', 's3', 's2', 's1', 's0']);
    expect(cursor).toBeNull();
  });

  it('round-trips the cursor of a production sale id (randomUUID)', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) seed({ id, at: '2026-10-16T08:00:00.000Z' });
    const first = await list(MANAGER, { page_size: 2 });
    if (first.kind !== 'ok' || first.next_cursor === null) throw new Error('expected a cursor');
    const second = await list(MANAGER, { page_size: 2, cursor: first.next_cursor });
    expect([...okIds(first), ...okIds(second)]).toEqual([...ids].sort().reverse());
  });

  it('does not hand back a cursor when the last page is exactly full', async () => {
    for (let i = 0; i < 3; i += 1) seed({ id: `s${String(i)}`, at: '2026-10-16T08:00:00.000Z' });
    expect(await list(MANAGER, { page_size: 3 })).toMatchObject({ next_cursor: null });
  });

  it.each([1, 100])('accepts page_size %i', async (pageSize) => {
    expect(await list(MANAGER, { page_size: pageSize })).toMatchObject({ kind: 'ok' });
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('RT-541 — every input is validated in main', () => {
  it('accepts 31 inclusive days', async () => {
    expect(await list(MANAGER, { from_day: '2026-10-01', to_day: '2026-10-31' })).toMatchObject({
      kind: 'ok',
    });
  });

  it('refuses 32 days as range_too_wide, never truncating', async () => {
    expect(await list(MANAGER, { from_day: '2026-09-30', to_day: '2026-10-31' })).toEqual({
      kind: 'refused',
      reason: 'range_too_wide',
    });
  });

  it.each([
    ['a malformed from_day', { from_day: '2026-10-1' }],
    ['a date-time from_day', { from_day: '2026-10-16T00:00:00Z' }],
    ['an impossible to_day', { to_day: '2026-02-30' }],
    ['a missing to_day', { to_day: undefined }],
    ['a numeric day', { from_day: 20261016 }],
    ['to_day before from_day', { from_day: '2026-10-16', to_day: '2026-10-15' }],
    ['a day outside the supported years', { from_day: '0999-12-31', to_day: '0999-12-31' }],
    ['page_size 0', { page_size: 0 }],
    ['page_size 101', { page_size: 101 }],
    ['a fractional page_size', { page_size: 1.5 }],
    ['a string page_size', { page_size: '50' }],
    ['a non-string cursor', { cursor: 42 }],
    ['a garbage cursor', { cursor: 'not-a-cursor' }],
    ['a cursor with a bad instant', { cursor: '2026-10-16 08:00|s1' }],
    ['a cursor with an empty id', { cursor: '2026-10-16T08:00:00.000Z|' }],
    ['an over-long cursor', { cursor: `2026-10-16T08:00:00.000Z|${'x'.repeat(200)}` }],
    ['a renderer-supplied scope', { tenant_id: 'tenant-2' }],
    ['a renderer-supplied operator', { selling_operator_id: 'op-cashier-b' }],
  ])('refuses %s as invalid_request', async (_label, over) => {
    seed({ id: 's1', at: '2026-10-16T08:00:00.000Z' });
    expect(await list(MANAGER, over)).toEqual({ kind: 'refused', reason: 'invalid_request' });
  });

  it('refuses a forbidden key before anything else', async () => {
    expect(await list(null, { pan: '4111' })).toEqual({
      kind: 'refused',
      reason: 'forbidden_field_in_request',
    });
  });
});

// ── OD-534-1 role matrix (RT-546 gate reused) ───────────────────────────────

describe('RT-541 — role matrix', () => {
  beforeEach(() => {
    seed({ id: 'mine', at: '2026-10-16T08:00:00.000Z', seller: CASHIER_A.operator_id });
    seed({ id: 'other', at: '2026-10-16T09:00:00.000Z', seller: 'op-cashier-b' });
    seed({ id: 'managers', at: '2026-10-16T10:00:00.000Z', seller: MANAGER.operator_id });
  });

  it('a cashier lists only their own sales, unaudited', async () => {
    const h = harness();
    const res = await bridge(CASHIER_A, h).list({ from_day: '2026-10-16', to_day: '2026-10-16' });
    expect(okIds(res)).toEqual(['mine']);
    expect(h.audits).toEqual([]);
  });

  it.each([
    ['manager', MANAGER],
    ['admin', ADMIN],
  ])('a %s lists every sale in the terminal scope', async (_label, who) => {
    expect(okIds(await list(who, {}))).toEqual(['managers', 'other', 'mine']);
  });

  it('a role outside the allowlist is refused as role_denied and audited', async () => {
    const h = harness();
    const res = await bridge(UNKNOWN_ROLE, h).list({
      from_day: '2026-10-16',
      to_day: '2026-10-16',
    });
    expect(res).toEqual({ kind: 'refused', reason: 'role_denied' });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action_category: 'sale.access.refused',
      payload: { action: 'sales.list', reason: 'role_denied' },
    });
  });

  it('no session is refused as no_session', async () => {
    expect(await list(null, {})).toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it.each([
    ['an empty operator id', ''],
    ['a null operator id', null],
  ])(
    'a cashier session with %s fails closed as no_session, never the whole scope',
    async (_label, id) => {
      const broken = { ...CASHIER_A, operator_id: id as unknown as string };
      expect(await list(broken, {})).toEqual({ kind: 'refused', reason: 'no_session' });
    },
  );

  it('a locked session is refused as no_session, unaudited', async () => {
    const h = harness();
    h.locked = true;
    const res = await bridge(MANAGER, h).list({ from_day: '2026-10-16', to_day: '2026-10-16' });
    expect(res).toEqual({ kind: 'refused', reason: 'no_session' });
    expect(h.audits).toEqual([]);
  });

  it('a cashier cannot widen the filter through the cursor', async () => {
    // A cursor only moves the position; the operator filter still applies.
    const res = await list(CASHIER_A, { cursor: '2026-10-17T00:00:00.000Z|zzz' });
    expect(okIds(res)).toEqual(['mine']);
  });
});
