/**
 * RT-113 P2 (Codex P1 #1 / review F2) — the authority latch on cart.create.
 *
 * Once the cashier admission heartbeat learns the session lost its authority
 * (taken over elsewhere, account refused, device revoked), the session is
 * latched until it can end at its next safe point. While latched, no NEW sale
 * may start: `cart.create` refuses `authority_conflict`. The current sale may
 * still complete or be voided. Each sale boundary (a refused create, a void, a
 * post-handoff cancel) re-checks the safe point through `onSaleBoundary`.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
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
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function cashierSession(): OperatorSessionRecord {
  return {
    id: 'sess-latch',
    operator_id: 'user_clerk_1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-04T08:00:00.000Z',
    backend_session_id: '',
    last_activity_at: '2026-10-04T08:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
    authority: 'online_confirmed',
  };
}

function build(session: OperatorSessionRecord): {
  handlers: CartBridgeHandlers;
  onSaleBoundary: ReturnType<typeof vi.fn>;
  db: SqlJsDatabase;
} {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const onSaleBoundary = vi.fn();
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-1',
    cartStore: bindCartStore(makeSqlJsHandle(db)),
    clock: () => new Date('2026-10-04T10:00:00.000Z'),
    onSaleBoundary,
  });
  return { handlers, onSaleBoundary, db };
}

describe('cart.create under the authority latch', () => {
  it('without a latch a new sale starts and no boundary is signalled', async () => {
    const { handlers, onSaleBoundary } = build(cashierSession());
    const res = await handlers.create({ idempotency_key: 'create-latch-0001' });
    expect(res.kind).toBe('ok');
    expect(onSaleBoundary).not.toHaveBeenCalled();
  });

  it.each([
    'superseded_by_takeover',
    'account_disabled_mid_session',
    'terminal_session_terminated',
  ] as const)(
    'latched (%s): cart.create refuses authority_conflict and signals the sale boundary',
    async (cause) => {
      const session = cashierSession();
      session.authority_latch = cause;
      const { handlers, onSaleBoundary } = build(session);
      const res = await handlers.create({ idempotency_key: 'create-latch-0002' });
      expect(res).toEqual({ kind: 'refused', reason: 'authority_conflict' });
      expect(onSaleBoundary).toHaveBeenCalledOnce();
    },
  );

  it('the current sale may still be voided while latched; the void signals the boundary', async () => {
    const session = cashierSession();
    const { handlers, onSaleBoundary, db } = build(session);
    const created = await handlers.create({ idempotency_key: 'create-latch-0003' });
    if (created.kind !== 'ok') throw new Error('create failed');
    db.run(`UPDATE carts SET state = 'editing' WHERE cart_id = ?`, [created.cart_id]);
    session.authority_latch = 'superseded_by_takeover';
    const res = await handlers.void({
      cart_id: created.cart_id,
      idempotency_key: 'void-latch-0001',
    });
    expect(res).toEqual({ kind: 'ok' });
    expect(onSaleBoundary).toHaveBeenCalledOnce();
  });
});
