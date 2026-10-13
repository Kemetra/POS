/**
 * RT-440 (PK-2, spec 024 §3.1 / §3.2 / K2 / K5 / K6 / R-7) — `cart.park` and
 * `cart.listParked` over every migration: who may park what, the per-terminal
 * limit, durable idempotency, the `cart_parked` refusal on every other cart
 * mutation, and the label never leaving the `carts` row.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AMOX,
  IBUP,
  PARA,
  T0,
  categories,
  createParkWorld,
  insertAttempt,
  initParkSql,
  openSale,
  parkCart,
  row,
  rows,
  sessionOf,
  type ParkWorld,
} from './__helpers__/park-world.js';

let w: ParkWorld;

beforeAll(async () => {
  await initParkSql();
});

beforeEach(() => {
  w = createParkWorld();
  w.session = sessionOf('cashier-1');
});

const parkedAt = (cart_id: string): string | null =>
  row<{ parked_at: string | null }>(w, `SELECT parked_at FROM carts WHERE cart_id = ?`, [cart_id])
    ?.parked_at ?? null;

const refusals = (): unknown[] =>
  w.audit.filter((e) => e.action_category === 'cart.park_refused').map((e) => e.payload);

describe('cart.park — a parkable sale', () => {
  it('parks an editing sale with lines and audits ids and counts only', async () => {
    const cart = await openSale(w, [PARA, [IBUP, 2]]);
    const res = w.parks.park({ cart_id: cart, label: '  Ahmed red bag ', idempotency_key: 'k-1' });

    expect(res).toEqual({ kind: 'parked' });
    expect(parkedAt(cart)).toBe(T0);
    expect(
      row(w, `SELECT park_label, last_action_id FROM carts WHERE cart_id = ?`, [cart]),
    ).toEqual({
      park_label: 'Ahmed red bag',
      last_action_id: 'k-1',
    });
    const parked = w.audit.find((e) => e.action_category === 'cart.parked');
    expect(parked?.payload).toEqual({
      cart_id: cart,
      line_count: 2,
      total_minor: 550,
      has_label: true,
    });
    expect(parked).toMatchObject({
      originating_terminal_id: 'term-1',
      acting_operator_id: 'cashier-1',
    });
  });

  it('records the key durably, with no outbox row and no new cart state', async () => {
    const cart = await openSale(w, [PARA]);
    parkCart(w, cart);
    expect(rows(w, `SELECT action_kind, cart_id FROM cart_park_actions`)).toEqual([
      { action_kind: 'cart.park', cart_id: cart },
    ]);
    expect(row(w, `SELECT state FROM carts WHERE cart_id = ?`, [cart])).toEqual({
      state: 'editing',
    });
    expect(
      rows(w, `SELECT action_kind FROM cart_action_outbox WHERE action_kind LIKE '%park%'`),
    ).toEqual([]);
  });

  it('parks without a label', async () => {
    const cart = await openSale(w, [PARA]);
    parkCart(w, cart);
    expect(w.audit.find((e) => e.action_category === 'cart.parked')?.payload).toMatchObject({
      has_label: false,
    });
  });
});

describe('cart.park — refusals (each audited with its closed reason)', () => {
  it.each([
    ['empty', 'empty'],
    ['discount_pending_attribution', 'discount_pending_attribution'],
    ['handing_off', 'handing_off'],
    ['frozen_handed_off', 'frozen_handed_off'],
  ])('refuses a %s cart: not_parkable', async (_name, state) => {
    const cart = await openSale(w, [PARA]);
    w.raw.run(`UPDATE carts SET state = ? WHERE cart_id = ?`, [state, cart]);
    expect(w.parks.park({ cart_id: cart, idempotency_key: 'k' })).toEqual({
      kind: 'refused',
      reason: 'not_parkable',
    });
    expect(refusals()).toEqual([{ reason: 'not_parkable' }]);
  });

  it('refuses an editing cart with no active line', async () => {
    const cart = await openSale(w, [PARA]);
    w.raw.run(`UPDATE cart_lines SET removed_at = ? WHERE cart_id = ?`, [T0, cart]);
    expect(w.parks.park({ cart_id: cart, idempotency_key: 'k' })).toMatchObject({
      reason: 'not_parkable',
    });
  });

  it('refuses a sale with a started payment attempt (money on it)', async () => {
    const cart = await openSale(w, [PARA]);
    insertAttempt(w, { cart_id: cart, state: 'started' });
    expect(w.parks.park({ cart_id: cart, idempotency_key: 'k' })).toMatchObject({
      reason: 'not_parkable',
    });
  });

  it('refuses a cart that is already parked (a new key)', async () => {
    const cart = await openSale(w, [PARA]);
    parkCart(w, cart);
    expect(w.parks.park({ cart_id: cart, idempotency_key: 'k-new' })).toMatchObject({
      reason: 'not_parkable',
    });
  });

  it('refuses another session’s cart, and an unknown one: wrong_owner', async () => {
    const cart = await openSale(w, [PARA]);
    w.session = sessionOf('cashier-1'); // same operator, a new session (M4)
    expect(w.parks.park({ cart_id: cart, idempotency_key: 'k-1' })).toMatchObject({
      reason: 'wrong_owner',
    });
    w.session = sessionOf('manager-1', { role: 'manager' });
    expect(w.parks.park({ cart_id: cart, idempotency_key: 'k-2' })).toMatchObject({
      reason: 'wrong_owner',
    });
    expect(w.parks.park({ cart_id: 'no-such-cart', idempotency_key: 'k-3' })).toMatchObject({
      reason: 'wrong_owner',
    });
    expect(refusals()).toHaveLength(3);
  });

  it.each([
    ['empty after trimming', '   '],
    ['over 40 characters', 'x'.repeat(41)],
    ['a line break', 'two\nlines'],
    ['a control character', 'bell\u0007'],
  ])('refuses a label that is %s: invalid_label', async (_name, label) => {
    const cart = await openSale(w, [PARA]);
    expect(w.parks.park({ cart_id: cart, label, idempotency_key: 'k' })).toMatchObject({
      reason: 'invalid_label',
    });
    expect(parkedAt(cart)).toBeNull();
    expect(refusals()).toEqual([{ reason: 'invalid_label' }]);
  });

  it('accepts a 40-character Arabic label', async () => {
    const cart = await openSale(w, [PARA]);
    expect(w.parks.park({ cart_id: cart, label: 'ب'.repeat(40), idempotency_key: 'k' })).toEqual({
      kind: 'parked',
    });
  });

  it('refuses with no session, a locked session or an unpaired terminal, unaudited', async () => {
    const cart = await openSale(w, [PARA]);
    const owner = w.session;
    w.session = null;
    expect(w.parks.park({ cart_id: cart, idempotency_key: 'k' })).toMatchObject({
      reason: 'no_session',
    });
    w.session = owner === null ? null : { ...owner, lock_state: 'locked' };
    expect(w.parks.park({ cart_id: cart, idempotency_key: 'k' })).toMatchObject({
      reason: 'session_locked',
    });
    w.session = owner;
    w.terminal = null;
    expect(w.parks.park({ cart_id: cart, idempotency_key: 'k' })).toMatchObject({
      reason: 'no_session',
    });
    expect(refusals()).toEqual([]);
  });
});

describe('cart.park — at most 5 parked sales per terminal, across operators (K2)', () => {
  it('refuses the 6th park_limit_reached, counting other operators and stale sales', async () => {
    for (const op of ['cashier-1', 'cashier-1', 'cashier-2', 'cashier-2', 'cashier-3']) {
      w.session = sessionOf(op);
      parkCart(w, await openSale(w, [PARA]));
    }
    w.raw.run(`UPDATE carts SET parked_at = '2026-10-01T00:00:00.000Z'`); // all stale
    w.session = sessionOf('cashier-4');
    const sixth = await openSale(w, [PARA]);
    expect(w.parks.park({ cart_id: sixth, idempotency_key: 'k-6' })).toEqual({
      kind: 'refused',
      reason: 'park_limit_reached',
    });
    expect(refusals()).toEqual([{ reason: 'park_limit_reached' }]);
  });

  it('counts only this terminal', async () => {
    for (let i = 0; i < 5; i += 1) parkCart(w, await openSale(w, [PARA]));
    w.raw.run(`UPDATE carts SET terminal_id = 'term-other'`);
    expect(w.parks.park({ cart_id: await openSale(w, [PARA]), idempotency_key: 'k' })).toEqual({
      kind: 'parked',
    });
  });
});

describe('cart.park — durable idempotency (R-7)', () => {
  it('replays the recorded outcome and writes nothing more', async () => {
    const cart = await openSale(w, [PARA]);
    const req = { cart_id: cart, label: 'bag', idempotency_key: 'k-1' };
    expect(w.parks.park(req)).toEqual({ kind: 'parked' });
    const before = w.audit.length;
    expect(w.parks.park(req)).toEqual({ kind: 'parked' });
    expect(w.audit).toHaveLength(before);
    expect(rows(w, `SELECT 1 FROM cart_park_actions`)).toHaveLength(1);
  });

  it('a delayed retry after resume and later edits replays and does NOT park again', async () => {
    const cart = await openSale(w, [PARA]);
    const req = { cart_id: cart, idempotency_key: 'k-park' };
    w.parks.park(req);
    const preview = w.parks.previewResume({ cart_id: cart });
    if (preview.kind !== 'preview') throw new Error('preview refused');
    w.parks.resume({
      cart_id: cart,
      accept_changes: false,
      diff_token: preview.diff_token,
      current_cart: 'keep',
      idempotency_key: 'k-resume',
    });
    await w.cart.linesAdd({ cart_id: cart, item_ref: IBUP, quantity: 1, idempotency_key: 'k-add' });

    expect(w.parks.park(req)).toEqual({ kind: 'parked' });
    expect(parkedAt(cart)).toBeNull();
  });

  it('refuses the same key with a different label, or a key the cart bridge used', async () => {
    const cart = await openSale(w, [PARA]);
    w.parks.park({ cart_id: cart, label: 'one', idempotency_key: 'k-1' });
    expect(w.parks.park({ cart_id: cart, label: 'two', idempotency_key: 'k-1' })).toMatchObject({
      reason: 'idempotency_payload_mismatch',
    });
    const other = await openSale(w, [AMOX]);
    const addKey = row<{ action_id: string }>(
      w,
      `SELECT action_id FROM cart_action_outbox WHERE cart_id = ? AND action_kind = 'cart.line.add'`,
      [other],
    )?.action_id;
    expect(w.parks.park({ cart_id: other, idempotency_key: addKey ?? '' })).toMatchObject({
      reason: 'idempotency_payload_mismatch',
    });
  });

  it('never replays another operator’s recorded park', async () => {
    const cart = await openSale(w, [PARA]);
    w.parks.park({ cart_id: cart, idempotency_key: 'k-1' });
    w.session = sessionOf('cashier-2');
    expect(w.parks.park({ cart_id: cart, idempotency_key: 'k-1' })).toMatchObject({
      reason: 'wrong_owner',
    });
  });
});

describe('a parked cart changes only through cart.resume (K5: cart_parked)', () => {
  let cart: string;
  let line: { line_id: string; version: number };

  beforeEach(async () => {
    cart = await openSale(w, [PARA]);
    line = row<{ line_id: string; version: number }>(
      w,
      `SELECT line_id, version FROM cart_lines WHERE cart_id = ?`,
      [cart],
    ) ?? { line_id: '', version: 0 };
    parkCart(w, cart);
  });

  it('refuses every line, note, discount, void, handoff and undo call', async () => {
    const id = (): string => crypto.randomUUID();
    const base = { cart_id: cart, idempotency_key: id() };
    const answers = await Promise.all([
      w.cart.linesAdd({ ...base, item_ref: IBUP, quantity: 1 }),
      w.cart.linesUpdate({ ...line, cart_id: cart, op: 'increment', idempotency_key: id() }),
      w.cart.linesRemove({ ...line, cart_id: cart, idempotency_key: id() }),
      w.cart.linesSetNote({ ...line, cart_id: cart, note: 'n', idempotency_key: id() }),
      w.cart.discountPlaceholdersAdd({
        cart_id: cart,
        line_id: line.line_id,
        placeholder_kind: 'percent_5',
        idempotency_key: id(),
      }),
      w.cart.discountPlaceholdersRemove({
        cart_id: cart,
        placeholder_id: 'p',
        idempotency_key: id(),
      }),
      w.cart.void({ cart_id: cart, idempotency_key: id() }),
      w.cart.handoff({ cart_id: cart, per_line_versions: [line], idempotency_key: id() }),
      w.cart.undoLast({ cart_id: cart, target_action_id: 'x', idempotency_key: id() }),
    ]);
    for (const answer of answers)
      expect(answer).toEqual({ kind: 'refused', reason: 'cart_parked' });
    expect(
      row(w, `SELECT state, cart_subtotal_minor FROM carts WHERE cart_id = ?`, [cart]),
    ).toEqual({
      state: 'editing',
      cart_subtotal_minor: 150,
    });
  });

  it('refuses an add whose cart was parked while the item lookup awaited (RT-347 twin)', async () => {
    const other = await openSale(w, [PARA]);
    const racing = w.cartWith(() => {
      parkCart(w, other);
      return Promise.resolve({ kind: 'ok', display_name: 'x', unit_price_minor: 100 });
    });
    const res = await racing.linesAdd({
      cart_id: other,
      item_ref: AMOX,
      quantity: 1,
      idempotency_key: 'k-race',
    });
    expect(res.kind).toBe('refused');
    expect(
      rows(w, `SELECT 1 FROM cart_lines WHERE cart_id = ? AND item_ref = ?`, [other, AMOX]),
    ).toEqual([]);
  });
});

describe('cart.listParked (§3.2)', () => {
  it('lists the operator’s own parked sales, newest first, with no line items', async () => {
    const a = await openSale(w, [PARA]);
    parkCart(w, a, 'first');
    w.now = new Date('2026-10-13T09:05:00.000Z');
    const b = await openSale(w, [IBUP, AMOX]);
    parkCart(w, b);
    w.session = sessionOf('cashier-2');
    parkCart(w, await openSale(w, [PARA]));
    w.session = sessionOf('cashier-1'); // the owner again, in a new session

    expect(w.parks.listParked()).toEqual({
      kind: 'parked_sales',
      items: [
        {
          cart_id: b,
          label: null,
          line_count: 2,
          total_minor: 650,
          parked_at: '2026-10-13T09:05:00.000Z',
          stale: false,
        },
        {
          cart_id: a,
          label: 'first',
          line_count: 1,
          total_minor: 150,
          parked_at: T0,
          stale: false,
        },
      ],
    });
  });

  it('marks a sale stale after 12 h, or from an earlier Cairo business day', async () => {
    const cart = await openSale(w, [PARA]);
    parkCart(w, cart);
    w.now = new Date('2026-10-13T20:59:00.000Z'); // 23:59 Cairo, same day, < 12 h
    const sameDay = w.parks.listParked();
    w.now = new Date('2026-10-13T21:01:00.000Z'); // 00:01 Cairo, next day
    const nextDay = w.parks.listParked();
    expect(sameDay.kind === 'parked_sales' && sameDay.items[0]?.stale).toBe(false);
    expect(nextDay.kind === 'parked_sales' && nextDay.items[0]?.stale).toBe(true);
  });

  it('is empty for a manager, and refuses with no session', async () => {
    parkCart(w, await openSale(w, [PARA]));
    w.session = sessionOf('manager-1', { role: 'manager' });
    expect(w.parks.listParked()).toEqual({ kind: 'parked_sales', items: [] });
    w.session = null;
    expect(w.parks.listParked()).toEqual({ kind: 'refused', reason: 'no_session' });
  });
});

describe('the park label never leaves the carts row (spec 024 §7)', () => {
  it('is absent from audit_events-bound payloads, logs and every outbox payload', async () => {
    const SENTINEL = 'LABEL-SENTINEL-7Q';
    const cart = await openSale(w, [PARA, IBUP]);
    parkCart(w, cart, SENTINEL);
    w.parks.listParked();
    w.catalogue.set(PARA, { kind: 'price', unit_price_minor: 175 });
    const preview = w.parks.previewResume({ cart_id: cart });
    if (preview.kind !== 'preview') throw new Error('preview refused');
    w.parks.resume({
      cart_id: cart,
      accept_changes: true,
      diff_token: preview.diff_token,
      current_cart: 'keep',
      idempotency_key: 'k-resume',
    });

    expect(categories(w)).toEqual(expect.arrayContaining(['cart.parked', 'cart.resumed']));
    expect(JSON.stringify(w.audit)).not.toContain(SENTINEL);
    expect(w.logs.join('\n')).not.toContain(SENTINEL);
    const payloads = rows<{ payload_json: string }>(
      w,
      `SELECT payload_json FROM cart_action_outbox`,
    );
    expect(payloads.map((p) => p.payload_json).join('\n')).not.toContain(SENTINEL);
    const recorded = rows<{ outcome_json: string; request_hash: string }>(
      w,
      `SELECT outcome_json, request_hash FROM cart_park_actions`,
    );
    expect(JSON.stringify(recorded)).not.toContain(SENTINEL);
  });
});
