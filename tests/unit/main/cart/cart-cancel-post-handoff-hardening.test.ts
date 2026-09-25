/**
 * §A4 review hardening of `cart.cancelPostHandoff` (external review, 2026-09-25).
 *
 *   - The renderer-supplied `handoff_action_id` must match the cart's persisted
 *     handoff, so the audit record can never be mislabelled.
 *   - An idempotency replay is honoured only for the SAME cart and handoff; a
 *     key reused for another cart must not report a cancel that never happened.
 *   - The payment-status dependency fails CLOSED when it is missing.
 *   - Ownership and tenant/branch isolation hold for this handler specifically.
 *   - The state + payment check and the cancel UPDATE are one transaction: if
 *     the cart stops being frozen before the UPDATE lands, nothing is written.
 *   - The real payments record (not a stub) blocks the cancel.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { CartPaymentStatus } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import {
  bindCartPaymentStatus,
  bindPaymentAttemptsRepository,
} from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
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
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

const HANDOFF = 'handoff-action-1';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function session(
  role: OperatorSessionRecord['role'],
  id: string,
  overrides: Partial<OperatorSessionRecord> = {},
): OperatorSessionRecord {
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
    ...overrides,
  };
}

interface Fixture {
  db: SqlJsDatabase;
  cartId: string;
  emit: ReturnType<typeof vi.fn>;
  as: (
    actor: OperatorSessionRecord,
    paymentStatus?: ((cartId: string) => CartPaymentStatus) | null,
  ) => CartBridgeHandlers;
  cashier: OperatorSessionRecord;
}

/** A cart created by `cashier`, handed off for real (persisted handoff action). */
async function frozenCart(): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handle = makeSqlJsHandle(db);
  const store = bindCartStore(handle);
  const cashier = session('cashier', 'sess-cashier');
  const emit = vi.fn();
  const as: Fixture['as'] = (actor, paymentStatus = () => 'none') =>
    new CartBridgeHandlers({
      getCurrentSession: () => actor,
      getTerminalId: () => 'terminal-1',
      cartStore: store,
      auditEmitter: { emit } as unknown as AuditEmitter,
      ...(paymentStatus === null ? {} : { cartPaymentStatus: paymentStatus }),
    });
  const creator = as(cashier);
  const created = await creator.create({ idempotency_key: 'create-1' });
  if (created.kind !== 'ok') throw new Error('create failed');
  db.run(`UPDATE carts SET state = 'frozen_handed_off' WHERE cart_id = ?`, [created.cart_id]);
  db.run(
    `INSERT INTO cart_action_outbox
       (action_id, cart_id, line_id, action_kind, acting_operator_id,
        attribution_operator_id, operator_session_id, payload_json, applied_at)
     VALUES (?, ?, NULL, 'cart.handoff_to_payment', ?, NULL, ?, '{}', ?)`,
    [HANDOFF, created.cart_id, cashier.operator_id, cashier.id, '2026-09-25T09:00:00.000Z'],
  );
  return { db, cartId: created.cart_id, emit, as, cashier };
}

function one(db: SqlJsDatabase, sql: string, params: (string | number)[]): unknown {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const value = stmt.step() ? Object.values(stmt.getAsObject())[0] : undefined;
  stmt.free();
  return value;
}

const state = (f: Fixture): unknown =>
  one(f.db, 'SELECT state FROM carts WHERE cart_id = ?', [f.cartId]);
const cancelRows = (f: Fixture): unknown =>
  one(
    f.db,
    `SELECT COUNT(*) FROM cart_action_outbox WHERE cart_id = ? AND action_kind = 'cart.cancel.post_handoff'`,
    [f.cartId],
  );

const manager = session('manager', 'sess-manager');

function expectUntouched(f: Fixture): void {
  expect(state(f)).toBe('frozen_handed_off');
  expect(cancelRows(f)).toBe(0);
  expect(f.emit).not.toHaveBeenCalled();
}

describe('cancelPostHandoff — verified handoff action on success', () => {
  it('records the verified handoff action in the audit payload on success', async () => {
    const f = await frozenCart();
    const res = await f.as(manager).cancelPostHandoff({
      cart_id: f.cartId,
      handoff_action_id: HANDOFF,
      idempotency_key: 'cancel-2',
    });
    expect(res).toEqual({ kind: 'ok' });
    expect(state(f)).toBe('cancelled');
    const event = f.emit.mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(event.payload['handoff_action_id']).toBe(HANDOFF);
  });
});

describe('cancelPostHandoff — idempotency replay is bound to the cart', () => {
  it('refuses a key replayed against a different cart, leaving that cart frozen', async () => {
    const a = await frozenCart();
    expect(
      await a.as(manager).cancelPostHandoff({
        cart_id: a.cartId,
        handoff_action_id: HANDOFF,
        idempotency_key: 'shared-key',
      }),
    ).toEqual({ kind: 'ok' });

    // A second frozen cart in the SAME store, reusing the first cart's key.
    const cashierB = session('cashier', 'sess-cashier-b');
    const handlersB = a.as(cashierB);
    const createdB = await handlersB.create({ idempotency_key: 'create-b' });
    if (createdB.kind !== 'ok') throw new Error('create b failed');
    a.db.run(`UPDATE carts SET state = 'frozen_handed_off' WHERE cart_id = ?`, [createdB.cart_id]);
    const res = await a.as(manager).cancelPostHandoff({
      cart_id: createdB.cart_id,
      handoff_action_id: HANDOFF,
      idempotency_key: 'shared-key',
    });
    expect(res).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
    expect(one(a.db, 'SELECT state FROM carts WHERE cart_id = ?', [createdB.cart_id])).toBe(
      'frozen_handed_off',
    );
  });

  it('refuses a replay whose handoff action differs from the recorded one', async () => {
    const f = await frozenCart();
    const req = { cart_id: f.cartId, handoff_action_id: HANDOFF, idempotency_key: 'k-1' };
    expect(await f.as(manager).cancelPostHandoff(req)).toEqual({ kind: 'ok' });
    expect(
      await f.as(manager).cancelPostHandoff({ ...req, handoff_action_id: 'handoff-other' }),
    ).toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });
});

interface RefusalCase {
  readonly actor: OperatorSessionRecord;
  readonly reason: string;
  readonly handoff?: string;
  readonly cartId?: string;
  readonly noPaymentSource?: boolean;
}

const REFUSALS: ReadonlyArray<readonly [string, RefusalCase]> = [
  [
    'a forged handoff action (stale_version)',
    { actor: manager, handoff: 'handoff-forged', reason: 'stale_version' },
  ],
  [
    'a missing payment-status source (fails closed)',
    { actor: manager, noPaymentSource: true, reason: 'not_implemented' },
  ],
  [
    'a manager in another branch',
    { actor: session('manager', 'm-b2', { branch_id: 'branch-2' }), reason: 'tenant_isolation' },
  ],
  [
    'a manager in another tenant',
    { actor: session('manager', 'm-t2', { tenant_id: 'tenant-2' }), reason: 'tenant_isolation' },
  ],
  ["another session's cashier", { actor: session('cashier', 'sess-x'), reason: 'wrong_owner' }],
  ['an unknown cart id', { actor: manager, cartId: 'cart-does-not-exist', reason: 'wrong_owner' }],
];

describe('cancelPostHandoff — refusals write nothing', () => {
  it.each(REFUSALS)('refuses %s', async (_label, c) => {
    const f = await frozenCart();
    const handlers = c.noPaymentSource === true ? f.as(c.actor, null) : f.as(c.actor);
    const res = await handlers.cancelPostHandoff({
      cart_id: c.cartId ?? f.cartId,
      handoff_action_id: c.handoff ?? HANDOFF,
      idempotency_key: `cancel-${c.actor.id}`,
    });
    expect(res).toEqual({ kind: 'refused', reason: c.reason });
    expectUntouched(f);
  });
});

describe('cancelPostHandoff — check and cancel are one transaction', () => {
  it('writes nothing when the cart stops being frozen before the update lands', async () => {
    const f = await frozenCart();
    // The payment-status read runs inside the cancel transaction; simulate a
    // concurrent close of the cart at exactly that point.
    const racing = (): CartPaymentStatus => {
      f.db.run(`UPDATE carts SET state = 'cancelled' WHERE cart_id = ?`, [f.cartId]);
      return 'none';
    };
    const res = await f.as(manager, racing).cancelPostHandoff({
      cart_id: f.cartId,
      handoff_action_id: HANDOFF,
      idempotency_key: 'cancel-race',
    });
    expect(res).toEqual({ kind: 'refused', reason: 'closed' });
    expect(cancelRows(f)).toBe(0);
    expect(f.emit).not.toHaveBeenCalled();
  });
});

describe('cancelPostHandoff — the real payments record blocks the cancel', () => {
  function insertAttempt(f: Fixture, id: string): void {
    bindPaymentAttemptsRepository(makeSqlJsHandle(f.db)).insert({
      payment_attempt_id: id,
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: `terminal-${id}`,
      acting_operator_id: 'op-1',
      operator_session_id: 'sess-cashier',
      envelope_handoff_action_id: HANDOFF,
      envelope_cart_id: f.cartId,
      envelope_subtotal_minor: 0,
      started_at: '2026-09-25T09:01:00.000Z',
      last_action_id: `action-${id}`,
    });
  }

  it.each(['started', 'settled', 'force_failed'] as const)(
    'refuses closed while an attempt for the cart is %s',
    async (attemptState) => {
      const f = await frozenCart();
      insertAttempt(f, 'a1');
      if (attemptState !== 'started') {
        f.db.run(
          `UPDATE payment_attempts SET state = ?, settled_at = ?, force_failed_at = ?,
             failure_reason = ?, force_fail_attribution_operator_id = ? WHERE payment_attempt_id = 'a1'`,
          attemptState === 'settled'
            ? ['settled', '2026-09-25T09:02:00.000Z', null, null, null]
            : ['force_failed', null, '2026-09-25T09:02:00.000Z', 'internal_error', 'mgr-1'],
        );
      }
      const res = await f
        .as(manager, bindCartPaymentStatus(makeSqlJsHandle(f.db)))
        .cancelPostHandoff({ cart_id: f.cartId, handoff_action_id: HANDOFF, idempotency_key: 'c' });
      expect(res).toEqual({ kind: 'refused', reason: 'closed' });
      expectUntouched(f);
    },
  );

  it('cancels when the only attempt for the cart was cancelled', async () => {
    const f = await frozenCart();
    insertAttempt(f, 'a1');
    f.db.run(
      `UPDATE payment_attempts SET state = 'cancelled', cancelled_at = ? WHERE payment_attempt_id = 'a1'`,
      ['2026-09-25T09:02:00.000Z'],
    );
    const res = await f
      .as(manager, bindCartPaymentStatus(makeSqlJsHandle(f.db)))
      .cancelPostHandoff({ cart_id: f.cartId, handoff_action_id: HANDOFF, idempotency_key: 'c' });
    expect(res).toEqual({ kind: 'ok' });
    expect(state(f)).toBe('cancelled');
  });
});
