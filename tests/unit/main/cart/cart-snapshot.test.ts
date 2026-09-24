import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

/**
 * V5 active cart read — `cart.snapshot`. The read-only, session-gated
 * projection that lets a renderer reopen the SAME persisted cart it already
 * knows the id of. Authority stays in main + SQLite; the renderer supplies
 * only `cart_id`, never identity.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
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

function mkSession(overrides: Partial<OperatorSessionRecord> = {}): OperatorSessionRecord {
  return {
    id: 'sess-owner',
    operator_id: 'cashier-1',
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-09-24T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-09-24T08:00:00.000Z',
    ...overrides,
  };
}

const PRODUCTS: Record<string, { display_name: string; unit_price_minor: number }> = {
  'p-para': { display_name: 'باراسيتامول ٥٠٠ مجم', unit_price_minor: 1250 },
  'p-amox': { display_name: 'أموكسيسيلين ٢٥٠ مجم', unit_price_minor: 4500 },
  'p-vitc': { display_name: 'فيتامين سي', unit_price_minor: 2000 },
};

const resolver: ItemRefResolver = (item_ref) => {
  const p = PRODUCTS[item_ref];
  return Promise.resolve(p ? { kind: 'ok', ...p } : { kind: 'refused', reason: 'unknown_item' });
};

interface Fixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
  lineIds: string[];
  setSession: (s: OperatorSessionRecord | null) => void;
}

/** Advancing clock so line order (created_at) is deterministic. */
function advancingClock(): () => Date {
  let t = Date.parse('2026-09-24T10:00:00.000Z');
  return () => new Date((t += 1000));
}

async function fixture(): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  let current: OperatorSessionRecord | null = mkSession();
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => current,
    getTerminalId: () => 'terminal-1',
    cartStore: bindCartStore(makeSqlJsHandle(db)),
    resolveItemRef: resolver,
    clock: advancingClock(),
  });
  const c = await handlers.create({ idempotency_key: 'k-create' });
  if (c.kind !== 'ok') throw new Error('create failed');
  const lineIds: string[] = [];
  for (const [i, ref] of ['p-para', 'p-amox', 'p-vitc'].entries()) {
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: ref,
      quantity: i === 1 ? 3 : 1,
      idempotency_key: `k-add-${ref}`,
    });
    if (a.kind !== 'ok') throw new Error('add failed');
    lineIds.push(a.line_id);
  }
  return {
    db,
    handlers,
    cart_id: c.cart_id,
    lineIds,
    setSession: (s) => {
      current = s;
    },
  };
}

describe('cart.snapshot — trust boundary', () => {
  it('refuses generically with no operator session', async () => {
    const f = await fixture();
    f.setSession(null);
    expect(await f.handlers.snapshot({ cart_id: f.cart_id })).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
  });

  it('refuses an unknown cart id without distinguishing it from a foreign one', async () => {
    const f = await fixture();
    const res = await f.handlers.snapshot({ cart_id: 'no-such-cart' });
    expect(res.kind).toBe('refused');
  });

  it("refuses another cashier's cart in the same branch (wrong owner)", async () => {
    const f = await fixture();
    f.setSession(mkSession({ id: 'sess-other', operator_id: 'cashier-2' }));
    expect(await f.handlers.snapshot({ cart_id: f.cart_id })).toEqual({
      kind: 'refused',
      reason: 'wrong_owner',
    });
  });

  it('refuses a cart from another tenant/branch even for a manager', async () => {
    const f = await fixture();
    f.setSession(mkSession({ id: 'sess-m', role: 'manager', branch_id: 'branch-2' }));
    const res = await f.handlers.snapshot({ cart_id: f.cart_id });
    expect(res).toEqual({ kind: 'refused', reason: 'tenant_isolation' });
  });

  it('refuses after the gate when no durable cart store is wired (S1 in-memory mode)', async () => {
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => mkSession(),
      getTerminalId: () => 'terminal-1',
    });
    const c = await handlers.create({ idempotency_key: 'k' });
    if (c.kind !== 'ok') throw new Error('create failed');
    expect(await handlers.snapshot({ cart_id: c.cart_id })).toEqual({
      kind: 'refused',
      reason: 'not_implemented',
    });
  });
});

describe('cart.snapshot — faithful, display-safe projection', () => {
  it('returns the persisted lines in add order with exact quantities, prices, subtotals, notes and versions', async () => {
    const f = await fixture();
    const noted = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.lineIds[1] ?? '',
      note: 'بعد الأكل',
      version: 1,
      idempotency_key: 'k-note',
    });
    expect(noted).toEqual({ kind: 'ok', version: 2 });

    const res = await f.handlers.snapshot({ cart_id: f.cart_id });
    expect(res).toEqual({
      kind: 'ok',
      snapshot: {
        cart_id: f.cart_id,
        state: 'editing',
        lines: [
          {
            line_id: f.lineIds[0],
            display_name: 'باراسيتامول ٥٠٠ مجم',
            quantity: 1,
            unit_price_minor: 1250,
            line_subtotal_minor: 1250,
            note: null,
            version: 1,
          },
          {
            line_id: f.lineIds[1],
            display_name: 'أموكسيسيلين ٢٥٠ مجم',
            quantity: 3,
            unit_price_minor: 4500,
            line_subtotal_minor: 13500,
            note: 'بعد الأكل',
            version: 2,
          },
          {
            line_id: f.lineIds[2],
            display_name: 'فيتامين سي',
            quantity: 1,
            unit_price_minor: 2000,
            line_subtotal_minor: 2000,
            note: null,
            version: 1,
          },
        ],
        discount_placeholders: [],
        envelope: null,
      },
    });
  });

  it('excludes removed lines and returns an empty existing cart as the same cart', async () => {
    const f = await fixture();
    for (const [i, id] of f.lineIds.entries()) {
      const r = await f.handlers.linesRemove({
        cart_id: f.cart_id,
        line_id: id,
        version: 1,
        idempotency_key: `k-rm-${String(i)}`,
      });
      expect(r.kind).toBe('ok');
    }
    const res = await f.handlers.snapshot({ cart_id: f.cart_id });
    expect(res.kind === 'ok' && res.snapshot.cart_id).toBe(f.cart_id);
    expect(res.kind === 'ok' && res.snapshot.lines).toEqual([]);
  });

  it('never exposes identity, catalogue refs, attribution or action ids', async () => {
    const f = await fixture();
    const added = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.lineIds[0] ?? '',
      placeholder_kind: 'percent_off_below_threshold',
      idempotency_key: 'k-disc',
    });
    expect(added.kind).toBe('ok');
    const res = await f.handlers.snapshot({ cart_id: f.cart_id });
    if (res.kind !== 'ok') throw new Error('snapshot refused');
    expect(Object.keys(res.snapshot).sort()).toEqual(
      ['cart_id', 'discount_placeholders', 'envelope', 'lines', 'state'].sort(),
    );
    for (const line of res.snapshot.lines) {
      expect(Object.keys(line).sort()).toEqual(
        [
          'display_name',
          'line_id',
          'line_subtotal_minor',
          'note',
          'quantity',
          'unit_price_minor',
          'version',
        ].sort(),
      );
    }
    expect(res.snapshot.discount_placeholders).toHaveLength(1);
    expect(Object.keys(res.snapshot.discount_placeholders[0] ?? {}).sort()).toEqual([
      'line_id',
      'placeholder_id',
    ]);
    const wire = JSON.stringify(res);
    for (const forbidden of [
      'tenant-1',
      'branch-1',
      'terminal-1',
      'sess-owner',
      'cashier-1',
      'p-para',
      'k-add',
      'attribution',
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it('is read-only: the database is byte-identical before and after', async () => {
    const f = await fixture();
    const before = f.db.export();
    await f.handlers.snapshot({ cart_id: f.cart_id });
    await f.handlers.snapshot({ cart_id: f.cart_id });
    expect(Buffer.from(f.db.export()).equals(Buffer.from(before))).toBe(true);
  });

  it('returns versions the authority accepts: the snapshot version mutates, a stale one is refused', async () => {
    const f = await fixture();
    const first = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.lineIds[0] ?? '',
      op: 'increment',
      version: 1,
      idempotency_key: 'k-inc-1',
    });
    expect(first).toEqual({ kind: 'ok', version: 2 });

    const res = await f.handlers.snapshot({ cart_id: f.cart_id });
    if (res.kind !== 'ok') throw new Error('snapshot refused');
    const line = res.snapshot.lines[0];
    expect(line?.version).toBe(2);
    expect(line?.quantity).toBe(2);

    const stale = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.lineIds[0] ?? '',
      op: 'increment',
      version: 1,
      idempotency_key: 'k-inc-stale',
    });
    expect(stale).toEqual({ kind: 'refused', reason: 'stale_version' });
    const next = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.lineIds[0] ?? '',
      op: 'increment',
      version: line?.version ?? -1,
      idempotency_key: 'k-inc-2',
    });
    expect(next).toEqual({ kind: 'ok', version: 3 });
  });

  it('reads a handed-off cart with its frozen envelope so the sale can continue to payment', async () => {
    const f = await fixture();
    const handoff = await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: f.lineIds.map((line_id) => ({ line_id, version: 1 })),
      idempotency_key: 'k-handoff',
    });
    if (handoff.kind !== 'ok') throw new Error('handoff refused');
    const res = await f.handlers.snapshot({ cart_id: f.cart_id });
    if (res.kind !== 'ok') throw new Error('snapshot refused');
    expect(res.snapshot.state).toBe('frozen_handed_off');
    expect(res.snapshot.envelope).toEqual(handoff.envelope);
  });

  it('reads a voided cart as cancelled (readable, not mutable)', async () => {
    const f = await fixture();
    expect(await f.handlers.void({ cart_id: f.cart_id, idempotency_key: 'k-void' })).toEqual({
      kind: 'ok',
    });
    const res = await f.handlers.snapshot({ cart_id: f.cart_id });
    expect(res.kind === 'ok' && res.snapshot.state).toBe('cancelled');
  });

  it('lets a manager read a cashier cart in the same branch, like every other cart handler', async () => {
    const f = await fixture();
    f.setSession(mkSession({ id: 'sess-m', operator_id: 'mgr-1', role: 'manager' }));
    const res = await f.handlers.snapshot({ cart_id: f.cart_id });
    expect(res.kind).toBe('ok');
  });
});
