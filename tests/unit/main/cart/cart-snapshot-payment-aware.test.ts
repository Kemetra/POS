/**
 * §A4 review hardening of `cart.snapshot` and of the envelope the renderer
 * receives (external review, 2026-09-25).
 *
 *   - A cart whose payment settled is reported `paid: true` with NO envelope,
 *     so a reopened paid sale can never be offered to payment again.
 *   - A handed-off cart that is not paid keeps its envelope (the sale can
 *     continue), including while an attempt is in progress or force-failed.
 *   - The renderer never receives manager attribution: it is scrubbed from the
 *     envelope in both `cart.handoff` and `cart.snapshot`.
 *   - No payment-status source wired → a frozen cart is refused, not guessed.
 *   - A corrupt persisted envelope refuses generically instead of throwing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { CartPaymentStatus } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

const MANAGER_SECRET = 'mgr-secret-operator-id';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const SESSION: OperatorSessionRecord = {
  id: 'sess-owner',
  operator_id: 'cashier-1',
  display_name: 'Cashier One',
  role: 'cashier',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  started_at: '2026-09-25T08:00:00.000Z',
  backend_session_id: 'b',
  last_activity_at: '2026-09-25T08:00:00.000Z',
};

const resolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'باراسيتامول', unit_price_minor: 1250 });

function handlersFor(db: SqlJsDatabase, status: CartPaymentStatus | null): CartBridgeHandlers {
  let t = Date.parse('2026-09-25T10:00:00.000Z');
  return new CartBridgeHandlers({
    getCurrentSession: () => SESSION,
    getTerminalId: () => 'terminal-1',
    cartStore: bindCartStore(makeSqlJsHandle(db)),
    resolveItemRef: resolver,
    clock: () => new Date((t += 1000)),
    ...(status === null ? {} : { cartPaymentStatus: () => status }),
  });
}

/** A cart with one line, created through the real handlers. */
async function cartWithLine(
  handlers: CartBridgeHandlers,
): Promise<{ cartId: string; lineId: string }> {
  const c = await handlers.create({ idempotency_key: 'k-create' });
  if (c.kind !== 'ok') throw new Error('create failed');
  const a = await handlers.linesAdd({
    cart_id: c.cart_id,
    item_ref: 'p-para',
    quantity: 1,
    idempotency_key: 'k-add',
  });
  if (a.kind !== 'ok') throw new Error('add failed');
  return { cartId: c.cart_id, lineId: a.line_id };
}

/** A manager-attributed discount placeholder: the attribution is manager identity. */
function seedManagerDiscount(db: SqlJsDatabase, cartId: string, lineId: string): void {
  db.run(
    `INSERT INTO cart_line_discount_placeholders
       (placeholder_id, cart_id, line_id, placeholder_kind, requires_manager_attribution,
        attribution_operator_id, created_at)
     VALUES ('dp-1', ?, ?, 'percent_above_threshold', 1, ?, '2026-09-25T10:00:30.000Z')`,
    [cartId, lineId, MANAGER_SECRET],
  );
}

async function handedOff(status: CartPaymentStatus | null): Promise<{
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cartId: string;
  handoffJson: string;
}> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handlers = handlersFor(db, status);
  const { cartId, lineId } = await cartWithLine(handlers);
  seedManagerDiscount(db, cartId, lineId);
  const h = await handlers.handoff({
    cart_id: cartId,
    per_line_versions: [{ line_id: lineId, version: 1 }],
    idempotency_key: 'k-handoff',
  });
  if (h.kind !== 'ok') throw new Error('handoff refused');
  return { db, handlers, cartId, handoffJson: JSON.stringify(h) };
}

describe('cart.snapshot — payment aware', () => {
  it('reports a settled cart as paid and returns no envelope', async () => {
    const f = await handedOff('settled');
    const res = await f.handlers.snapshot({ cart_id: f.cartId });
    if (res.kind !== 'ok') throw new Error('snapshot refused');
    expect(res.snapshot.state).toBe('frozen_handed_off');
    expect(res.snapshot.paid).toBe(true);
    expect(res.snapshot.envelope).toBeNull();
  });

  it.each(['none', 'started', 'force_failed'] as const)(
    'keeps the envelope of an unpaid handed-off cart (payment status %s)',
    async (status) => {
      const f = await handedOff(status);
      const res = await f.handlers.snapshot({ cart_id: f.cartId });
      if (res.kind !== 'ok') throw new Error('snapshot refused');
      expect(res.snapshot.paid).toBe(false);
      expect(res.snapshot.envelope?.cart_id).toBe(f.cartId);
    },
  );

  it('refuses a frozen cart when no payment-status source is wired', async () => {
    const f = await handedOff(null);
    expect(await f.handlers.snapshot({ cart_id: f.cartId })).toEqual({
      kind: 'refused',
      reason: 'not_implemented',
    });
  });

  it('refuses generically, without throwing, when the persisted envelope is corrupt', async () => {
    const f = await handedOff('none');
    f.db.run(
      `UPDATE carts SET handoff_envelope_json = '{"lines":[{"note":"PII' WHERE cart_id = ?`,
      [f.cartId],
    );
    const res = await f.handlers.snapshot({ cart_id: f.cartId });
    expect(res).toEqual({ kind: 'refused', reason: 'not_implemented' });
  });
});

describe('renderer envelope — manager attribution never crosses the bridge', () => {
  it('scrubs attribution from the snapshot envelope but keeps the placeholder', async () => {
    const f = await handedOff('none');
    const res = await f.handlers.snapshot({ cart_id: f.cartId });
    if (res.kind !== 'ok' || res.snapshot.envelope === null) throw new Error('no envelope');
    expect(JSON.stringify(res)).not.toContain(MANAGER_SECRET);
    expect(res.snapshot.envelope.discount_placeholders).toEqual([
      expect.objectContaining({ placeholder_id: 'dp-1', attribution_operator_id: null }),
    ]);
  });

  it('scrubs attribution from the cart.handoff response too', async () => {
    const f = await handedOff('none');
    expect(f.handoffJson).not.toContain(MANAGER_SECRET);
  });

  it('keeps the attribution in the persisted envelope main uses for audit and finalize', async () => {
    const f = await handedOff('none');
    const stmt = f.db.prepare('SELECT handoff_envelope_json FROM carts WHERE cart_id = ?');
    stmt.bind([f.cartId]);
    stmt.step();
    const persisted = String(stmt.getAsObject()['handoff_envelope_json']);
    stmt.free();
    expect(persisted).toContain(MANAGER_SECRET);
  });
});
