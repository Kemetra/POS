import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore, type CartStore } from '../../../../src/main/cart/cart-store.js';
import { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../../../src/main/audit/audit-events-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

/**
 * RT-254 — `cart.undoLast` (contract RT-245, Confluence RETAIL 24248322).
 *
 * Main owns Undo: the renderer names only the action it just completed; main
 * proves that action is still the cart's newest and applies the exact inverse
 * in one conditional transaction. Lineage lives in `cart_action_outbox`
 * (`undo_of_action_id`); routine Undo emits ZERO central audit events
 * (005 FR-027) — asserted against a real `audit_events` table.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0004_audit_events.sql',
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0037_cart_action_outbox_return_to_sale.sql',
  '0045_cart_action_outbox_line_restore.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function session(overrides: Partial<OperatorSessionRecord> = {}): OperatorSessionRecord {
  return {
    id: 'sess-undo',
    operator_id: 'cashier-1',
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-10T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-10-10T08:00:00.000Z',
    ...overrides,
  };
}

const resolver: ItemRefResolver = (item_ref) => {
  if (item_ref === 'SKU-A')
    return Promise.resolve({ kind: 'ok', display_name: 'Panadol', unit_price_minor: 100 });
  if (item_ref === 'SKU-B')
    return Promise.resolve({ kind: 'ok', display_name: 'Brufen', unit_price_minor: 250 });
  return Promise.resolve({ kind: 'refused', reason: 'unknown_item' });
};

interface Fixture {
  db: SqlJsDatabase;
  store: CartStore;
  handlers: CartBridgeHandlers;
  cart_id: string;
  make: (opts?: {
    session?: OperatorSessionRecord | null;
    store?: CartStore;
  }) => CartBridgeHandlers;
}

async function fixture(): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handle = makeSqlJsHandle(db);
  const store = bindCartStore(handle);
  const auditEmitter = new AuditEmitter(bindAuditEventsStoreDb(handle));
  const make: Fixture['make'] = (opts = {}) =>
    new CartBridgeHandlers({
      getCurrentSession: () => (opts.session === undefined ? session() : opts.session),
      getTerminalId: () => 'terminal-undo',
      cartStore: opts.store ?? store,
      resolveItemRef: resolver,
      auditEmitter,
      cartPaymentStatus: () => 'none',
      clock: () => new Date('2026-10-10T10:00:00.000Z'),
    });
  const handlers = make();
  const c = await handlers.create({ idempotency_key: 'c-1' });
  if (c.kind !== 'ok') throw new Error('create failed');
  return { db, store, handlers, cart_id: c.cart_id, make };
}

function scalar(db: SqlJsDatabase, sql: string, params: (string | number)[] = []): unknown {
  return db.exec(sql, params)[0]?.values[0]?.[0];
}

function outboxCount(db: SqlJsDatabase): number {
  return scalar(db, `SELECT COUNT(*) FROM cart_action_outbox`) as number;
}

function auditCount(db: SqlJsDatabase): number {
  return scalar(db, `SELECT COUNT(*) FROM audit_events`) as number;
}

function lineRow(db: SqlJsDatabase, line_id: string): Record<string, unknown> {
  const res = db.exec(`SELECT * FROM cart_lines WHERE line_id = ?`, [line_id])[0];
  if (res === undefined) throw new Error('no line');
  return Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i]]));
}

function cartRow(db: SqlJsDatabase, cart_id: string): Record<string, unknown> {
  const res = db.exec(`SELECT * FROM carts WHERE cart_id = ?`, [cart_id])[0];
  if (res === undefined) throw new Error('no cart');
  return Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i]]));
}

function outbox(db: SqlJsDatabase, action_id: string): Record<string, unknown> {
  const res = db.exec(`SELECT * FROM cart_action_outbox WHERE action_id = ?`, [action_id])[0];
  if (res === undefined) throw new Error('no outbox row');
  return Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i]]));
}

/** Everything a refused Undo must leave untouched. */
function stateDigest(db: SqlJsDatabase): unknown {
  return {
    outbox: db.exec(`SELECT rowid, * FROM cart_action_outbox ORDER BY rowid`)[0]?.values,
    lines: db.exec(`SELECT * FROM cart_lines ORDER BY line_id`)[0]?.values,
    carts: db.exec(`SELECT * FROM carts ORDER BY cart_id`)[0]?.values,
    placeholders: db.exec(`SELECT * FROM cart_line_discount_placeholders`)[0]?.values,
  };
}

async function add(
  f: Fixture,
  key: string,
  item_ref = 'SKU-A',
  quantity = 1,
): Promise<{ line_id: string; version: number }> {
  const r = await f.handlers.linesAdd({
    cart_id: f.cart_id,
    item_ref,
    quantity,
    idempotency_key: key,
  });
  if (r.kind !== 'ok') throw new Error(`add ${key} refused: ${r.reason}`);
  return { line_id: r.line_id, version: r.version };
}

describe('cart.undoLast — exact inverses (RT-245)', () => {
  it('new-line add → Undo soft-removes the SAME row, version +1, subtotal corrected, linked outbox row, zero audit events', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1', 'SKU-A', 2);
    const auditBefore = auditCount(f.db);

    const r = await f.handlers.undoLast({
      cart_id: f.cart_id,
      target_action_id: 'a-1',
      idempotency_key: 'u-1',
    });

    expect(r).toEqual({ kind: 'ok', effect: 'removed', line_id: a.line_id, version: 2 });
    const line = lineRow(f.db, a.line_id);
    expect(line['removed_at']).not.toBeNull();
    expect(line['version']).toBe(2);
    expect(line['last_action_id']).toBe('u-1');
    expect(line['quantity']).toBe(2); // the row is preserved, not rewritten
    const cart = cartRow(f.db, f.cart_id);
    expect(cart['cart_subtotal_minor']).toBe(0);
    expect(cart['last_action_id']).toBe('u-1');
    // No new `editing → empty` transition: the cart stays `editing`.
    expect(cart['state']).toBe('editing');

    const row = outbox(f.db, 'u-1');
    expect(row['action_kind']).toBe('cart.line.remove');
    expect(row['line_id']).toBe(a.line_id);
    expect(row['cart_id']).toBe(f.cart_id);
    expect(JSON.parse(row['payload_json'] as string)).toMatchObject({
      undo_of_action_id: 'a-1',
      effect: 'removed',
    });
    expect(auditCount(f.db)).toBe(auditBefore);
    expect(auditCount(f.db)).toBe(0);
  });

  it('merge add → Undo decrements exactly the persisted quantity_added (direct add +1 → −1 only)', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1', 'SKU-A', 2);
    await add(f, 'm-1', 'SKU-A', 1); // Q4 merge → quantity 3
    expect(lineRow(f.db, a.line_id)['quantity']).toBe(3);

    const r = await f.handlers.undoLast({
      cart_id: f.cart_id,
      target_action_id: 'm-1',
      idempotency_key: 'u-1',
    });

    expect(r).toEqual({ kind: 'ok', effect: 'decremented', line_id: a.line_id, version: 3 });
    const line = lineRow(f.db, a.line_id);
    expect(line['quantity']).toBe(2);
    expect(line['line_subtotal_minor']).toBe(200);
    expect(line['removed_at']).toBeNull();
    expect(line['unit_price_minor']).toBe(100); // no price re-resolution
    expect(cartRow(f.db, f.cart_id)['cart_subtotal_minor']).toBe(200);
    const row = outbox(f.db, 'u-1');
    expect(row['action_kind']).toBe('cart.line.update');
    expect(JSON.parse(row['payload_json'] as string)).toMatchObject({
      op: 'decrement',
      delta: 1,
      new_quantity: 2,
      undo_of_action_id: 'm-1',
      effect: 'decremented',
    });
    expect(auditCount(f.db)).toBe(0);
  });

  it('merge of a larger quantity → Undo subtracts exactly that quantity', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1', 'SKU-B', 1);
    await add(f, 'm-1', 'SKU-B', 3); // → 4
    const r = await f.handlers.undoLast({
      cart_id: f.cart_id,
      target_action_id: 'm-1',
      idempotency_key: 'u-1',
    });
    expect(r).toMatchObject({ kind: 'ok', effect: 'decremented', line_id: a.line_id });
    expect(lineRow(f.db, a.line_id)['quantity']).toBe(1);
    expect(cartRow(f.db, f.cart_id)['cart_subtotal_minor']).toBe(250);
  });

  it('delete → Undo restores the SAME line id with price, name, note and discount placeholder intact', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1', 'SKU-B', 2);
    await add(f, 'b-1', 'SKU-A', 1);
    const noted = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: a.line_id,
      note: 'after meals',
      version: 1,
      idempotency_key: 'n-1',
    });
    expect(noted.kind).toBe('ok');
    const dp = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: a.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'd-1',
    });
    expect(dp.kind).toBe('ok');
    const before = lineRow(f.db, a.line_id);
    const removed = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: a.line_id,
      version: 2,
      idempotency_key: 'r-1',
    });
    expect(removed.kind).toBe('ok');
    expect(cartRow(f.db, f.cart_id)['cart_subtotal_minor']).toBe(100);

    const r = await f.handlers.undoLast({
      cart_id: f.cart_id,
      target_action_id: 'r-1',
      idempotency_key: 'u-1',
    });

    expect(r).toEqual({ kind: 'ok', effect: 'restored', line_id: a.line_id, version: 4 });
    const line = lineRow(f.db, a.line_id);
    expect(line['removed_at']).toBeNull();
    for (const k of [
      'line_id',
      'item_ref',
      'display_name',
      'quantity',
      'unit_price_minor',
      'line_subtotal_minor',
      'note',
      'created_at',
    ]) {
      expect(line[k]).toEqual(before[k]);
    }
    expect(line['version']).toBe(4);
    expect(
      scalar(f.db, `SELECT COUNT(*) FROM cart_line_discount_placeholders WHERE line_id = ?`, [
        a.line_id,
      ]),
    ).toBe(1);
    // Only one row for this item: restored in place, never re-inserted.
    expect(scalar(f.db, `SELECT COUNT(*) FROM cart_lines WHERE item_ref = 'SKU-B'`)).toBe(1);
    expect(cartRow(f.db, f.cart_id)['cart_subtotal_minor']).toBe(600);
    const row = outbox(f.db, 'u-1');
    expect(row['action_kind']).toBe('cart.line.restore');
    expect(JSON.parse(row['payload_json'] as string)).toMatchObject({
      undo_of_action_id: 'r-1',
      effect: 'restored',
    });
    expect(auditCount(f.db)).toBe(0);
  });

  it('restoring the only line keeps the cart `editing` and recomputes the subtotal', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1', 'SKU-A', 1);
    await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: a.line_id,
      version: 1,
      idempotency_key: 'r-1',
    });
    expect(cartRow(f.db, f.cart_id)['cart_subtotal_minor']).toBe(0);
    const r = await f.handlers.undoLast({
      cart_id: f.cart_id,
      target_action_id: 'r-1',
      idempotency_key: 'u-1',
    });
    expect(r).toMatchObject({ kind: 'ok', effect: 'restored' });
    expect(cartRow(f.db, f.cart_id)).toMatchObject({ state: 'editing', cart_subtotal_minor: 100 });
  });
});

describe('cart.undoLast — idempotency', () => {
  it('replaying the same Undo applies ONE inverse and returns the same successful response', async () => {
    const f = await fixture();
    await add(f, 'a-1', 'SKU-A', 2);
    await add(f, 'm-1', 'SKU-A', 1);
    const req = { cart_id: f.cart_id, target_action_id: 'm-1', idempotency_key: 'u-1' };
    const first = await f.handlers.undoLast(req);
    const digest = stateDigest(f.db);
    const second = await f.handlers.undoLast(req);
    expect(second).toEqual(first);
    expect(stateDigest(f.db)).toEqual(digest);
  });

  it('a lost response replays the ORIGINAL effect/version even after later mutations', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1', 'SKU-A', 2);
    await add(f, 'm-1', 'SKU-A', 1);
    const req = { cart_id: f.cart_id, target_action_id: 'm-1', idempotency_key: 'u-1' };
    const first = await f.handlers.undoLast(req);
    expect(first).toMatchObject({ kind: 'ok', version: 3 });
    await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: a.line_id,
      op: 'increment',
      version: 3,
      idempotency_key: 'i-1',
    });
    expect(await f.handlers.undoLast(req)).toEqual(first);
  });

  it('same Undo key with a different target → idempotency_payload_mismatch, no writes', async () => {
    const f = await fixture();
    await add(f, 'a-1');
    await add(f, 'b-1', 'SKU-B');
    expect(
      await f.handlers.undoLast({
        cart_id: f.cart_id,
        target_action_id: 'b-1',
        idempotency_key: 'u-1',
      }),
    ).toMatchObject({ kind: 'ok' });
    const digest = stateDigest(f.db);
    expect(
      await f.handlers.undoLast({
        cart_id: f.cart_id,
        target_action_id: 'a-1',
        idempotency_key: 'u-1',
      }),
    ).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    expect(stateDigest(f.db)).toEqual(digest);
  });

  it('reusing the target key (or any non-Undo action key) as the Undo key → mismatch, no writes', async () => {
    const f = await fixture();
    await add(f, 'a-1');
    const digest = stateDigest(f.db);
    expect(
      await f.handlers.undoLast({
        cart_id: f.cart_id,
        target_action_id: 'a-1',
        idempotency_key: 'a-1',
      }),
    ).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    expect(
      await f.handlers.undoLast({
        cart_id: f.cart_id,
        target_action_id: 'a-1',
        idempotency_key: 'c-1',
      }),
    ).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    expect(stateDigest(f.db)).toEqual(digest);
  });
});

describe('cart.undoLast — eligibility refusals leave no writes', () => {
  async function expectUnavailable(f: Fixture, target: string): Promise<void> {
    const digest = stateDigest(f.db);
    const r = await f.handlers.undoLast({
      cart_id: f.cart_id,
      target_action_id: target,
      idempotency_key: 'u-x',
    });
    expect(r).toEqual({ kind: 'refused', reason: 'undo_not_available' });
    expect(stateDigest(f.db)).toEqual(digest);
  }

  it('an older target after another add', async () => {
    const f = await fixture();
    await add(f, 'a-1');
    await add(f, 'b-1', 'SKU-B');
    await expectUnavailable(f, 'a-1');
  });

  it('a later note edit on ANOTHER line (does not move carts.last_action_id) still invalidates', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1');
    await add(f, 'b-1', 'SKU-B');
    await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: a.line_id,
      note: 'x',
      version: 1,
      idempotency_key: 'n-1',
    });
    expect(cartRow(f.db, f.cart_id)['last_action_id']).toBe('b-1');
    await expectUnavailable(f, 'b-1');
  });

  it('a later discount placeholder on the SAME line invalidates (never removes a line with a fresh discount)', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1');
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: a.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'd-1',
    });
    await expectUnavailable(f, 'a-1');
  });

  it('a later quantity edit invalidates', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1');
    await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: a.line_id,
      op: 'increment',
      version: 1,
      idempotency_key: 'i-1',
    });
    await expectUnavailable(f, 'a-1');
  });

  it('an unknown target, a target from another cart, and an unsupported kind (cart.create)', async () => {
    const f = await fixture();
    await expectUnavailable(f, 'c-1'); // cart.create is the last action but not undoable
    await expectUnavailable(f, 'never-happened');
    const other = await f.handlers.create({ idempotency_key: 'c-2' });
    if (other.kind !== 'ok') throw new Error('create');
    await f.handlers.linesAdd({
      cart_id: other.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'x-1',
    });
    await add(f, 'a-1');
    await expectUnavailable(f, 'x-1');
  });

  it('an Undo is never itself undoable (no redo through the back door)', async () => {
    const f = await fixture();
    await add(f, 'a-1');
    await f.handlers.undoLast({
      cart_id: f.cart_id,
      target_action_id: 'a-1',
      idempotency_key: 'u-1',
    });
    await expectUnavailable(f, 'u-1');
  });

  it('line state that no longer matches the target action (tampered removed_at)', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1');
    f.db.run(`UPDATE cart_lines SET removed_at = '2026-10-10T10:00:00.000Z' WHERE line_id = ?`, [
      a.line_id,
    ]);
    await expectUnavailable(f, 'a-1');
  });

  it('a merge whose decrement would empty the line', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1', 'SKU-A', 1);
    await add(f, 'm-1', 'SKU-A', 1);
    f.db.run(`UPDATE cart_lines SET quantity = 1 WHERE line_id = ?`, [a.line_id]);
    await expectUnavailable(f, 'm-1');
  });

  it('restoring a delete while another ACTIVE line holds the same item_ref', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1', 'SKU-A');
    await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: a.line_id,
      version: 1,
      idempotency_key: 'r-1',
    });
    // Simulate a twin active line slipping in without moving lineage.
    f.db.run(
      `INSERT INTO cart_lines (line_id, cart_id, item_ref, display_name, quantity, unit_price_minor,
         line_subtotal_minor, note, version, last_action_id, created_at, updated_at)
       VALUES ('twin', ?, 'SKU-A', 'Panadol', 1, 100, 100, NULL, 1, 'zz', 't', 't')`,
      [f.cart_id],
    );
    await expectUnavailable(f, 'r-1');
  });
});

describe('cart.undoLast — cart lifecycle and authority', () => {
  it('handed-off (frozen) cart → refused, no line/outbox mutation', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1');
    const h = await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'h-1',
    });
    expect(h.kind).toBe('ok');
    const digest = stateDigest(f.db);
    const auditBefore = auditCount(f.db);
    expect(
      await f.handlers.undoLast({
        cart_id: f.cart_id,
        target_action_id: 'a-1',
        idempotency_key: 'u-1',
      }),
    ).toEqual({ kind: 'refused', reason: 'frozen' });
    expect(
      await f.handlers.undoLast({
        cart_id: f.cart_id,
        target_action_id: 'h-1',
        idempotency_key: 'u-2',
      }),
    ).toEqual({ kind: 'refused', reason: 'frozen' });
    expect(stateDigest(f.db)).toEqual(digest);
    expect(auditCount(f.db)).toBe(auditBefore);
  });

  it('cancelled (voided) cart → refused `closed`, no writes', async () => {
    const f = await fixture();
    await add(f, 'a-1');
    expect((await f.handlers.void({ cart_id: f.cart_id, idempotency_key: 'v-1' })).kind).toBe('ok');
    const digest = stateDigest(f.db);
    expect(
      await f.handlers.undoLast({
        cart_id: f.cart_id,
        target_action_id: 'a-1',
        idempotency_key: 'u-1',
      }),
    ).toEqual({ kind: 'refused', reason: 'closed' });
    expect(stateDigest(f.db)).toEqual(digest);
  });

  it('authorization runs BEFORE replay: another cashier cannot read or replay an Undo', async () => {
    const f = await fixture();
    await add(f, 'a-1');
    const req = { cart_id: f.cart_id, target_action_id: 'a-1', idempotency_key: 'u-1' };
    expect((await f.handlers.undoLast(req)).kind).toBe('ok');
    const intruder = f.make({ session: session({ id: 'sess-other', operator_id: 'cashier-2' }) });
    expect(await intruder.undoLast(req)).toEqual({ kind: 'refused', reason: 'wrong_owner' });
    const noSession = f.make({ session: null });
    expect(await noSession.undoLast(req)).toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it('a latched session may not restore the only line of an emptied cart (it is a safe point)', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1');
    await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: a.line_id,
      version: 1,
      idempotency_key: 'r-1',
    });
    const latched = f.make({ session: session({ authority_latch: 'superseded_by_takeover' }) });
    const digest = stateDigest(f.db);
    expect(
      await latched.undoLast({
        cart_id: f.cart_id,
        target_action_id: 'r-1',
        idempotency_key: 'u-1',
      }),
    ).toEqual({ kind: 'refused', reason: 'authority_conflict' });
    expect(stateDigest(f.db)).toEqual(digest);
  });

  it('a latched session may still undo within the current non-empty sale', async () => {
    const f = await fixture();
    await add(f, 'a-1');
    await add(f, 'b-1', 'SKU-B');
    const latched = f.make({ session: session({ authority_latch: 'superseded_by_takeover' }) });
    expect(
      await latched.undoLast({
        cart_id: f.cart_id,
        target_action_id: 'b-1',
        idempotency_key: 'u-1',
      }),
    ).toMatchObject({ kind: 'ok', effect: 'removed' });
  });

  it('without a cart store the handler refuses generically', async () => {
    const h = new CartBridgeHandlers({
      getCurrentSession: () => session(),
      getTerminalId: () => 't',
    });
    expect(
      await h.undoLast({ cart_id: 'x', target_action_id: 'a', idempotency_key: 'u' }),
    ).toMatchObject({ kind: 'refused' });
  });
});

describe('cart.undoLast — race, restart', () => {
  it('a mutation that lands between the eligibility read and the conditional write → refused, no partial outbox row', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1');
    await add(f, 'b-1', 'SKU-B');
    // A store whose Undo write is preceded by a concurrent note edit on line A
    // (a mutation that does not move carts.last_action_id).
    const racing: CartStore = {
      ...f.store,
      undoLastActionAndOutbox(input, row) {
        f.store.setLineNoteAndOutbox(
          { line_id: a.line_id, note: 'race', last_action_id: 'n-race', updated_at: 't' },
          {
            action_id: 'n-race',
            cart_id: f.cart_id,
            line_id: a.line_id,
            action_kind: 'cart.line.note_set',
            acting_operator_id: 'cashier-1',
            attribution_operator_id: null,
            operator_session_id: 'sess-undo',
            payload_json: '{"note_length":4}',
            applied_at: 't',
          },
        );
        return f.store.undoLastActionAndOutbox(input, row);
      },
    };
    const h = f.make({ store: racing });
    const r = await h.undoLast({
      cart_id: f.cart_id,
      target_action_id: 'b-1',
      idempotency_key: 'u-1',
    });
    expect(r).toEqual({ kind: 'refused', reason: 'undo_not_available' });
    expect(scalar(f.db, `SELECT COUNT(*) FROM cart_action_outbox WHERE action_id = 'u-1'`)).toBe(0);
    expect(cartRow(f.db, f.cart_id)['last_action_id']).toBe('b-1');
  });

  it('store: stale preconditions write nothing (line version moved underneath)', async () => {
    const f = await fixture();
    const a = await add(f, 'a-1');
    const before = outboxCount(f.db);
    const applied = f.store.undoLastActionAndOutbox(
      {
        cart_id: f.cart_id,
        line_id: a.line_id,
        target_action_id: 'a-1',
        expected_line_version: 7,
        inverse: { kind: 'soft_remove' },
        now: '2026-10-10T10:00:00.000Z',
      },
      {
        action_id: 'u-1',
        cart_id: f.cart_id,
        line_id: a.line_id,
        action_kind: 'cart.line.remove',
        acting_operator_id: 'cashier-1',
        attribution_operator_id: null,
        operator_session_id: 'sess-undo',
        payload_json: '{}',
        applied_at: '2026-10-10T10:00:00.000Z',
      },
    );
    expect(applied).toBe(false);
    expect(outboxCount(f.db)).toBe(before);
    expect(lineRow(f.db, a.line_id)['removed_at']).toBeNull();
  });

  it('restart: eligibility is lineage-based (no in-memory state), and the snapshot exposes no action ids', async () => {
    const f = await fixture();
    await add(f, 'a-1');
    const snap = await f.handlers.snapshot({ cart_id: f.cart_id });
    expect(JSON.stringify(snap)).not.toContain('a-1');
    // A fresh handlers instance over the same DB (main restarted).
    const restarted = f.make();
    expect(
      await restarted.undoLast({
        cart_id: f.cart_id,
        target_action_id: 'a-1',
        idempotency_key: 'u-1',
      }),
    ).toMatchObject({ kind: 'ok', effect: 'removed' });
  });
});
