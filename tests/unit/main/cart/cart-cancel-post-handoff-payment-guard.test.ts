/**
 * Post-handoff cancel must never cancel a sale whose payment is in progress or
 * already settled. A cart stays `frozen_handed_off` after payment (no cart
 * transition follows settlement), so `cancelPostHandoff` itself — the main-
 * process authority — refuses when a started or settled payment attempt
 * exists for the cart. Exercised through the PRODUCTION factory so a dropped
 * composition-root wiring cannot silently disable the guard.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Logger } from 'pino';

import { createCartBridgeHandlers } from '../../../../src/main/cart/wire-cart-handlers.js';
import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname0, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function session(role: OperatorSessionRecord['role'], id: string): OperatorSessionRecord {
  return {
    id,
    operator_id: `op-${id}`,
    display_name: 'Test Operator',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-09-25T08:00:00.000Z',
    backend_session_id: `b-${id}`,
    last_activity_at: '2026-09-25T08:00:00.000Z',
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

async function frozenCartUnderManager(
  hasPaymentForCart: (cartId: string) => boolean,
  actingRole: OperatorSessionRecord['role'] = 'manager',
): Promise<{
  db: SqlJsDatabase;
  cartId: string;
  handlers: CartBridgeHandlers;
  emit: ReturnType<typeof vi.fn>;
  guard: ReturnType<typeof vi.fn>;
}> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handle = makeSqlJsHandle(db);
  const cashier = session('cashier', 'sess-cashier');
  const creator = new CartBridgeHandlers({
    getCurrentSession: () => cashier,
    getTerminalId: () => 'terminal-1',
    cartStore: bindCartStore(handle),
  });
  const created = await creator.create({ idempotency_key: 'create-1' });
  if (created.kind !== 'ok') throw new Error('create failed');
  db.run(`UPDATE carts SET state = 'frozen_handed_off' WHERE cart_id = ?`, [created.cart_id]);
  // A real persisted handoff: the cancel's handoff_action_id is verified against it.
  db.run(
    `INSERT INTO cart_action_outbox
       (action_id, cart_id, line_id, action_kind, acting_operator_id,
        attribution_operator_id, operator_session_id, payload_json, applied_at)
     VALUES ('handoff-1', ?, NULL, 'cart.handoff_to_payment', ?, NULL, ?, '{}', ?)`,
    [created.cart_id, cashier.operator_id, cashier.id, '2026-09-25T09:00:00.000Z'],
  );

  const emit = vi.fn();
  const guard = vi.fn((cartId: string) => (hasPaymentForCart(cartId) ? 'settled' : 'none'));
  // A cashier actor is the cart's own session, so ownership passes and the role rule decides.
  const manager = actingRole === 'cashier' ? cashier : session(actingRole, 'sess-manager');
  const handlers = createCartBridgeHandlers({
    dbHandle: handle,
    getCurrentSession: () => manager,
    getTerminalId: () => 'terminal-1',
    logger,
    auditEmitter: { emit } as unknown as AuditEmitter,
    isPackaged: true,
    cartPaymentStatus: guard,
  });
  return { db, cartId: created.cart_id, handlers, emit, guard };
}

function cartState(db: SqlJsDatabase, cartId: string): unknown {
  const stmt = db.prepare('SELECT state FROM carts WHERE cart_id = ?');
  stmt.bind([cartId]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row?.['state'];
}

function outboxKinds(db: SqlJsDatabase, cartId: string): unknown[] {
  const stmt = db.prepare('SELECT action_kind FROM cart_action_outbox WHERE cart_id = ?');
  stmt.bind([cartId]);
  const kinds: unknown[] = [];
  while (stmt.step()) kinds.push(stmt.getAsObject()['action_kind']);
  stmt.free();
  return kinds;
}

describe('cart.cancelPostHandoff — payment guard (production wiring)', () => {
  it('refuses closed, and writes nothing, when the cart has a started or settled payment', async () => {
    const f = await frozenCartUnderManager(() => true);
    const res = await f.handlers.cancelPostHandoff({
      cart_id: f.cartId,
      handoff_action_id: 'handoff-1',
      idempotency_key: 'cancel-1',
    });
    expect(res).toEqual({ kind: 'refused', reason: 'closed' });
    expect(f.guard).toHaveBeenCalledWith(f.cartId);
    expect(cartState(f.db, f.cartId)).toBe('frozen_handed_off');
    expect(outboxKinds(f.db, f.cartId)).not.toContain('cart.cancel.post_handoff');
    expect(f.emit).not.toHaveBeenCalled();
  });

  it('cancels a frozen cart with no blocking payment, emitting the existing audit event', async () => {
    const f = await frozenCartUnderManager(() => false);
    const res = await f.handlers.cancelPostHandoff({
      cart_id: f.cartId,
      handoff_action_id: 'handoff-1',
      idempotency_key: 'cancel-2',
    });
    expect(res).toEqual({ kind: 'ok' });
    expect(cartState(f.db, f.cartId)).toBe('cancelled');
    expect(outboxKinds(f.db, f.cartId)).toContain('cart.cancel.post_handoff');
    expect(f.emit).toHaveBeenCalledOnce();
  });

  it('still replays an already-applied cancel idempotently', async () => {
    let paid = false;
    const f = await frozenCartUnderManager(() => paid);
    const req = { cart_id: f.cartId, handoff_action_id: 'handoff-1', idempotency_key: 'cancel-3' };
    expect(await f.handlers.cancelPostHandoff(req)).toEqual({ kind: 'ok' });
    paid = true;
    expect(await f.handlers.cancelPostHandoff(req)).toEqual({ kind: 'ok' });
    expect(f.emit).toHaveBeenCalledOnce();
  });
});

describe('cart.cancelPostHandoff — cashier authority stays in main', () => {
  it('refuses a cashier without attribution — the only shape the renderer bridge can send', async () => {
    const f = await frozenCartUnderManager(() => false, 'cashier');
    const res = await f.handlers.cancelPostHandoff({
      cart_id: f.cartId,
      handoff_action_id: 'handoff-1',
      idempotency_key: 'cancel-cashier',
    });
    expect(res).toEqual({ kind: 'refused', reason: 'manager_attribution_required' });
    expect(cartState(f.db, f.cartId)).toBe('frozen_handed_off');
    expect(f.emit).not.toHaveBeenCalled();
  });
});
