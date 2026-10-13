/**
 * T059 — cart.discountPlaceholders.add below threshold (S3 contract).
 *
 * When `placeholder_kind` signals a below-threshold discount (e.g.,
 * 'percent_5'), the handler MUST:
 *   1. Insert a `cart_line_discount_placeholders` row.
 *   2. Write a `cart.discount.add` outbox row.
 *   3. Return `{ kind: 'ok', placeholder_id, requires_manager_attribution: false }`.
 *
 * No manager attribution is required. No audit event is emitted for below-
 * threshold discounts (spec FR-023 — audit only fires at/above threshold).
 *
 * Convention: `placeholder_kind` strings starting with a digit ≤ tenant
 * threshold are treated as below-threshold. Tests use 'percent_5' (below)
 * and 'percent_20' (above, tested in T060/T061). The actual threshold
 * evaluation moves to the S3 handler; tests simply assert the contract.
 *
 * Tests asserting { kind: 'ok' } are RED until T069 (discount handler wiring).
 * Gate-layer tests are GREEN (S2 live).
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
    id: 'sess-t059',
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
}

async function newCartWithLine(session = makeSession()): Promise<Fixture> {
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

  const createRes = await handlers.create({ idempotency_key: 'create-t059' });
  if (createRes.kind !== 'ok') throw new Error('create failed');

  const addRes = await handlers.linesAdd({
    cart_id: createRes.cart_id,
    item_ref: 'SKU-A',
    quantity: 2,
    idempotency_key: 'add-t059',
  });
  if (addRes.kind !== 'ok') throw new Error('linesAdd failed');

  return { db, handlers, cart_id: createRes.cart_id, line_id: addRes.line_id };
}

function readDiscountPlaceholders(db: SqlJsDatabase, cart_id: string): Record<string, unknown>[] {
  const stmt = db.prepare('SELECT * FROM cart_line_discount_placeholders WHERE cart_id = ?');
  stmt.bind([cart_id]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
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

describe('cart.discountPlaceholders.add — gate layer (S2 live)', () => {
  it('refuses when no session', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
    });
    const res = await handlers.discountPlaceholdersAdd({
      cart_id: 'cart-x',
      line_id: 'line-x',
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-no-sess',
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
    const res = await handlers.discountPlaceholdersAdd({
      cart_id: 'nonexistent',
      line_id: 'line-x',
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-no-cart',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('wrong_owner');
  });
});

// ── S3 contract: below-threshold (T059 — RED until T069) ──────────────────

describe('cart.discountPlaceholders.add — below-threshold S3 contract (RED until T069)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newCartWithLine();
  });

  it('returns ok with requires_manager_attribution: false for below-threshold kind', async () => {
    const res = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-t059-a',
    });
    // RED until T069.
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.requires_manager_attribution).toBe(false);
      expect(typeof res.placeholder_id).toBe('string');
    }
  });

  it('inserts a cart_line_discount_placeholders row', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-t059-b',
    });
    // RED until T069.
    const rows = readDiscountPlaceholders(f.db, f.cart_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['placeholder_kind']).toBe('percent_5');
    expect(rows[0]?.['line_id']).toBe(f.line_id);
  });

  it('writes an outbox row for the discount action', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-t059-c',
    });
    // RED until T069.
    const kinds = readOutboxKinds(f.db, f.cart_id);
    expect(kinds.some((k) => k.startsWith('cart.discount'))).toBe(true);
  });

  it('is idempotent — same idempotency_key yields ok with same placeholder_id', async () => {
    const res1 = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-t059-d',
    });
    const res2 = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-t059-d',
    });
    // RED until T069.
    expect(res1.kind).toBe('ok');
    expect(res2.kind).toBe('ok');
    if (res1.kind === 'ok' && res2.kind === 'ok') {
      expect(res2.placeholder_id).toBe(res1.placeholder_id);
    }
  });

  it('does not emit an audit event for below-threshold discount', async () => {
    // No audit event expected for below-threshold — assert outbox has no
    // cart.discount.above_threshold row.
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'dp-t059-e',
    });
    // RED until T069 (when outbox IS written, assert above_threshold is absent).
    const kinds = readOutboxKinds(f.db, f.cart_id);
    expect(kinds).not.toContain('cart.discount.above_threshold');
  });
});
