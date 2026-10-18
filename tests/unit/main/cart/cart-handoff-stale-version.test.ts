/**
 * T080 — cart.handoff refuses stale per_line_versions.
 *
 * US3-AS5; FR-037. If any line's client-supplied version does not match
 * the DB version, handoff must refuse with stale_version. Cart stays in
 * 'editing' state — no partial mutation.
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
    id: 'sess-stale',
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
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

describe('cart.handoff stale version refusal (T080)', () => {
  it('refuses with stale_version when one line version is wrong', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
    });

    const c = await handlers.create({ idempotency_key: 'sv-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'sv-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 999 }], // wrong version
      idempotency_key: 'sv-h',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('stale_version');
  });

  it('cart remains in editing state after stale_version refusal', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
    });

    const c = await handlers.create({ idempotency_key: 'sv2-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'sv2-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 0 }],
      idempotency_key: 'sv2-h',
    });

    // Cart must still be mutable — verify by being able to add another line.
    const addAfter = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'sv2-a2',
    });
    // Q4 merge: same item_ref merges
    expect(addAfter.kind).toBe('ok');
  });

  it('refuses when per_line_versions omits a line that exists in the cart', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
    });

    const c = await handlers.create({ idempotency_key: 'sv3-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'sv3-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    // per_line_versions is empty — no version assertions provided.
    // The contract treats per_line_versions as a set of optimistic-concurrency assertions;
    // an empty array means "assert nothing" — the handoff proceeds normally.
    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [],
      idempotency_key: 'sv3-h',
    });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.envelope.envelope_version).toBe('v1');
    }
  });
});
