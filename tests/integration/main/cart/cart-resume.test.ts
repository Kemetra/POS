/**
 * RT-440 (PK-2, spec 024 §3.3 / §3.4 / K3 / K4 / R-1 / R-3 / R-6 / R-7) —
 * `cart.previewResume` and `cart.resume` over every migration.
 */
import { createHash } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AMOX,
  IBUP,
  PARA,
  T0,
  createParkWorld,
  initParkSql,
  insertAttempt,
  openSale,
  parkCart,
  row,
  rows,
  sessionOf,
  type ParkWorld,
} from './__helpers__/park-world.js';
import type { CartResumeRequest } from '../../../../src/shared/cart/park-types.js';
import { seedManagerAuthorizedDiscount } from '../../../unit/main/cart/__helpers__/manager-authorized-discount.js';

let w: ParkWorld;

beforeAll(async () => {
  await initParkSql();
});

beforeEach(() => {
  w = createParkWorld();
  w.session = sessionOf('cashier-1');
});

function token(cart_id: string): string {
  const preview = w.parks.previewResume({ cart_id });
  if (preview.kind !== 'preview') throw new Error(`preview refused: ${preview.reason}`);
  return preview.diff_token;
}

function resumeReq(cart_id: string, over: Partial<CartResumeRequest> = {}): CartResumeRequest {
  return {
    cart_id,
    accept_changes: false,
    diff_token: token(cart_id),
    current_cart: 'keep',
    idempotency_key: crypto.randomUUID(),
    ...over,
  };
}

const cartOf = (cart_id: string) =>
  row<{
    state: string;
    parked_at: string | null;
    park_label: string | null;
    operator_session_id: string;
    cart_subtotal_minor: number;
    last_action_id: string;
    cancellation_reason: string | null;
  }>(
    w,
    `SELECT state, parked_at, park_label, operator_session_id, cart_subtotal_minor,
            last_action_id, cancellation_reason FROM carts WHERE cart_id = ?`,
    [cart_id],
  );

const linesOf = (cart_id: string) =>
  rows<{
    item_ref: string;
    unit_price_minor: number;
    line_subtotal_minor: number;
    removed: number;
  }>(
    w,
    `SELECT item_ref, unit_price_minor, line_subtotal_minor, removed_at IS NOT NULL AS removed
       FROM cart_lines WHERE cart_id = ? ORDER BY item_ref`,
    [cart_id],
  );

async function parkedSale(items: Parameters<typeof openSale>[1], label?: string): Promise<string> {
  const cart = await openSale(w, items);
  parkCart(w, cart, label);
  return cart;
}

describe('cart.resume — the simple case', () => {
  it('resumes into a new session after sign-out, re-binding the cart and auditing it', async () => {
    const cart = await parkedSale([PARA], 'bag');
    w.session = sessionOf('cashier-1'); // signed out and back in
    w.now = new Date('2026-10-13T09:30:00.000Z');
    const req = resumeReq(cart);

    expect(w.parks.resume(req)).toEqual({ kind: 'resumed', cart_id: cart });
    expect(cartOf(cart)).toMatchObject({
      state: 'editing',
      parked_at: null,
      park_label: null,
      operator_session_id: w.session.id,
      last_action_id: req.idempotency_key,
    });
    expect(w.audit.find((e) => e.action_category === 'cart.resumed')?.payload).toEqual({
      cart_id: cart,
      parked_for_ms: 30 * 60 * 1000,
      price_changes_accepted: 0,
      removed_unavailable: 0,
      current_cart: 'none',
    });
  });

  it('then lets the cashier edit and hand off as usual', async () => {
    const cart = await parkedSale([PARA]);
    w.parks.resume(resumeReq(cart));
    const added = await w.cart.linesAdd({
      cart_id: cart,
      item_ref: IBUP,
      quantity: 1,
      idempotency_key: 'k-add',
    });
    expect(added.kind).toBe('ok');
    expect(cartOf(cart)?.cart_subtotal_minor).toBe(350);
  });
});

describe('cart.previewResume — revalidation on every resume (K4)', () => {
  it('lists price changes (old, new) and unavailable lines, and writes nothing', async () => {
    const cart = await parkedSale([PARA, [IBUP, 2], AMOX]);
    w.catalogue.set(IBUP, { kind: 'price', unit_price_minor: 260 });
    w.catalogue.set(AMOX, { kind: 'gone' });
    const lineId = (item: string): string =>
      row<{ line_id: string }>(w, `SELECT line_id FROM cart_lines WHERE item_ref = ?`, [item])
        ?.line_id ?? '';

    const preview = w.parks.previewResume({ cart_id: cart });

    expect(preview).toMatchObject({
      kind: 'preview',
      changes: [{ line_id: lineId(IBUP), old_unit_minor: 200, new_unit_minor: 260 }],
      unavailable: [{ line_id: lineId(AMOX) }],
    });
    expect(preview.kind === 'preview' && preview.diff_token).toMatch(/^[0-9a-f]{32}$/);
    expect(cartOf(cart)?.parked_at).toBe(T0);
    expect(linesOf(cart).map((l) => l.unit_price_minor)).toEqual([450, 200, 150]);
  });

  it('names each changed and unavailable line with its stored name and quantity (RT-610)', async () => {
    const cart = await parkedSale([PARA, [IBUP, 2], [AMOX, 3]]);
    w.catalogue.set(IBUP, { kind: 'price', unit_price_minor: 260 });
    w.catalogue.set(AMOX, { kind: 'gone' });
    const stored = (item: string) =>
      row<{ line_id: string; display_name: string; quantity: number }>(
        w,
        `SELECT line_id, display_name, quantity FROM cart_lines WHERE item_ref = ?`,
        [item],
      );
    const ibup = stored(IBUP);
    const amox = stored(AMOX);
    const logsBefore = w.logs.length;

    const preview = w.parks.previewResume({ cart_id: cart });
    if (preview.kind !== 'preview') throw new Error(`preview refused: ${preview.reason}`);

    expect(preview.changes).toEqual([
      {
        line_id: ibup?.line_id,
        display_name: ibup?.display_name,
        quantity: 2,
        old_unit_minor: 200,
        new_unit_minor: 260,
      },
    ]);
    expect(preview.unavailable).toEqual([
      { line_id: amox?.line_id, display_name: amox?.display_name, quantity: 3 },
    ]);
    expect(ibup?.display_name).not.toBe('');
    // Product name and quantity only: no item_ref, money totals or identity.
    expect(Object.keys(preview).sort()).toEqual(['changes', 'diff_token', 'kind', 'unavailable']);
    expect(JSON.stringify(preview)).not.toContain(IBUP);
    expect(JSON.stringify(preview)).not.toContain(AMOX);
    // The names reach the renderer only; the preview logs nothing about them.
    expect(w.logs.slice(logsBefore).join('\n')).not.toContain(ibup?.display_name ?? '-');
  });

  it('keeps the diff_token a digest of line ids and prices only (RT-610)', async () => {
    const cart = await parkedSale([PARA, [IBUP, 2], AMOX]);
    w.catalogue.set(IBUP, { kind: 'price', unit_price_minor: 260 });
    w.catalogue.set(AMOX, { kind: 'gone' });
    const id = (item: string): string =>
      row<{ line_id: string }>(w, `SELECT line_id FROM cart_lines WHERE item_ref = ?`, [item])
        ?.line_id ?? '';
    const shown = { changes: [[id(IBUP), 200, 260]], unavailable: [id(AMOX)] };
    const expected = createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 32);

    expect(token(cart)).toBe(expected);
  });

  it('a preview with nothing to review stays empty', async () => {
    const cart = await parkedSale([PARA, IBUP]);
    expect(w.parks.previewResume({ cart_id: cart })).toMatchObject({
      kind: 'preview',
      changes: [],
      unavailable: [],
    });
  });

  it('refuses catalogue_unavailable when the catalogue cannot be read', async () => {
    const cart = await parkedSale([PARA, IBUP]);
    w.catalogue.set(IBUP, { kind: 'unavailable' });
    expect(w.parks.previewResume({ cart_id: cart })).toEqual({
      kind: 'refused',
      reason: 'catalogue_unavailable',
    });
  });

  it('refuses a cart that is not parked, and another operator’s (even a manager)', async () => {
    const open = await openSale(w, [PARA]);
    expect(w.parks.previewResume({ cart_id: open })).toMatchObject({ reason: 'not_parked' });
    expect(w.parks.previewResume({ cart_id: 'nope' })).toMatchObject({ reason: 'not_parked' });
    const cart = await parkedSale([PARA]);
    w.session = sessionOf('cashier-2');
    expect(w.parks.previewResume({ cart_id: cart })).toMatchObject({ reason: 'wrong_owner' });
    w.session = sessionOf('admin-1', { role: 'admin' });
    expect(w.parks.previewResume({ cart_id: cart })).toMatchObject({ reason: 'wrong_owner' });
    w.terminal = 'term-2';
    w.session = sessionOf('cashier-1');
    expect(w.parks.previewResume({ cart_id: cart })).toMatchObject({ reason: 'wrong_owner' });
  });
});

describe('cart.resume — price changes and unavailable lines need acceptance', () => {
  it('refuses unaccepted changes, and a changed diff_token, changing nothing', async () => {
    const cart = await parkedSale([PARA, AMOX]);
    w.catalogue.set(PARA, { kind: 'price', unit_price_minor: 170 });
    expect(w.parks.resume(resumeReq(cart))).toMatchObject({ reason: 'price_changes_unaccepted' });

    const seen = token(cart);
    w.catalogue.set(AMOX, { kind: 'price', unit_price_minor: 500 }); // changed after the preview
    expect(
      w.parks.resume(resumeReq(cart, { accept_changes: true, diff_token: seen })),
    ).toMatchObject({ reason: 'price_changes_unaccepted' });
    expect(cartOf(cart)?.parked_at).toBe(T0);
  });

  it('on acceptance re-prices through cart.line.update and soft-removes through cart.line.remove', async () => {
    const cart = await parkedSale([[PARA, 3], IBUP, AMOX]);
    w.catalogue.set(PARA, { kind: 'price', unit_price_minor: 170 });
    w.catalogue.set(IBUP, { kind: 'gone' });
    const req = resumeReq(cart, { accept_changes: true });

    expect(w.parks.resume(req)).toEqual({ kind: 'resumed', cart_id: cart });
    expect(linesOf(cart)).toEqual([
      { item_ref: AMOX, unit_price_minor: 450, line_subtotal_minor: 450, removed: 0 },
      { item_ref: IBUP, unit_price_minor: 200, line_subtotal_minor: 200, removed: 1 },
      { item_ref: PARA, unit_price_minor: 170, line_subtotal_minor: 510, removed: 0 },
    ]);
    expect(cartOf(cart)).toMatchObject({
      cart_subtotal_minor: 960,
      last_action_id: req.idempotency_key,
    });
    expect(
      rows(
        w,
        `SELECT action_kind FROM cart_action_outbox
          WHERE cart_id = ? AND payload_json LIKE '%_on_resume%' ORDER BY action_kind`,
        [cart],
      ),
    ).toEqual([{ action_kind: 'cart.line.remove' }, { action_kind: 'cart.line.update' }]);
    expect(w.audit.find((e) => e.action_category === 'cart.resumed')?.payload).toMatchObject({
      price_changes_accepted: 1,
      removed_unavailable: 1,
    });
  });

  it('drops the discount placeholders of a removed line, so handoff carries no orphan', async () => {
    const cart = await parkedSale([PARA, IBUP]);
    const gone = row<{ line_id: string }>(
      w,
      `SELECT line_id FROM cart_lines WHERE cart_id = ? AND item_ref = ?`,
      [cart, IBUP],
    )?.line_id;
    const kept = row<{ line_id: string }>(
      w,
      `SELECT line_id FROM cart_lines WHERE cart_id = ? AND item_ref = ?`,
      [cart, PARA],
    )?.line_id;
    const scope = row<{ tenant_id: string; branch_id: string }>(
      w,
      `SELECT tenant_id, branch_id FROM carts WHERE cart_id = ?`,
      [cart],
    );
    for (const [id, line] of [
      ['ph-gone', gone],
      ['ph-kept', kept],
    ]) {
      w.raw.run(
        `INSERT INTO cart_line_discount_placeholders (placeholder_id, cart_id, line_id,
           placeholder_kind, requires_manager_attribution, attribution_operator_id, created_at)
         VALUES (?, ?, ?, 'manual_pct_5', 0, NULL, ?)`,
        [id ?? '', cart, line ?? '', T0],
      );
      // RT-614: the audit row RT-608's add writes makes the placeholder trusted.
      seedManagerAuthorizedDiscount(w.raw, {
        tenant_id: scope?.tenant_id ?? '',
        branch_id: scope?.branch_id ?? '',
        cart_id: cart,
        line_id: line ?? '',
        placeholder_id: id ?? '',
      });
    }
    w.catalogue.set(IBUP, { kind: 'gone' });
    const req = resumeReq(cart, { accept_changes: true });
    expect(w.parks.resume(req)).toMatchObject({ kind: 'resumed' });

    expect(
      rows(w, `SELECT placeholder_id FROM cart_line_discount_placeholders WHERE cart_id = ?`, [
        cart,
      ]),
    ).toEqual([{ placeholder_id: 'ph-kept' }]);
    expect(
      rows(w, `SELECT action_kind FROM cart_action_outbox WHERE payload_json LIKE ?`, [
        '%"placeholder_id":"ph-gone"%',
      ]),
    ).toEqual([{ action_kind: 'cart.discount_placeholder.remove' }]);
    const versions = rows<{ line_id: string; version: number }>(
      w,
      `SELECT line_id, version FROM cart_lines WHERE cart_id = ? AND removed_at IS NULL`,
      [cart],
    );
    const handoff = await w.cart.handoff({
      cart_id: cart,
      per_line_versions: versions,
      idempotency_key: 'k-handoff',
    });
    if (handoff.kind !== 'ok') throw new Error(`handoff refused: ${handoff.reason}`);
    const lineIds = handoff.envelope.lines.map((l) => l.line_id);
    for (const ph of handoff.envelope.discount_placeholders) {
      expect(lineIds).toContain(ph.line_id);
    }
  });

  it('refuses catalogue_unavailable and removes nothing (an outage is not a removal)', async () => {
    const cart = await parkedSale([PARA, IBUP]);
    const req = resumeReq(cart, { accept_changes: true });
    w.catalogue.set(PARA, { kind: 'unavailable' });
    expect(w.parks.resume(req)).toMatchObject({ reason: 'catalogue_unavailable' });
    expect(linesOf(cart).every((l) => l.removed === 0)).toBe(true);
    expect(cartOf(cart)?.parked_at).toBe(T0);
  });
});

describe('cart.resume — the current sale (I-13, VN-R10, R-6)', () => {
  it('keep: refuses current_cart_active and leaves both sales as they are', async () => {
    const parked = await parkedSale([PARA]);
    const current = await openSale(w, [IBUP]);
    expect(w.parks.resume(resumeReq(parked))).toMatchObject({ reason: 'current_cart_active' });
    expect(cartOf(parked)?.parked_at).toBe(T0);
    expect(cartOf(current)?.parked_at).toBeNull();
  });

  it('park: parks the current sale and resumes the selected one in one transaction', async () => {
    const parked = await parkedSale([PARA]);
    const current = await openSale(w, [IBUP]);
    expect(w.parks.resume(resumeReq(parked, { current_cart: 'park' }))).toMatchObject({
      kind: 'resumed',
    });
    expect(cartOf(parked)?.parked_at).toBeNull();
    expect(cartOf(current)?.parked_at).toBe(T0);
    expect(w.audit.find((e) => e.action_category === 'cart.resumed')?.payload).toMatchObject({
      current_cart: 'parked',
    });
    expect(rows(w, `SELECT action_kind FROM cart_park_actions ORDER BY rowid`)).toEqual([
      { action_kind: 'cart.park' },
      { action_kind: 'cart.resume' },
    ]);
  });

  it('a full terminal can still swap (the selected sale leaves the set first)', async () => {
    const mine = await parkedSale([PARA]);
    for (const op of ['cashier-2', 'cashier-3', 'cashier-4', 'cashier-5']) {
      w.session = sessionOf(op);
      await parkedSale([PARA]);
    }
    w.session = sessionOf('cashier-1');
    const current = await openSale(w, [IBUP]);
    expect(w.parks.resume(resumeReq(mine, { current_cart: 'park' }))).toMatchObject({
      kind: 'resumed',
    });
    expect(cartOf(current)?.parked_at).toBe(T0);
  });

  it('refuses park_limit_reached when two open drafts would not fit', async () => {
    const mine = await parkedSale([PARA]);
    for (const op of ['cashier-2', 'cashier-3', 'cashier-4', 'cashier-5']) {
      w.session = sessionOf(op);
      await parkedSale([PARA]);
    }
    w.session = sessionOf('cashier-1');
    await openSale(w, [IBUP]);
    await openSale(w, [AMOX]);
    expect(w.parks.resume(resumeReq(mine, { current_cart: 'park' }))).toMatchObject({
      reason: 'park_limit_reached',
    });
  });

  it('refuses not_parkable when the current sale awaits a manager attribution', async () => {
    const parked = await parkedSale([PARA]);
    const current = await openSale(w, [IBUP]);
    w.raw.run(`UPDATE carts SET state = 'discount_pending_attribution' WHERE cart_id = ?`, [
      current,
    ]);
    expect(w.parks.resume(resumeReq(parked, { current_cart: 'park' }))).toMatchObject({
      reason: 'not_parkable',
    });
  });

  it('closes an empty current cart with RT-352’s empty close, whatever current_cart says', async () => {
    const parked = await parkedSale([PARA]);
    const created = await w.cart.create({ idempotency_key: 'k-empty' });
    const empty = created.kind === 'ok' ? created.cart_id : '';
    expect(w.parks.resume(resumeReq(parked))).toMatchObject({ kind: 'resumed' });
    expect(cartOf(empty)).toMatchObject({
      state: 'cancelled',
      cancellation_reason: 'session_ended',
    });
  });

  it('refuses checkout_in_progress while the session has an unpaid handoff or a started attempt', async () => {
    const parked = await parkedSale([PARA]);
    const current = await openSale(w, [IBUP]);
    w.raw.run(`UPDATE carts SET state = 'frozen_handed_off' WHERE cart_id = ?`, [current]);
    expect(w.parks.resume(resumeReq(parked, { current_cart: 'park' }))).toMatchObject({
      reason: 'checkout_in_progress',
    });
    insertAttempt(w, { cart_id: current, state: 'settled' }); // paid: no longer in checkout
    expect(w.parks.resume(resumeReq(parked))).toMatchObject({ kind: 'resumed' });
  });

  it('refuses checkout_in_progress for a started attempt on an editing cart', async () => {
    const parked = await parkedSale([PARA]);
    const current = await openSale(w, [IBUP]);
    insertAttempt(w, { cart_id: current, state: 'started' });
    expect(w.parks.resume(resumeReq(parked, { current_cart: 'park' }))).toMatchObject({
      reason: 'checkout_in_progress',
    });
  });
});

describe('cart.resume — other refusals', () => {
  it('refuses another operator, a non-parked cart, a latched or locked session', async () => {
    const cart = await parkedSale([PARA]);
    const req = resumeReq(cart);
    w.session = sessionOf('manager-1', { role: 'manager' });
    expect(w.parks.resume(req)).toMatchObject({ reason: 'wrong_owner' });
    w.session = sessionOf('cashier-1', { authority_latch: 'superseded_by_takeover' });
    expect(w.parks.resume(req)).toMatchObject({ reason: 'authority_conflict' });
    w.session = sessionOf('cashier-1', { lock_state: 'locked' });
    expect(w.parks.resume(req)).toMatchObject({ reason: 'session_locked' });
    w.session = sessionOf('cashier-1');
    expect(w.parks.resume(req)).toMatchObject({ kind: 'resumed' });
    expect(w.parks.resume({ ...req, idempotency_key: 'k-again' })).toMatchObject({
      reason: 'not_parked',
    });
  });

  it('replays the first outcome, and refuses a different request under the same key', async () => {
    const cart = await parkedSale([PARA]);
    const req = resumeReq(cart);
    w.parks.resume(req);
    const audits = w.audit.length;
    expect(w.parks.resume(req)).toEqual({ kind: 'resumed', cart_id: cart });
    expect(w.audit).toHaveLength(audits);
    expect(w.parks.resume({ ...req, current_cart: 'park' })).toMatchObject({
      reason: 'idempotency_payload_mismatch',
    });
    const parkKey = parkCart(w, await openSale(w, [IBUP]));
    expect(w.parks.resume({ ...req, idempotency_key: parkKey })).toMatchObject({
      reason: 'idempotency_payload_mismatch',
    });
  });
});

describe('one idempotency namespace with the cart bridge (R-7)', () => {
  it('refuses a cart call that reuses a park or resume key', async () => {
    const cart = await openSale(w, [PARA]);
    const parkKey = parkCart(w, cart);
    const req = resumeReq(cart);
    w.parks.resume(req);
    const mismatch = { kind: 'refused', reason: 'idempotency_payload_mismatch' };

    expect(
      await w.cart.linesAdd({
        cart_id: cart,
        item_ref: IBUP,
        quantity: 1,
        idempotency_key: req.idempotency_key,
      }),
    ).toEqual(mismatch);
    expect(await w.cart.void({ cart_id: cart, idempotency_key: parkKey })).toEqual(mismatch);
    expect(await w.cart.create({ idempotency_key: parkKey })).toEqual(mismatch);
    expect(
      rows(w, `SELECT 1 FROM cart_lines WHERE cart_id = ? AND item_ref = ?`, [cart, IBUP]),
    ).toEqual([]);
    expect(cartOf(cart)?.state).toBe('editing');
  });
});

describe('resume line writes never collide with a cart key (Codex review on #662)', () => {
  it('resumes even when an earlier cart action used a key shaped like a derived id', async () => {
    const cart = await parkedSale([PARA, IBUP]);
    const lineOf = (item: string): string =>
      row<{ line_id: string }>(
        w,
        `SELECT line_id FROM cart_lines WHERE cart_id = ? AND item_ref = ?`,
        [cart, item],
      )?.line_id ?? '';
    const key = 'k-resume';
    const other = await openSale(w, []);
    for (const crafted of [`${key}:reprice:${lineOf(PARA)}`, `${key}:remove:${lineOf(IBUP)}`]) {
      const added = await w.cart.linesAdd({
        cart_id: other,
        item_ref: crafted.includes('reprice') ? AMOX : PARA,
        quantity: 1,
        idempotency_key: crafted,
      });
      expect(added.kind).toBe('ok');
    }
    w.catalogue.set(PARA, { kind: 'price', unit_price_minor: 175 });
    w.catalogue.set(IBUP, { kind: 'gone' });
    w.parks.park({ cart_id: other, idempotency_key: 'k-park-other' });

    expect(w.parks.resume(resumeReq(cart, { accept_changes: true, idempotency_key: key }))).toEqual(
      { kind: 'resumed', cart_id: cart },
    );
    expect(linesOf(cart).map((l) => [l.item_ref, l.unit_price_minor, l.removed])).toEqual([
      [IBUP, 200, 1],
      [PARA, 175, 0],
    ]);
  });
});

describe('no Undo across a park (R-3)', () => {
  it('refuses Undo of a pre-park line after park and after resume, and of a re-price', async () => {
    const cart = await openSale(w, [PARA]);
    const added = await w.cart.linesAdd({
      cart_id: cart,
      item_ref: IBUP,
      quantity: 1,
      idempotency_key: 'k-pre-park',
    });
    expect(added.kind).toBe('ok');
    parkCart(w, cart);
    const undo = (target: string) =>
      w.cart.undoLast({
        cart_id: cart,
        target_action_id: target,
        idempotency_key: crypto.randomUUID(),
      });

    expect(await undo('k-pre-park')).toEqual({ kind: 'refused', reason: 'cart_parked' });

    w.catalogue.set(PARA, { kind: 'price', unit_price_minor: 999 });
    const req = resumeReq(cart, { accept_changes: true });
    w.parks.resume(req);
    expect(await undo('k-pre-park')).toEqual({ kind: 'refused', reason: 'undo_not_available' });
    const reprice = row<{ action_id: string }>(
      w,
      `SELECT action_id FROM cart_action_outbox WHERE payload_json LIKE '%reprice_on_resume%'`,
    )?.action_id;
    expect(reprice).toBeDefined();
    expect(await undo(reprice ?? '')).toEqual({ kind: 'refused', reason: 'undo_not_available' });
    expect(await undo(req.idempotency_key)).toEqual({
      kind: 'refused',
      reason: 'undo_not_available',
    });
  });
});

describe('no tender row is ever touched', () => {
  it('leaves payment_attempts and payment_tender_lines exactly as they were', async () => {
    const paid = await openSale(w, [AMOX]);
    insertAttempt(w, { cart_id: paid, state: 'settled', id: 'pa-paid' });
    const snapshot = (): string =>
      JSON.stringify([
        rows(w, `SELECT * FROM payment_attempts ORDER BY payment_attempt_id`),
        rows(w, `SELECT * FROM payment_tender_lines ORDER BY tender_line_id`),
      ]);
    const before = snapshot();
    const cart = await parkedSale([PARA, IBUP]);
    w.catalogue.set(PARA, { kind: 'price', unit_price_minor: 1 });
    w.catalogue.set(IBUP, { kind: 'gone' });
    await openSale(w, [AMOX]);
    w.parks.resume(resumeReq(cart, { accept_changes: true, current_cart: 'park' }));
    expect(snapshot()).toBe(before);
  });
});
