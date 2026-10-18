/**
 * T079 — cart.handoff refuses empty cart with { kind: 'refused', reason: 'empty_cart' }.
 *
 * US3-AS2; FR-037. A cart with no non-removed lines must be refused.
 * Cart stays in current state (does not transition).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function makeSession(): OperatorSessionRecord {
  return {
    id: 'sess-empty',
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

const resolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Item', unit_price_minor: 100 });

describe('cart.handoff empty cart refusal (T079)', () => {
  it('refuses with empty_cart when cart has no lines', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
    });

    const c = await handlers.create({ idempotency_key: 'emp-c' });
    if (c.kind !== 'ok') throw new Error('create failed');

    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [],
      idempotency_key: 'emp-h',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('empty_cart');
  });

  it('refuses with empty_cart when all lines have been removed', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
    });

    const c = await handlers.create({ idempotency_key: 'emp2-c' });
    if (c.kind !== 'ok') throw new Error('create failed');

    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-X',
      quantity: 1,
      idempotency_key: 'emp2-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');
    await handlers.linesRemove({
      cart_id: c.cart_id,
      line_id: a.line_id,
      version: 1,
      idempotency_key: 'emp2-r',
    });

    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [],
      idempotency_key: 'emp2-h',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('empty_cart');
  });

  it('refuses handoff for a session with no active session', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    let authenticated = true;
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => (authenticated ? makeSession() : null),
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
    });

    const c = await handlers.create({ idempotency_key: 'emp3-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-X',
      quantity: 1,
      idempotency_key: 'emp3-a',
    });

    authenticated = false;
    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [],
      idempotency_key: 'emp3-h',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('no_session');
  });
});
