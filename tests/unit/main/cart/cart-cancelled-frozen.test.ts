/**
 * T058 — Cancelled and frozen cart gate coverage (S2 live — GREEN).
 *
 * Verifies that ALL mutating bridge operations correctly refuse for carts in
 * terminal states:
 *   - `frozen_handed_off` → reason: 'frozen'
 *   - `cancelled`         → reason: 'closed'
 *
 * These refusals are enforced by `gateMutatingS2` / `requireOperatorSession`
 * with `requireMutable: true`, which is already implemented in S2. All tests
 * in this file should be GREEN.
 *
 * Direct DB SQL is used to set terminal states (avoids needing the S3 void/
 * handoff handlers which are not yet implemented).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
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

function makeSession(overrides?: Partial<OperatorSessionRecord>): OperatorSessionRecord {
  return {
    id: 'sess-t058',
    operator_id: 'cashier-1',
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-16T08:00:00.000Z',
    backend_session_id: 'b-sess-1',
    last_activity_at: '2026-05-16T08:00:00.000Z',
    ...overrides,
  };
}

const fixtureResolver: ItemRefResolver = (item_ref) => {
  if (item_ref === 'SKU-A')
    return Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });
  return Promise.resolve({ kind: 'refused', reason: 'unknown_item' });
};

interface CartFixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
}

async function makeCartInState(state: 'frozen_handed_off' | 'cancelled'): Promise<CartFixture> {
  const session = makeSession();
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handle = makeSqlJsHandle(db);
  const store = bindCartStore(handle);
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-test-380',
    cartStore: store,
    resolveItemRef: fixtureResolver,
    clock: () => new Date('2026-05-16T10:00:00.000Z'),
  });

  const createRes = await handlers.create({ idempotency_key: `create-t058-${state}` });
  if (createRes.kind !== 'ok') throw new Error('create failed');

  // Set terminal state directly — avoids depending on S3 handlers.
  db.run(`UPDATE carts SET state = ? WHERE cart_id = ?`, [state, createRes.cart_id]);

  return { db, handlers, cart_id: createRes.cart_id };
}

// ── frozen_handed_off → reason: 'frozen' ──────────────────────────────────

describe('frozen_handed_off cart — all mutations refuse with frozen (S2 live)', () => {
  it('void refuses with frozen', async () => {
    const { handlers, cart_id } = await makeCartInState('frozen_handed_off');
    const res = await handlers.void({ cart_id, idempotency_key: 'void-frozen' });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('handoff refuses with frozen', async () => {
    const { handlers, cart_id } = await makeCartInState('frozen_handed_off');
    const res = await handlers.handoff({
      cart_id,
      per_line_versions: [],
      idempotency_key: 'handoff-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('linesAdd refuses with frozen', async () => {
    const { handlers, cart_id } = await makeCartInState('frozen_handed_off');
    const res = await handlers.linesAdd({
      cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'add-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('linesUpdate refuses with frozen', async () => {
    const { handlers, cart_id } = await makeCartInState('frozen_handed_off');
    const res = await handlers.linesUpdate({
      cart_id,
      line_id: 'line-nonexistent',
      op: 'increment',
      version: 1,
      idempotency_key: 'upd-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('linesRemove refuses with frozen', async () => {
    const { handlers, cart_id } = await makeCartInState('frozen_handed_off');
    const res = await handlers.linesRemove({
      cart_id,
      line_id: 'line-nonexistent',
      version: 1,
      idempotency_key: 'rem-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('discountPlaceholdersAdd refuses with frozen', async () => {
    const { handlers, cart_id } = await makeCartInState('frozen_handed_off');
    const res = await handlers.discountPlaceholdersAdd({
      cart_id,
      line_id: 'line-nonexistent',
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-add-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('discountPlaceholdersRemove refuses with frozen', async () => {
    const { handlers, cart_id } = await makeCartInState('frozen_handed_off');
    const res = await handlers.discountPlaceholdersRemove({
      cart_id,
      placeholder_id: 'ph-nonexistent',
      idempotency_key: 'dp-rem-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });
});

// ── cancelled → reason: 'closed' ──────────────────────────────────────────

describe('cancelled cart — all mutations refuse with closed (S2 live)', () => {
  it('void refuses with closed', async () => {
    const { handlers, cart_id } = await makeCartInState('cancelled');
    const res = await handlers.void({ cart_id, idempotency_key: 'void-closed' });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('closed');
  });

  it('handoff refuses with closed', async () => {
    const { handlers, cart_id } = await makeCartInState('cancelled');
    const res = await handlers.handoff({
      cart_id,
      per_line_versions: [],
      idempotency_key: 'handoff-closed',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('closed');
  });

  it('linesAdd refuses with closed', async () => {
    const { handlers, cart_id } = await makeCartInState('cancelled');
    const res = await handlers.linesAdd({
      cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'add-closed',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('closed');
  });

  it('linesUpdate refuses with closed', async () => {
    const { handlers, cart_id } = await makeCartInState('cancelled');
    const res = await handlers.linesUpdate({
      cart_id,
      line_id: 'line-nonexistent',
      op: 'increment',
      version: 1,
      idempotency_key: 'upd-closed',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('closed');
  });

  it('linesRemove refuses with closed', async () => {
    const { handlers, cart_id } = await makeCartInState('cancelled');
    const res = await handlers.linesRemove({
      cart_id,
      line_id: 'line-nonexistent',
      version: 1,
      idempotency_key: 'rem-closed',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('closed');
  });

  it('discountPlaceholdersAdd refuses with closed', async () => {
    const { handlers, cart_id } = await makeCartInState('cancelled');
    const res = await handlers.discountPlaceholdersAdd({
      cart_id,
      line_id: 'line-nonexistent',
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-add-closed',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('closed');
  });

  it('discountPlaceholdersRemove refuses with closed', async () => {
    const { handlers, cart_id } = await makeCartInState('cancelled');
    const res = await handlers.discountPlaceholdersRemove({
      cart_id,
      placeholder_id: 'ph-nonexistent',
      idempotency_key: 'dp-rem-closed',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('closed');
  });
});
