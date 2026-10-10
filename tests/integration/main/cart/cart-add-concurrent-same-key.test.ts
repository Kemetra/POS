/**
 * RT-349 — two `cart.lines.add` calls with the same idempotency key can both
 * pass the replay check before the resolver await. The second must replay the
 * first's result (FR-018), not throw on the outbox primary key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
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
  id: 'sess-349',
  operator_id: 'cashier-1',
  display_name: 'Cashier',
  role: 'cashier',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  started_at: '2026-10-10T08:00:00.000Z',
  backend_session_id: 'b',
  last_activity_at: '2026-10-10T08:00:00.000Z',
  lock_state: 'active',
  locked_at: null,
};

type ResolveResult = Awaited<ReturnType<ItemRefResolver>>;

interface Fixture {
  store: CartStore;
  handlers: CartBridgeHandlers;
  cart_id: string;
  /** Every resolver call waits until the returned release is called. */
  holdResolver: () => () => void;
}

async function makeEditingCart(): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  let gate: Promise<void> | null = null;
  const resolver: ItemRefResolver = async (): Promise<ResolveResult> => {
    if (gate !== null) await gate;
    return { kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 };
  };
  const store = bindCartStore(makeSqlJsHandle(db));
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => SESSION,
    getTerminalId: () => 'terminal-349',
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

  const holdResolver = (): (() => void) => {
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    return () => {
      gate = null;
      release();
    };
  };
  return { store, handlers, cart_id: c.cart_id, holdResolver };
}

describe('RT-349 — concurrent adds with one idempotency key', () => {
  it.each([
    ['a new line', 'SKU-B', 1, false],
    ['a merge onto the existing line', 'SKU-A', 2, true],
  ])(
    'replays %s for the second call instead of throwing',
    async (_label, item_ref, expectedQty, merged) => {
      const f = await makeEditingCart();
      const release = f.holdResolver();
      const req = { cart_id: f.cart_id, item_ref, quantity: 1, idempotency_key: 'dup' };
      const first = f.handlers.linesAdd(req);
      const second = f.handlers.linesAdd(req);
      release();

      const [r1, r2] = await Promise.all([first, second]);

      expect(r1.kind).toBe('ok');
      expect(r2).toEqual(r1);
      if (r1.kind !== 'ok') return;
      expect(r1.merged).toBe(merged);
      expect(f.store.getOutboxRow('dup')?.line_id).toBe(r1.line_id);
      const line = f.store.getLine(f.cart_id, r1.line_id);
      expect(line?.quantity).toBe(expectedQty);
      expect(f.store.getActiveLines(f.cart_id).filter((l) => l.item_ref === item_ref)).toHaveLength(
        1,
      );
    },
  );

  // FR-018 / 0009: the same key with a different payload is refused, never
  // answered with the first call's result.
  const MISMATCHES: ReadonlyArray<[string, string, number, string, number]> = [
    ['a different item on a new line', 'SKU-B', 1, 'SKU-C', 1],
    ['a different quantity on a new line', 'SKU-B', 1, 'SKU-B', 3],
    ['a different quantity on a merge', 'SKU-A', 1, 'SKU-A', 3],
  ];

  it.each(MISMATCHES)(
    'refuses %s when the calls overlap',
    async (_label, item1, qty1, item2, qty2) => {
      const f = await makeEditingCart();
      const release = f.holdResolver();
      const first = f.handlers.linesAdd({
        cart_id: f.cart_id,
        item_ref: item1,
        quantity: qty1,
        idempotency_key: 'dup',
      });
      const second = f.handlers.linesAdd({
        cart_id: f.cart_id,
        item_ref: item2,
        quantity: qty2,
        idempotency_key: 'dup',
      });
      release();

      const [r1, r2] = await Promise.all([first, second]);
      expect(r1.kind).toBe('ok');
      expect(r2).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    },
  );

  it.each(MISMATCHES)('refuses %s on a later retry', async (_label, item1, qty1, item2, qty2) => {
    const f = await makeEditingCart();
    const r1 = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: item1,
      quantity: qty1,
      idempotency_key: 'dup',
    });
    const r2 = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: item2,
      quantity: qty2,
      idempotency_key: 'dup',
    });
    expect(r1.kind).toBe('ok');
    expect(r2).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });
});
