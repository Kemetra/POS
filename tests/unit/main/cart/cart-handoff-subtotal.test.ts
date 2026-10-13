/**
 * T078 — subtotal_minor is integer Σ line_subtotal_minor; no float coercion.
 *
 * buildPaymentIntentEnvelope must compute subtotal_minor fresh from
 * non-removed cart lines only. Integer arithmetic — Number.isSafeInteger.
 *
 * Tests use CartBridgeHandlers.handoff() end-to-end via sql.js, which lets us
 * confirm the envelope that comes back carries the correct subtotal.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
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

const resolver: ItemRefResolver = (item_ref) => {
  const map: Record<string, { display_name: string; unit_price_minor: number }> = {
    'SKU-A': { display_name: 'Aspirin', unit_price_minor: 150 },
    'SKU-B': { display_name: 'Bandage', unit_price_minor: 80 },
    'SKU-C': { display_name: 'Capsule', unit_price_minor: 200 },
  };
  const f = map[item_ref];
  if (!f) return Promise.resolve({ kind: 'refused', reason: 'unknown_item' });
  return Promise.resolve({ kind: 'ok', ...f });
};

function makeSession(): OperatorSessionRecord {
  return {
    id: 'sess-subtotal',
    operator_id: 'cashier-1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-17T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-05-17T08:00:00.000Z',
  };
}

describe('cart.handoff subtotal_minor computation (T078)', () => {
  it('subtotal_minor equals sum of non-removed line_subtotal_minor values', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      clock: () => new Date('2026-05-17T10:00:00.000Z'),
    });

    const c = await handlers.create({ idempotency_key: 'sub-c' });
    if (c.kind !== 'ok') throw new Error('create failed');

    // SKU-A: qty=2, price=150 → subtotal=300
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: 'sub-a',
    });
    // SKU-B: qty=3, price=80  → subtotal=240
    const b = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-B',
      quantity: 3,
      idempotency_key: 'sub-b',
    });
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('add failed');

    // Expected: 300 + 240 = 540
    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [
        { line_id: a.line_id, version: 1 },
        { line_id: b.line_id, version: 1 },
      ],
      idempotency_key: 'sub-h',
    });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.envelope.subtotal_minor).toBe(540);
      expect(Number.isInteger(res.envelope.subtotal_minor)).toBe(true);
      expect(Number.isSafeInteger(res.envelope.subtotal_minor)).toBe(true);
    }
  });

  it('subtotal_minor excludes removed lines', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      clock: () => new Date('2026-05-17T10:00:00.000Z'),
    });

    const c = await handlers.create({ idempotency_key: 'sub2-c' });
    if (c.kind !== 'ok') throw new Error('create failed');

    // SKU-A: qty=2 price=150 subtotal=300 (will be removed)
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: 'sub2-a',
    });
    // SKU-C: qty=1 price=200 subtotal=200 (kept)
    const b = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-C',
      quantity: 1,
      idempotency_key: 'sub2-b',
    });
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('add failed');

    // Remove SKU-A
    await handlers.linesRemove({
      cart_id: c.cart_id,
      line_id: a.line_id,
      version: 1,
      idempotency_key: 'sub2-r',
    });

    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: b.line_id, version: 1 }],
      idempotency_key: 'sub2-h',
    });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.envelope.subtotal_minor).toBe(200);
      expect(res.envelope.lines).toHaveLength(1);
    }
  });
});
