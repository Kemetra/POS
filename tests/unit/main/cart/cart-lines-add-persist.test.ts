import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

/**
 * T031 — `cart.lines.add` persistence (new-line path).
 *
 * Writes carts + cart_lines + cart_action_outbox in a single transaction;
 * cart transitions empty→editing on first add.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
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

function makeSession(): OperatorSessionRecord {
  return {
    id: 'sess-t031',
    operator_id: 'cashier-1',
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-14T08:00:00.000Z',
    backend_session_id: 'b-1',
    last_activity_at: '2026-05-14T08:00:00.000Z',
  };
}

const fixtureResolver: ItemRefResolver = (item_ref) => {
  const fixtures: Record<string, { display_name: string; unit_price_minor: number }> = {
    'SKU-A': { display_name: 'Aspirin 500mg', unit_price_minor: 150 },
    'SKU-B': { display_name: 'Bandage', unit_price_minor: 80 },
  };
  const f = fixtures[item_ref];
  if (f === undefined) return Promise.resolve({ kind: 'refused', reason: 'unknown_item' });
  return Promise.resolve({ kind: 'ok', ...f });
};

interface Fixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
}

async function newCart(session: OperatorSessionRecord = makeSession()): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handle = makeSqlJsHandle(db);
  const store = bindCartStore(handle);
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-test-380',
    cartStore: store,
    resolveItemRef: fixtureResolver,
    clock: () => new Date('2026-05-14T10:00:00.000Z'),
  });
  const create = await handlers.create({ idempotency_key: 'create-k' });
  if (create.kind !== 'ok') throw new Error('cart.create failed');
  return { db, handlers, cart_id: create.cart_id };
}

function readLines(db: SqlJsDatabase, cart_id: string): Record<string, unknown>[] {
  const stmt = db.prepare('SELECT * FROM cart_lines WHERE cart_id = ?');
  stmt.bind([cart_id]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function readOutbox(db: SqlJsDatabase, cart_id: string): Record<string, unknown>[] {
  const stmt = db.prepare('SELECT * FROM cart_action_outbox WHERE cart_id = ? ORDER BY applied_at');
  stmt.bind([cart_id]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function readCart(db: SqlJsDatabase, cart_id: string): Record<string, unknown> | null {
  const stmt = db.prepare('SELECT * FROM carts WHERE cart_id = ?');
  stmt.bind([cart_id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

describe('cart.lines.add — new-line path persists in a single transaction', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newCart();
  });

  it('inserts a cart_lines row and a cart_action_outbox row', async () => {
    const r = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: 'add-1',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.merged).toBe(false);
      expect(r.version).toBe(1);
    }
    expect(readLines(f.db, f.cart_id)).toHaveLength(1);
    const outbox = readOutbox(f.db, f.cart_id);
    // 1 cart.create + 1 cart.line.add
    expect(outbox).toHaveLength(2);
    expect(outbox[1]?.['action_kind']).toBe('cart.line.add');
  });

  it('snapshots display_name and unit_price_minor from the resolver', async () => {
    await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'add-2',
    });
    const line = readLines(f.db, f.cart_id)[0];
    expect(line?.['display_name']).toBe('Aspirin 500mg');
    expect(line?.['unit_price_minor']).toBe(150);
    expect(line?.['line_subtotal_minor']).toBe(150);
  });

  it('transitions the cart from empty → editing on first add', async () => {
    expect(readCart(f.db, f.cart_id)?.['state']).toBe('empty');
    await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'add-3',
    });
    expect(readCart(f.db, f.cart_id)?.['state']).toBe('editing');
  });

  it('recomputes cart_subtotal_minor across the cart', async () => {
    await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: 'add-4',
    });
    await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-B',
      quantity: 3,
      idempotency_key: 'add-5',
    });
    // 2×150 + 3×80 = 540
    expect(readCart(f.db, f.cart_id)?.['cart_subtotal_minor']).toBe(540);
  });

  it('refuses when item_ref is unknown', async () => {
    const r = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'NOPE',
      quantity: 1,
      idempotency_key: 'add-6',
    });
    expect(r.kind).toBe('refused');
  });
});

describe('cart.lines.add — Q4 merge path (T032)', () => {
  it('merges into the existing active line for the same item_ref', async () => {
    const f = await newCart();
    const r1 = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: 'add-7',
    });
    const r2 = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 3,
      idempotency_key: 'add-8',
    });
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    if (r1.kind === 'ok' && r2.kind === 'ok') {
      expect(r2.line_id).toBe(r1.line_id);
      expect(r2.merged).toBe(true);
      expect(r2.version).toBe(2);
    }
    const lines = readLines(f.db, f.cart_id);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['quantity']).toBe(5);
    expect(lines[0]?.['line_subtotal_minor']).toBe(750); // 5 × 150
    const outbox = readOutbox(f.db, f.cart_id);
    // create + line.add + line.merge
    expect(outbox.map((r) => r['action_kind'])).toEqual([
      'cart.create',
      'cart.line.add',
      'cart.line.merge',
    ]);
  });

  it('preserves unit_price_minor across a merge (no re-snapshot)', async () => {
    const f = await newCart();
    await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'mer-1',
    });
    await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 4,
      idempotency_key: 'mer-2',
    });
    expect(readLines(f.db, f.cart_id)[0]?.['unit_price_minor']).toBe(150);
  });
});
