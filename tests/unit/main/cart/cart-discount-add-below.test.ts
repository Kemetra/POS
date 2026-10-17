/**
 * T059 — cart.discountPlaceholders.add for a small discount on a cashier
 * session.
 *
 * RT-608 (RT-28, spec 005 FR-023 revised) retires the threshold: there is no
 * "below-threshold" discount any more. Every positive manual discount needs
 * manager authority, so a cashier's 5% (or 1%) discount with no approval is
 * refused `manager_attribution_required` and writes nothing: no placeholder,
 * no outbox row, no audit row. The approved path is covered end to end by
 * `src/main/cart/__tests__/discount-manual-approval.e2e.test.ts`.
 *
 * Gate-layer tests are unchanged. */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname0, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0050_carts_park.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function makeSession(overrides?: Partial<OperatorSessionRecord>): OperatorSessionRecord {
  return {
    id: 'sess-t059',
    operator_id: 'cashier-1',
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-16T08:00:00.000Z',
    backend_session_id: 'b-sess-1',
    last_activity_at: '2026-05-16T08:00:00.000Z',
    ...overrides,
  };
}

const fixtureResolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

interface Fixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
  line_id: string;
}

async function newCartWithLine(session = makeSession()): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handle = makeSqlJsHandle(db);
  const store = bindCartStore(handle);
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-test-380',
    cartStore: store,
    resolveItemRef: fixtureResolver,
    clock: () => new Date('2026-05-16T10:00:00.000Z'),
  });

  const createRes = await handlers.create({ idempotency_key: 'create-t059' });
  if (createRes.kind !== 'ok') throw new Error('create failed');

  const addRes = await handlers.linesAdd({
    cart_id: createRes.cart_id,
    item_ref: 'SKU-A',
    quantity: 2,
    idempotency_key: 'add-t059',
  });
  if (addRes.kind !== 'ok') throw new Error('linesAdd failed');

  return { db, handlers, cart_id: createRes.cart_id, line_id: addRes.line_id };
}

function readDiscountPlaceholders(db: SqlJsDatabase, cart_id: string): Record<string, unknown>[] {
  const stmt = db.prepare('SELECT * FROM cart_line_discount_placeholders WHERE cart_id = ?');
  stmt.bind([cart_id]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function readOutboxKinds(db: SqlJsDatabase, cart_id: string): string[] {
  const stmt = db.prepare(
    'SELECT action_kind FROM cart_action_outbox WHERE cart_id = ? ORDER BY applied_at',
  );
  stmt.bind([cart_id]);
  const kinds: string[] = [];
  while (stmt.step()) kinds.push(stmt.getAsObject()['action_kind'] as string);
  stmt.free();
  return kinds;
}

// ── Gate layer (S2 live — GREEN) ───────────────────────────────────────────

describe('cart.discountPlaceholders.add — gate layer (S2 live)', () => {
  it('refuses when no session', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
    });
    const res = await handlers.discountPlaceholdersAdd({
      cart_id: 'cart-x',
      line_id: 'line-x',
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-no-sess',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('no_session');
  });

  it('refuses when cart does not exist', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const session = makeSession();
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
    });
    const res = await handlers.discountPlaceholdersAdd({
      cart_id: 'nonexistent',
      line_id: 'line-x',
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-no-cart',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('wrong_owner');
  });
});

// ── RT-608: no threshold — a cashier's small discount needs a manager ─────

describe('cart.discountPlaceholders.add — no threshold (RT-608)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newCartWithLine();
  });

  it.each([['percent_5'], ['percent_1']])(
    'refuses a cashier %s with no approval: manager_attribution_required',
    async (kind) => {
      const res = await f.handlers.discountPlaceholdersAdd({
        cart_id: f.cart_id,
        line_id: f.line_id,
        placeholder_kind: kind,
        idempotency_key: 'dp-t059-a',
      });
      expect(res).toEqual({ kind: 'refused', reason: 'manager_attribution_required' });
    },
  );

  it('writes no placeholder row and no outbox row when refused', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-t059-b',
    });
    expect(readDiscountPlaceholders(f.db, f.cart_id)).toHaveLength(0);
    expect(readOutboxKinds(f.db, f.cart_id).some((k) => k.startsWith('cart.discount'))).toBe(false);
  });

  it('a manager session applies the same small discount directly (D2)', async () => {
    const m = await newCartWithLine(makeSession({ role: 'manager', operator_id: 'mgr-t059' }));
    const res = await m.handlers.discountPlaceholdersAdd({
      cart_id: m.cart_id,
      line_id: m.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-t059-c',
    });
    expect(res).toMatchObject({ kind: 'ok', requires_manager_attribution: true });
    const rows = readDiscountPlaceholders(m.db, m.cart_id);
    expect(rows[0]?.['requires_manager_attribution']).toBe(1);
    expect(rows[0]?.['attribution_operator_id']).toBe('mgr-t059');
  });
});
