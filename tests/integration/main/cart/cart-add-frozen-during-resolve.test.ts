/**
 * RT-347 — `cart.lines.add` awaits the item resolver between its mutability
 * gate and its write. A handoff (or a void) that commits during that await
 * must win: the add is refused `frozen`, writes no line and no outbox row,
 * and never moves the cart out of its frozen/cancelled state.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore, type CartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname0, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const SESSION: OperatorSessionRecord = {
  id: 'sess-347',
  operator_id: 'cashier-1',
  display_name: 'Cashier',
  role: 'cashier',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  started_at: '2026-10-10T08:00:00.000Z',
  backend_session_id: 'b',
  last_activity_at: '2026-10-10T08:00:00.000Z',
};

type ResolveResult = Awaited<ReturnType<ItemRefResolver>>;

interface Fixture {
  db: SqlJsDatabase;
  store: CartStore;
  handlers: CartBridgeHandlers;
  cart_id: string;
  line_id: string;
  /** The next resolver call waits until this is called. */
  holdNextResolve: () => () => void;
}

async function makeEditingCart(): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  let held: Promise<void> | null = null;
  const resolver: ItemRefResolver = async (): Promise<ResolveResult> => {
    if (held !== null) {
      const wait = held;
      held = null;
      await wait;
    }
    return { kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 };
  };
  const store = bindCartStore(makeSqlJsHandle(db));
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => SESSION,
    getTerminalId: () => 'terminal-347',
    cartStore: store,
    resolveItemRef: resolver,
    clock: () => new Date('2026-10-10T10:00:00.000Z'),
  });

  const c = await handlers.create({ idempotency_key: 'c' });
  if (c.kind !== 'ok') throw new Error('create failed');
  const a = await handlers.linesAdd({
    cart_id: c.cart_id,
    item_ref: 'SKU-A',
    quantity: 1,
    idempotency_key: 'a',
  });
  if (a.kind !== 'ok') throw new Error('add failed');

  const holdNextResolve = (): (() => void) => {
    let release!: () => void;
    held = new Promise<void>((r) => {
      release = r;
    });
    return release;
  };
  return { db, store, handlers, cart_id: c.cart_id, line_id: a.line_id, holdNextResolve };
}

function scalar(db: SqlJsDatabase, sql: string, params: string[]): unknown {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  const value = Object.values(stmt.getAsObject())[0];
  stmt.free();
  return value;
}

/** Lets the add reach its resolver await before the competing write. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function handoff(f: Fixture): Promise<void> {
  const h = await f.handlers.handoff({
    cart_id: f.cart_id,
    per_line_versions: [{ line_id: f.line_id, version: 1 }],
    idempotency_key: 'h',
  });
  if (h.kind !== 'ok') throw new Error(`handoff failed: ${JSON.stringify(h)}`);
}

describe('RT-347 — a handoff during the add resolver await wins', () => {
  it.each([
    ['a new line', 'SKU-B'],
    ['a merge onto the existing line', 'SKU-A'],
  ])('refuses %s with frozen and leaves the frozen cart untouched', async (_label, item_ref) => {
    const f = await makeEditingCart();
    const release = f.holdNextResolve();
    const pending = f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref,
      quantity: 2,
      idempotency_key: 'racing-add',
    });
    await flush();

    await handoff(f);
    const envelopeBefore = f.store.getCart(f.cart_id)?.handoff_envelope_json;
    expect(envelopeBefore).toBeTruthy();

    release();
    const res = await pending;

    expect(res).toEqual({ kind: 'refused', reason: 'frozen' });
    const cart = f.store.getCart(f.cart_id);
    expect(cart?.state).toBe('frozen_handed_off');
    expect(cart?.handoff_envelope_json).toBe(envelopeBefore);
    expect(cart?.cart_subtotal_minor).toBe(150);
    expect(f.store.getOutboxRow('racing-add')).toBeUndefined();
    expect(f.store.getActiveLines(f.cart_id).map((l) => [l.item_ref, l.quantity])).toEqual([
      ['SKU-A', 1],
    ]);
    expect(scalar(f.db, `SELECT COUNT(*) FROM cart_lines WHERE cart_id = ?`, [f.cart_id])).toBe(1);
  });

  it('refuses an add whose cart was voided during the await, without reviving it', async () => {
    const f = await makeEditingCart();
    const release = f.holdNextResolve();
    const pending = f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-B',
      quantity: 1,
      idempotency_key: 'racing-add',
    });
    await flush();

    const v = await f.handlers.void({ cart_id: f.cart_id, idempotency_key: 'v' });
    expect(v.kind).toBe('ok');

    release();
    const res = await pending;

    expect(res).toEqual({ kind: 'refused', reason: 'frozen' });
    expect(f.store.getCart(f.cart_id)?.state).toBe('cancelled');
    expect(f.store.getOutboxRow('racing-add')).toBeUndefined();
    expect(scalar(f.db, `SELECT COUNT(*) FROM cart_lines WHERE cart_id = ?`, [f.cart_id])).toBe(1);
  });

  it('still adds normally when nothing competes during the await', async () => {
    const f = await makeEditingCart();
    const release = f.holdNextResolve();
    const pending = f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-B',
      quantity: 1,
      idempotency_key: 'calm-add',
    });
    await flush();
    release();
    const res = await pending;

    expect(res.kind).toBe('ok');
    expect(f.store.getCart(f.cart_id)?.state).toBe('editing');
    expect(f.store.getCart(f.cart_id)?.cart_subtotal_minor).toBe(300);
  });
});

describe('RT-347 — the store re-proves mutability inside the write transaction', () => {
  it('insertLineAndOutbox and mergeLineAndOutbox write nothing on a frozen cart', async () => {
    const f = await makeEditingCart();
    await handoff(f);
    const now = '2026-10-10T11:00:00.000Z';
    const outbox = (action_id: string, kind: string, line_id: string) => ({
      action_id,
      cart_id: f.cart_id,
      line_id,
      action_kind: kind,
      acting_operator_id: 'cashier-1',
      attribution_operator_id: null,
      operator_session_id: SESSION.id,
      payload_json: '{}',
      applied_at: now,
    });

    const inserted = f.store.insertLineAndOutbox(
      {
        line_id: 'line-x',
        cart_id: f.cart_id,
        item_ref: 'SKU-X',
        display_name: 'X',
        quantity: 1,
        unit_price_minor: 100,
        line_subtotal_minor: 100,
        note: null,
        last_action_id: 'direct-add',
        created_at: now,
      },
      outbox('direct-add', 'cart.line.add', 'line-x'),
    );
    const merged = f.store.mergeLineAndOutbox(
      {
        line_id: f.line_id,
        quantity: 5,
        line_subtotal_minor: 750,
        last_action_id: 'direct-merge',
        updated_at: now,
      },
      outbox('direct-merge', 'cart.line.merge', f.line_id),
    );

    expect(inserted).toBe(false);
    expect(merged).toBe(false);
    expect(f.store.getCart(f.cart_id)?.state).toBe('frozen_handed_off');
    expect(f.store.getOutboxRow('direct-add')).toBeUndefined();
    expect(f.store.getOutboxRow('direct-merge')).toBeUndefined();
    expect(f.store.getLine(f.cart_id, f.line_id)?.quantity).toBe(1);
    expect(f.store.getLine(f.cart_id, 'line-x')).toBeUndefined();
  });
});
