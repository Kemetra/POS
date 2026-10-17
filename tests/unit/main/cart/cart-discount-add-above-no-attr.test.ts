/**
 * T060 — cart.discountPlaceholders.add on a cashier session WITHOUT manager
 *        authority (S3 contract, revised by RT-608).
 *
 * RT-608 (RT-28, spec 005 FR-023 revised): there is no threshold. Any
 * discount a cashier adds without a consumed `cart.discount.manual` approval
 * (`approval_id`) is refused `manager_attribution_required` and writes
 * nothing. These tests use 'percent_20'; the same refusal for 'percent_5' and
 * 'percent_1' is in `cart-discount-add-below.test.ts`.
 *
 * Gate-layer refusals (no session, wrong cart) are unchanged. */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import type { CartDiscountPlaceholdersAddRequest } from '../../../../src/shared/cart/bridge-types.js';
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
    id: 'sess-t060',
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

  const createRes = await handlers.create({ idempotency_key: 'create-t060' });
  if (createRes.kind !== 'ok') throw new Error('create failed');

  const addRes = await handlers.linesAdd({
    cart_id: createRes.cart_id,
    item_ref: 'SKU-A',
    quantity: 1,
    idempotency_key: 'add-t060',
  });
  if (addRes.kind !== 'ok') throw new Error('linesAdd failed');

  return { db, handlers, cart_id: createRes.cart_id, line_id: addRes.line_id };
}

// ── S3 contract: above-threshold without attribution (T060 — RED until T069) ─

describe('cart.discountPlaceholders.add — above-threshold without attribution (RED until T069)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newCartWithLine();
  });

  it('refuses with manager_attribution_required when no attribution_operator_id provided', async () => {
    const res = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      // attribution_operator_id intentionally omitted.
      idempotency_key: 'dp-t060-a',
    });
    // RED until T069 (currently returns 'not_implemented').
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('manager_attribution_required');
  });

  it('does not insert a placeholder row when attribution is missing', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t060-b',
    });
    const stmt = f.db.prepare(
      'SELECT COUNT(*) AS cnt FROM cart_line_discount_placeholders WHERE cart_id = ?',
    );
    stmt.bind([f.cart_id]);
    stmt.step();
    const cnt = stmt.getAsObject()['cnt'];
    stmt.free();
    // No row should be inserted on a refused request.
    expect(cnt).toBe(0);
  });

  it('does not write an outbox row when attribution is missing', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t060-c',
    });
    const stmt = f.db.prepare(
      `SELECT action_kind FROM cart_action_outbox
       WHERE cart_id = ? AND action_kind LIKE 'cart.discount%'`,
    );
    stmt.bind([f.cart_id]);
    const rows: string[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject()['action_kind'] as string);
    stmt.free();
    expect(rows).toHaveLength(0);
  });

  it('still refuses when cashier passes their own id as attribution (role check required)', async () => {
    // A cashier cannot self-attribute above-threshold discounts. RT-183: the
    // field is no longer part of the request contract and is ignored if a
    // scripted renderer still sends it; the session role decides.
    const res = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      attribution_operator_id: 'cashier-1', // same as cashier, not a manager
      idempotency_key: 'dp-t060-d',
    } as CartDiscountPlaceholdersAddRequest);
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('manager_attribution_required');
  });
});
