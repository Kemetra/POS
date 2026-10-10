/**
 * RT-350 — `cart.lines.add` awaits the item resolver after its session gate.
 * If the session that started the add signs out, is swapped or locks during
 * that await, the add must be refused with nothing written: no line, no
 * outbox row attributed to a session that is no longer live.
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

function makeSession(overrides?: Partial<OperatorSessionRecord>): OperatorSessionRecord {
  return {
    id: 'sess-350',
    operator_id: 'manager-1',
    display_name: 'Manager',
    role: 'manager',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-10T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-10-10T08:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
    ...overrides,
  };
}

type ResolveResult = Awaited<ReturnType<ItemRefResolver>>;

interface Fixture {
  store: CartStore;
  handlers: CartBridgeHandlers;
  cart_id: string;
  /** The live session record, mutated in place like the session manager does. */
  session: OperatorSessionRecord;
  setCurrent: (s: OperatorSessionRecord | null) => void;
  /** The next resolver call waits until the returned release is called. */
  holdNextResolve: () => () => void;
}

async function makeEditingCart(): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const session = makeSession();
  let current: OperatorSessionRecord | null = session;
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
    getCurrentSession: () => current,
    getTerminalId: () => 'terminal-350',
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
  const setCurrent = (s: OperatorSessionRecord | null): void => {
    current = s;
  };
  return { store, handlers, cart_id: c.cart_id, session, setCurrent, holdNextResolve };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const CHANGES: ReadonlyArray<[string, (f: Fixture) => void]> = [
  [
    'signs out',
    (f) => {
      f.setCurrent(null);
    },
  ],
  [
    'is swapped for another session',
    (f) => {
      f.setCurrent(makeSession({ id: 'sess-other' }));
    },
  ],
  [
    'locks',
    (f) => {
      f.session.lock_state = 'locked';
      f.session.locked_at = '2026-10-10T10:00:01.000Z';
    },
  ],
];

describe('RT-350 — the session that started the add must still be live at write time', () => {
  for (const item_ref of ['SKU-B', 'SKU-A']) {
    it.each(CHANGES)(
      `refuses the add (${item_ref}) when the session %s during the await`,
      async (_label, change) => {
        const f = await makeEditingCart();
        const release = f.holdNextResolve();
        const pending = f.handlers.linesAdd({
          cart_id: f.cart_id,
          item_ref,
          quantity: 2,
          idempotency_key: 'late-add',
        });
        await flush();
        change(f);
        release();

        expect(await pending).toEqual({ kind: 'refused', reason: 'no_session' });
        expect(f.store.getOutboxRow('late-add')).toBeUndefined();
        expect(f.store.getActiveLines(f.cart_id).map((l) => [l.item_ref, l.quantity])).toEqual([
          ['SKU-A', 1],
        ]);
        expect(f.store.getCart(f.cart_id)?.cart_subtotal_minor).toBe(150);
      },
    );
  }

  it('adds normally when the session locks and unlocks before the await ends', async () => {
    const f = await makeEditingCart();
    const release = f.holdNextResolve();
    const pending = f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-B',
      quantity: 1,
      idempotency_key: 'calm-add',
    });
    await flush();
    f.session.lock_state = 'locked';
    f.session.lock_state = 'active';
    release();

    expect((await pending).kind).toBe('ok');
    expect(f.store.getOutboxRow('calm-add')?.operator_session_id).toBe('sess-350');
  });
});
