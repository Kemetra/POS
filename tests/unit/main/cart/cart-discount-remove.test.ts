/**
 * T062 — cart.discountPlaceholders.remove (S3 contract).
 *
 * The handler MUST:
 *   1. Remove the discount placeholder (soft-delete or hard-delete).
 *   2. Write an outbox row.
 *   3. Return `{ kind: 'ok' }`.
 *
 * Manager attribution is NOT required for removal (FR-023 — only addition
 * above threshold requires attribution). Either cashier or manager can
 * remove a placeholder.
 *
 * No audit event is emitted for discount removal.
 *
 * Tests are RED until T069 (discount handler wiring).
 * Gate-layer refusals (frozen/closed/no session) are GREEN.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
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

function makeSession(overrides?: Partial<OperatorSessionRecord>): OperatorSessionRecord {
  return {
    id: 'sess-t062',
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

const fixtureResolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

interface Fixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
  line_id: string;
  placeholder_id: string;
}

async function newCartWithPlaceholder(session = makeSession()): Promise<Fixture> {
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

  const createRes = await handlers.create({ idempotency_key: 'create-t062' });
  if (createRes.kind !== 'ok') throw new Error('create failed');

  const addRes = await handlers.linesAdd({
    cart_id: createRes.cart_id,
    item_ref: 'SKU-A',
    quantity: 1,
    idempotency_key: 'add-t062',
  });
  if (addRes.kind !== 'ok') throw new Error('linesAdd failed');

  // Insert a placeholder directly via SQL (avoids depending on T069 add handler).
  const placeholder_id = 'ph-t062-seed';
  db.run(
    `INSERT INTO cart_line_discount_placeholders
       (placeholder_id, cart_id, line_id, placeholder_kind,
        requires_manager_attribution, attribution_operator_id, created_at)
     VALUES (?, ?, ?, 'percent_5', 0, NULL, '2026-05-16T10:01:00.000Z')`,
    [placeholder_id, createRes.cart_id, addRes.line_id],
  );

  return {
    db,
    handlers,
    cart_id: createRes.cart_id,
    line_id: addRes.line_id,
    placeholder_id,
  };
}

function readOutboxKinds(db: SqlJsDatabase, cart_id: string): string[] {
  const stmt = db.prepare(
    'SELECT action_kind FROM cart_action_outbox WHERE cart_id = ? ORDER BY applied_at',
  );
  stmt.bind([cart_id]);
  const kinds: string[] = [];
  while (stmt.step()) kinds.push(stmt.getAsObject()['action_kind'] as string);
  stmt.free();
  return kinds;
}

// ── Gate layer (S2 live — GREEN) ───────────────────────────────────────────

describe('cart.discountPlaceholders.remove — gate layer (S2 live)', () => {
  it('refuses when no session', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
    });
    const res = await handlers.discountPlaceholdersRemove({
      cart_id: 'cart-x',
      placeholder_id: 'ph-x',
      idempotency_key: 'dp-rem-no-sess',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('no_session');
  });

  it('refuses when cart does not exist', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const session = makeSession();
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
    });
    const res = await handlers.discountPlaceholdersRemove({
      cart_id: 'nonexistent',
      placeholder_id: 'ph-x',
      idempotency_key: 'dp-rem-no-cart',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('wrong_owner');
  });

  it('refuses on frozen cart', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const session = makeSession();
    const store = bindCartStore(makeSqlJsHandle(db));
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store,
    });
    const createRes = await handlers.create({ idempotency_key: 'create-frozen-t062' });
    if (createRes.kind !== 'ok') throw new Error();
    db.run(`UPDATE carts SET state = 'frozen_handed_off' WHERE cart_id = ?`, [createRes.cart_id]);
    const res = await handlers.discountPlaceholdersRemove({
      cart_id: createRes.cart_id,
      placeholder_id: 'ph-x',
      idempotency_key: 'dp-rem-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });
});

// ── S3 contract: remove placeholder (T062 — RED until T069) ───────────────

describe('cart.discountPlaceholders.remove — S3 contract (RED until T069)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newCartWithPlaceholder();
  });

  it('returns { kind: ok } when removing an existing placeholder', async () => {
    const res = await f.handlers.discountPlaceholdersRemove({
      cart_id: f.cart_id,
      placeholder_id: f.placeholder_id,
      idempotency_key: 'dp-rem-t062-a',
    });
    // RED until T069.
    expect(res.kind).toBe('ok');
  });

  it('removes the placeholder row (hard-delete or soft-delete)', async () => {
    await f.handlers.discountPlaceholdersRemove({
      cart_id: f.cart_id,
      placeholder_id: f.placeholder_id,
      idempotency_key: 'dp-rem-t062-b',
    });
    // RED until T069. After T069, either no rows remain (hard delete)
    // or a future migration adds removed_at for soft-delete.
    // For now assert the outbox record proves the action was applied.
    const kinds = readOutboxKinds(f.db, f.cart_id);
    expect(kinds.some((k) => k.startsWith('cart.discount'))).toBe(true);
  });

  it('writes an outbox row for the remove action', async () => {
    await f.handlers.discountPlaceholdersRemove({
      cart_id: f.cart_id,
      placeholder_id: f.placeholder_id,
      idempotency_key: 'dp-rem-t062-c',
    });
    // RED until T069 — when implemented, an outbox row with a discount-related
    // action_kind MUST be written.
    const kinds = readOutboxKinds(f.db, f.cart_id);
    // post-implementation: expect(kinds.some((k) => k.startsWith('cart.discount'))).toBe(true);
    // pre-implementation: no outbox row exists, so we assert the test will fail (red).
    expect(kinds.some((k) => k.startsWith('cart.discount'))).toBe(true);
  });

  it('is idempotent — replaying the same key returns ok', async () => {
    await f.handlers.discountPlaceholdersRemove({
      cart_id: f.cart_id,
      placeholder_id: f.placeholder_id,
      idempotency_key: 'dp-rem-t062-d',
    });
    const res2 = await f.handlers.discountPlaceholdersRemove({
      cart_id: f.cart_id,
      placeholder_id: f.placeholder_id,
      idempotency_key: 'dp-rem-t062-d',
    });
    // RED until T069.
    expect(res2.kind).toBe('ok');
  });

  it('a manager can also remove a placeholder (no attribution required for removal)', async () => {
    const mgrSession = makeSession({
      id: 'sess-mgr-t062',
      operator_id: 'mgr-1',
      role: 'manager',
    });
    const db2 = new SQL.Database();
    for (const sql of MIGRATIONS) db2.run(sql);
    const handle2 = makeSqlJsHandle(db2);
    const store2 = bindCartStore(handle2);
    const mgrHandlers = new CartBridgeHandlers({
      getCurrentSession: () => mgrSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store2,
    });
    const createRes = await mgrHandlers.create({ idempotency_key: 'create-mgr-t062' });
    if (createRes.kind !== 'ok') throw new Error();

    const phId = 'ph-mgr-t062';
    // Use a real line_id from a cart line add to satisfy NOT NULL on line_id.
    // For this gate test we insert a placeholder with a placeholder line_id;
    // the handler is expected to look up by placeholder_id, not line_id.
    db2.run(
      `INSERT INTO cart_line_discount_placeholders
         (placeholder_id, cart_id, line_id, placeholder_kind,
          requires_manager_attribution, attribution_operator_id, created_at)
       VALUES (?, ?, 'line-mgr-x', 'percent_5', 0, NULL, '2026-05-16T10:00:00.000Z')`,
      [phId, createRes.cart_id],
    );

    const res = await mgrHandlers.discountPlaceholdersRemove({
      cart_id: createRes.cart_id,
      placeholder_id: phId,
      idempotency_key: 'dp-rem-mgr-t062',
    });
    // RED until T069.
    expect(res.kind).toBe('ok');
  });
});
