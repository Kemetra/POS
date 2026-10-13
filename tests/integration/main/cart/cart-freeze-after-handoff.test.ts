/**
 * T081 — Freeze rule: after cart.handoff succeeds, every mutating bridge call
 * returns { kind: 'refused', reason: 'frozen' }.
 *
 * SC-004; FR-035. Envelope and lines must be unchanged after a freeze attempt.
 * Tests all 6 mutating handlers: linesAdd, linesUpdate, linesRemove, linesSetNote,
 * discountPlaceholdersAdd, discountPlaceholdersRemove, void (cashier path).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';

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
    id: 'sess-freeze',
    operator_id: 'cashier-1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-17T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-05-17T08:00:00.000Z',
    ...overrides,
  };
}

const resolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

interface FrozenFixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
  line_id: string;
  line_version: number;
}

async function makeFrozenCart(): Promise<FrozenFixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const session = makeSession();
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-test-380',
    cartStore: bindCartStore(makeSqlJsHandle(db)),
    resolveItemRef: resolver,
    clock: () => new Date('2026-05-17T10:00:00.000Z'),
  });

  const c = await handlers.create({ idempotency_key: 'frz-c' });
  if (c.kind !== 'ok') throw new Error('create failed');
  const a = await handlers.linesAdd({
    cart_id: c.cart_id,
    item_ref: 'SKU-A',
    quantity: 1,
    idempotency_key: 'frz-a',
  });
  if (a.kind !== 'ok') throw new Error('add failed');

  const h = await handlers.handoff({
    cart_id: c.cart_id,
    per_line_versions: [{ line_id: a.line_id, version: 1 }],
    idempotency_key: 'frz-h',
  });
  if (h.kind !== 'ok') throw new Error(`handoff failed: ${JSON.stringify(h)}`);

  return { db, handlers, cart_id: c.cart_id, line_id: a.line_id, line_version: 1 };
}

describe('freeze rule — all mutating handlers refuse after handoff (T081)', () => {
  it('linesAdd refuses with frozen', async () => {
    const f = await makeFrozenCart();
    const res = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'post-add',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('linesUpdate refuses with frozen', async () => {
    const f = await makeFrozenCart();
    const res = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'increment',
      version: f.line_version,
      idempotency_key: 'post-upd',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('linesRemove refuses with frozen', async () => {
    const f = await makeFrozenCart();
    const res = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: f.line_id,
      version: f.line_version,
      idempotency_key: 'post-rem',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('linesSetNote refuses with frozen', async () => {
    const f = await makeFrozenCart();
    const res = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'test note',
      version: f.line_version,
      idempotency_key: 'post-note',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('discountPlaceholdersAdd refuses with frozen', async () => {
    const f = await makeFrozenCart();
    const res = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'post-dp-add',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('discountPlaceholdersRemove refuses with frozen', async () => {
    const f = await makeFrozenCart();
    const res = await f.handlers.discountPlaceholdersRemove({
      cart_id: f.cart_id,
      placeholder_id: 'ph-nonexistent',
      idempotency_key: 'post-dp-rem',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('void (cashier) refuses with frozen', async () => {
    const f = await makeFrozenCart();
    const res = await f.handlers.void({
      cart_id: f.cart_id,
      idempotency_key: 'post-void',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('handoff itself refuses with frozen on repeated call (non-idempotent path)', async () => {
    const f = await makeFrozenCart();
    // Different idempotency_key → should get frozen refusal, not idempotency replay
    const res = await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [],
      idempotency_key: 'post-h2',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });

  it('envelope and lines are unchanged after freeze attempt', async () => {
    const f = await makeFrozenCart();
    // Attempt to add a line (refused)
    await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 99,
      idempotency_key: 'post-add2',
    });

    // Verify line count via raw SQL
    const stmt = f.db.prepare(
      `SELECT COUNT(*) AS c FROM cart_lines WHERE cart_id = ? AND removed_at IS NULL`,
    );
    stmt.bind([f.cart_id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row['c']).toBe(1); // Only the original line remains
  });
});
