/**
 * T085 — Offline handoff: handoff proceeds locally; audit row queued in
 * cart_action_outbox with synced_at = null; renderer must NOT claim payment succeeded.
 *
 * The main-process handoff is always local (SQLite-only in 005). Network
 * connectivity is irrelevant to the handoff itself — all data is written
 * locally. The "offline" invariant is:
 *   1. cart_action_outbox row for cart.handoff_to_payment is written with synced_at = null.
 *   2. The handoff response is { kind: 'ok', envelope } — not a failure.
 *   3. The envelope is frozen and complete.
 *
 * P2 / NFR-008: renderer must not claim payment succeeded — enforced by the
 * design of CartHandoffResponse (it only carries the frozen envelope, not a
 * payment confirmation). This test verifies the envelope contains no payment
 * confirmation fields.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const resolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

function makeSession(): OperatorSessionRecord {
  return {
    id: 'sess-offline',
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

async function makeHandoffResult(): Promise<{
  db: SqlJsDatabase;
  cart_id: string;
  handoff_key: string;
  res: Awaited<ReturnType<CartBridgeHandlers['handoff']>>;
}> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handlers = new CartBridgeHandlers({
    getCurrentSession: makeSession,
    getTerminalId: () => 'terminal-test-380',
    cartStore: bindCartStore(makeSqlJsHandle(db)),
    resolveItemRef: resolver,
    clock: () => new Date('2026-05-17T10:00:00.000Z'),
  });

  const c = await handlers.create({ idempotency_key: 'off-c' });
  if (c.kind !== 'ok') throw new Error('create failed');
  const a = await handlers.linesAdd({
    cart_id: c.cart_id,
    item_ref: 'SKU-A',
    quantity: 1,
    idempotency_key: 'off-a',
  });
  if (a.kind !== 'ok') throw new Error('add failed');

  const KEY = 'off-h';
  const res = await handlers.handoff({
    cart_id: c.cart_id,
    per_line_versions: [{ line_id: a.line_id, version: 1 }],
    idempotency_key: KEY,
  });

  return { db, cart_id: c.cart_id, handoff_key: KEY, res };
}

describe('offline handoff — local-only persistence (T085)', () => {
  it('handoff succeeds locally and returns ok with envelope', async () => {
    const { res } = await makeHandoffResult();
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.envelope.envelope_version).toBe('v1');
    }
  });

  it('cart_action_outbox row for handoff has synced_at = null (queued, not synced)', async () => {
    const { db, handoff_key } = await makeHandoffResult();
    const stmt = db.prepare(
      `SELECT synced_at, action_kind FROM cart_action_outbox WHERE action_id = ?`,
    );
    stmt.bind([handoff_key]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();

    expect(row['action_kind']).toBe('cart.handoff_to_payment');
    // synced_at is null — the row is queued locally, not yet synced to backend
    expect(row['synced_at']).toBeNull();
  });

  it('envelope does NOT contain payment_status or paid_at (no payment claim)', async () => {
    const { res } = await makeHandoffResult();
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      const env = res.envelope as unknown as Record<string, unknown>;
      expect(env['payment_status']).toBeUndefined();
      expect(env['paid_at']).toBeUndefined();
      expect(env['tender_amount']).toBeUndefined();
      expect(env['change_amount']).toBeUndefined();
      expect(env['payment_confirmed']).toBeUndefined();
    }
  });

  it('envelope is frozen even in offline/local-only path', async () => {
    const { res } = await makeHandoffResult();
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(Object.isFrozen(res.envelope)).toBe(true);
      expect(Object.isFrozen(res.envelope.lines)).toBe(true);
    }
  });

  it('cart state is frozen_handed_off after offline handoff', async () => {
    const { db, cart_id } = await makeHandoffResult();
    const stmt = db.prepare('SELECT state, frozen_at FROM carts WHERE cart_id = ?');
    stmt.bind([cart_id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();

    expect(row['state']).toBe('frozen_handed_off');
    expect(row['frozen_at']).toBeTruthy();
  });
});
