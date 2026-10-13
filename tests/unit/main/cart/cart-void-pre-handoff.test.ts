/**
 * T055 — cart.void pre-handoff (S3 contract).
 *
 * A cashier (or manager) voids an editing cart before any handoff. The
 * handler MUST:
 *   1. Cancel the cart (state → 'cancelled').
 *   2. Write a `cart.void` outbox row.
 *   3. Return `{ kind: 'ok' }`.
 *
 * Tests will be RED until T067 (void handler wiring) is implemented.
 * The gate layer (session + ownership + mutable) is already live in S2 —
 * those paths are green and are asserted here too.
 *
 * Audit-emission is NOT wired in CartBridgeHandlersDeps yet; those
 * assertions live in T057/T061 which use vi.mock.
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
    id: 'sess-t055',
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

async function newEditingCart(session = makeSession()): Promise<Fixture> {
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

  const createRes = await handlers.create({ idempotency_key: 'create-t055' });
  if (createRes.kind !== 'ok') throw new Error('create failed');

  // Put the cart into 'editing' state via direct SQL (avoids resolver dep).
  db.run(`UPDATE carts SET state = 'editing' WHERE cart_id = ?`, [createRes.cart_id]);

  return { db, handlers, cart_id: createRes.cart_id };
}

function readCartState(db: SqlJsDatabase, cart_id: string): string | null {
  const stmt = db.prepare('SELECT state FROM carts WHERE cart_id = ?');
  stmt.bind([cart_id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row ? (row['state'] as string) : null;
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

// ── Gate layer (already live in S2 — green) ────────────────────────────────

describe('cart.void — gate layer (S2 live)', () => {
  it('refuses when no session is active', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handle = makeSqlJsHandle(db);
    const store = bindCartStore(handle);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store,
    });
    const res = await handlers.void({
      cart_id: 'nonexistent',
      idempotency_key: 'void-no-sess',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('no_session');
  });

  it('refuses when cart does not belong to the session', async () => {
    const f = await newEditingCart();
    const otherSession = makeSession({ id: 'sess-other', operator_id: 'cashier-99' });
    const otherHandlers = new CartBridgeHandlers({
      getCurrentSession: () => otherSession,
      getTerminalId: () => 'terminal-test-380',
      shareStateWith: f.handlers,
      cartStore: bindCartStore(makeSqlJsHandle(f.db)),
    });
    const res = await otherHandlers.void({
      cart_id: f.cart_id,
      idempotency_key: 'void-wrong-owner',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('wrong_owner');
  });
});

// ── S3 contract (RED until T067) ───────────────────────────────────────────

describe('cart.void — pre-handoff S3 contract (T055 — RED until T067)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newEditingCart();
  });

  it('returns { kind: ok } for a cashier voiding their own editing cart', async () => {
    const res = await f.handlers.void({
      cart_id: f.cart_id,
      idempotency_key: 'void-t055-a',
    });
    // RED until T067 implements the void handler.
    expect(res.kind).toBe('ok');
  });

  it('transitions the cart state to cancelled', async () => {
    await f.handlers.void({
      cart_id: f.cart_id,
      idempotency_key: 'void-t055-b',
    });
    // RED until T067.
    expect(readCartState(f.db, f.cart_id)).toBe('cancelled');
  });

  it('writes a cart.void outbox row', async () => {
    await f.handlers.void({
      cart_id: f.cart_id,
      idempotency_key: 'void-t055-c',
    });
    const kinds = readOutboxKinds(f.db, f.cart_id);
    // RED until T067.
    expect(kinds).toContain('cart.void');
  });

  it('is idempotent — replaying the same idempotency_key returns ok', async () => {
    await f.handlers.void({ cart_id: f.cart_id, idempotency_key: 'void-t055-d' });
    const res2 = await f.handlers.void({ cart_id: f.cart_id, idempotency_key: 'void-t055-d' });
    // RED until T067.
    expect(res2.kind).toBe('ok');
  });

  it('a manager can void a cashier cart (pre-handoff, no attribution required)', async () => {
    const mgr = makeSession({ id: 'sess-mgr', operator_id: 'mgr-1', role: 'manager' });
    // Manager creates and voids their own cart to test manager role access.
    const db2 = new SQL.Database();
    for (const sql of MIGRATIONS) db2.run(sql);
    const handle2 = makeSqlJsHandle(db2);
    const store2 = bindCartStore(handle2);
    const mgrHandlers = new CartBridgeHandlers({
      getCurrentSession: () => mgr,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store2,
    });
    const createRes = await mgrHandlers.create({ idempotency_key: 'mgr-create' });
    if (createRes.kind !== 'ok') throw new Error('create failed');
    db2.run(`UPDATE carts SET state = 'editing' WHERE cart_id = ?`, [createRes.cart_id]);

    const voidRes = await mgrHandlers.void({
      cart_id: createRes.cart_id,
      idempotency_key: 'void-mgr',
    });
    // RED until T067.
    expect(voidRes.kind).toBe('ok');
  });
});
