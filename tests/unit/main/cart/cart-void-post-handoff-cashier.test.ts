/**
 * T056 — cart.void post-handoff: cashier path (S3 contract).
 *
 * A cart in `frozen_handed_off` state is immutable for the cashier. The gate
 * layer (already live in S2) MUST refuse with `reason: 'frozen'` for any
 * mutating operation, including void.
 *
 * This test covers the cashier-refusal path for post-handoff carts. The
 * manager-attribution path for a post-handoff cancel is T057 (a distinct
 * action category: `cart.cancel.post_handoff`).
 *
 * The `frozen` refusal is already GREEN in S2 via `gateMutatingS2`.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
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
    id: 'sess-t056',
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

interface Fixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
}

async function newFrozenCart(session = makeSession()): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handle = makeSqlJsHandle(db);
  const store = bindCartStore(handle);
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-test-380',
    cartStore: store,
    clock: () => new Date('2026-05-16T10:00:00.000Z'),
  });

  const createRes = await handlers.create({ idempotency_key: 'create-t056' });
  if (createRes.kind !== 'ok') throw new Error('create failed');

  // Simulate post-handoff state: frozen_handed_off.
  db.run(`UPDATE carts SET state = 'frozen_handed_off' WHERE cart_id = ?`, [createRes.cart_id]);

  return { db, handlers, cart_id: createRes.cart_id };
}

// ── S2-live gate layer: frozen refusal ─────────────────────────────────────

describe('cart.void — frozen cart (S2 live — GREEN)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newFrozenCart();
  });

  it('refuses void on a frozen_handed_off cart with reason frozen', async () => {
    const res = await f.handlers.void({
      cart_id: f.cart_id,
      idempotency_key: 'void-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('refuses linesAdd on a frozen_handed_off cart', async () => {
    const res = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-X',
      quantity: 1,
      idempotency_key: 'add-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('refuses discountPlaceholdersAdd on a frozen_handed_off cart', async () => {
    const res = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: 'line-x',
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('a manager also gets frozen refusal — post-handoff cancel uses a separate action (T057)', async () => {
    const mgr = makeSession({ id: 'sess-mgr-56', operator_id: 'mgr-56', role: 'manager' });
    // Rebind store to same DB so manager sees the same frozen cart.
    const handle = makeSqlJsHandle(f.db);
    const store = bindCartStore(handle);
    const mgrHandlers = new CartBridgeHandlers({
      getCurrentSession: () => mgr,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store,
    });
    const res = await mgrHandlers.void({
      cart_id: f.cart_id,
      idempotency_key: 'void-mgr-frozen',
    });
    // void on frozen is always refused — the cancel.post_handoff action is
    // a different bridge call, not the void path.
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });
});
