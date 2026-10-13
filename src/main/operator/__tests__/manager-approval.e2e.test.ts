/**
 * RT-443 (MA-2, RT-114 C6–C10) — a cashier's post-handoff cancel with a
 * manager approval, end to end over the full migration stack (sql.js): the
 * real manager PIN store (MA-1, real Argon2id), the real approval service and
 * the real cart bridge (`cancelPostHandoff`).
 *
 *   • request: session gates, C6 (a manager asks for nothing), an unknown or
 *     not-approvable subject, a generic refusal for any PIN / approver failure
 *     (audited, no PIN), four-eyes, staleness after the PIN's await, and a
 *     granted row bound to the cart's handoff and subtotal (audited);
 *   • cancel: a cashier needs an approval; a valid one cancels and is
 *     consumed in the same transaction, recorded as the approver; a used,
 *     expired, foreign or stale one refuses and rolls the cancel back,
 *     leaving the cart frozen and the approval unconsumed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from './__helpers__/offline-grant-fixture.js';
import { createManagerPinStore, type ManagerPinStore } from '../manager-pin-store.js';
import {
  APPROVAL_TTL_MS,
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../manager-approval-service.js';
import type { OperatorSessionRecord } from '../session-manager.js';
import { CartBridgeHandlers } from '../../cart/cart-bridge.js';
import { bindCartStore } from '../../cart/cart-store.js';
import { postHandoffCancelApprovalResolver } from '../../cart/post-handoff-approval.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { ManagerApprovalRequest } from '../../../shared/operator/manager-approval.js';

const TERMINAL = 'term-1';
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL };
const MANAGER = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a', pin: '246810' };
const CASHIER_USER = '0190f5a2-3b4c-7d8e-9f01-0000000000cc';
const T0 = '2026-10-13T09:00:00.000Z';

function session(role: OperatorSessionRecord['role'], id: string): OperatorSessionRecord {
  return {
    id,
    operator_id: `op-${id}`,
    display_name: 'Test Operator',
    role,
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    started_at: T0,
    backend_session_id: `b-${id}`,
    last_activity_at: T0,
    lock_state: 'active',
    locked_at: null,
    ...(role === 'cashier' ? { user_id: CASHIER_USER } : {}),
  };
}

let raw: SqlJsDatabase;
let pins: ManagerPinStore;
let service: ManagerApprovalService;
let cart: CartBridgeHandlers;
let current: OperatorSessionRecord | null;
let locked: boolean;
let clock: string;
let audit: AuditEvent[];
let cartId: string;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(async () => {
  raw = freshGrantDb();
  const db = handleFor(raw);
  audit = [];
  clock = T0;
  locked = false;
  const cashier = session('cashier', 'sess-cashier');
  current = cashier;
  const emitter = { emit: (e: AuditEvent) => audit.push(e) };
  pins = createManagerPinStore({ db, safeStorage: aeadSafeStorage() });
  await pins.enrol({
    scope: SCOPE,
    userId: MANAGER.userId,
    displayName: 'Mona Manager',
    sealed: await pins.seal(MANAGER.pin),
    now: T0,
    onlineAt: T0,
    guard: () => undefined,
  });
  const store = bindCartStore(db);
  service = createManagerApprovalService({
    db,
    getSession: () => current,
    isSessionLocked: () => locked,
    currentTerminalId: () => TERMINAL,
    managerPins: pins,
    resolvers: { 'cart.cancel_post_handoff': postHandoffCancelApprovalResolver(store) },
    auditEmitter: emitter,
    now: () => clock,
  });
  cart = new CartBridgeHandlers({
    getCurrentSession: () => current,
    getTerminalId: () => TERMINAL,
    cartStore: store,
    auditEmitter: emitter as never,
    cartPaymentStatus: () => 'none',
    approvals: service,
    clock: () => new Date(clock),
  });
  const created = await cart.create({ idempotency_key: 'create-1' });
  if (created.kind !== 'ok') throw new Error('create failed');
  cartId = created.cart_id;
  raw.run(
    `UPDATE carts SET state = 'frozen_handed_off', cart_subtotal_minor = 12500,
            handoff_envelope_json = ? WHERE cart_id = ?`,
    [
      JSON.stringify({ handoff_action_id: 'handoff-1', lines: [], discount_placeholders: [] }),
      cartId,
    ],
  );
});

afterEach(() => {
  raw.close();
});

function managerRef(): string {
  return pins.list({ scope: SCOPE, now: T0 })[0]?.managerRef ?? '';
}

function ask(over: Partial<ManagerApprovalRequest> = {}) {
  return service.request({
    action_kind: 'cart.cancel_post_handoff',
    subject_ref: cartId,
    reason_code: 'customer_left',
    approver_ref: managerRef(),
    pin: MANAGER.pin,
    ...over,
  });
}

function cancel(approvalId?: string) {
  return cart.cancelPostHandoff({
    cart_id: cartId,
    handoff_action_id: 'handoff-1',
    idempotency_key: `cancel-${approvalId ?? 'none'}`,
    ...(approvalId === undefined ? {} : { approval_id: approvalId }),
  });
}

function cartState(): unknown {
  return raw.exec('SELECT state FROM carts WHERE cart_id = ?', [cartId])[0]?.values[0]?.[0];
}

function approvalRow(id: string): Record<string, unknown> {
  const res = raw.exec('SELECT * FROM manager_approvals WHERE approval_id = ?', [id])[0];
  if (res === undefined) return {};
  return Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i]]));
}

async function approved(): Promise<string> {
  const outcome = await ask();
  if (outcome.kind !== 'approved') throw new Error(`not approved: ${outcome.reason}`);
  return outcome.approvalId;
}

describe('approval.request', () => {
  it('grants one row bound to the cart’s handoff and subtotal, expiring after 120 s, audited without the PIN', async () => {
    const id = await approved();
    expect(approvalRow(id)).toMatchObject({
      tenant_id: SCOPE.tenantId,
      terminal_id: TERMINAL,
      action_kind: 'cart.cancel_post_handoff',
      subject_ref: cartId,
      subject_version: 'handoff:handoff-1',
      amount_minor: 12500,
      reason_code: 'customer_left',
      requester_operator_id: 'op-sess-cashier',
      requester_user_id: CASHIER_USER,
      approver_user_id: MANAGER.userId,
      issued_at: T0,
      expires_at: new Date(Date.parse(T0) + APPROVAL_TTL_MS).toISOString(),
      consumed_at: null,
    });
    expect(audit.map((e) => e.action_category)).toEqual(['manager_approval.granted']);
    expect(audit[0]?.approving_supervisor_id).toBe(MANAGER.userId);
    expect(JSON.stringify(audit)).not.toContain(MANAGER.pin);
  });

  it.each([
    ['a wrong PIN', { pin: '864297' }],
    ['an unknown approver', { approver_ref: '7f3c1e2a-0b4d-4c5e-8f60-000000000999' }],
  ])('answers %s with the generic approval_unavailable, audited as refused', async (_l, over) => {
    await expect(ask(over)).resolves.toEqual({ kind: 'refused', reason: 'approval_unavailable' });
    expect(audit.map((e) => e.action_category)).toEqual(['manager_approval.refused']);
    expect(JSON.stringify(audit)).not.toContain('864297');
  });

  it('refuses the approver who is the requester (four-eyes)', async () => {
    current = { ...session('cashier', 'sess-cashier'), user_id: MANAGER.userId };
    await expect(ask()).resolves.toEqual({ kind: 'refused', reason: 'approval_unavailable' });
  });

  it('refuses a revoked approver like any other', async () => {
    const ref = managerRef();
    await pins.revoke({
      scope: SCOPE,
      target: { userId: MANAGER.userId },
      requesterUserId: MANAGER.userId,
      now: T0,
    });
    await expect(ask({ approver_ref: ref })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_unavailable',
    });
    // The same handle and PIN were good before the revocation (control).
    expect(ref).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the approval policy: an approver last online over 24 h ago is unavailable', async () => {
    const ref = managerRef();
    clock = new Date(Date.parse(T0) + 24 * 60 * 60 * 1000 + 1).toISOString();
    await expect(ask({ approver_ref: ref })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_unavailable',
    });
  });

  it.each([
    [
      'no session',
      () => {
        current = null;
      },
      'no_session',
    ],
    [
      'a locked session',
      () => {
        locked = true;
      },
      'session_locked',
    ],
    [
      'a manager session (acts directly, C6)',
      () => {
        current = session('manager', 'sess-m');
      },
      'not_applicable',
    ],
  ] as const)('refuses %s before the PIN', async (_l, arrange, reason) => {
    const ref = managerRef();
    arrange();
    await expect(ask({ approver_ref: ref })).resolves.toEqual({ kind: 'refused', reason });
    expect(audit).toEqual([]);
  });

  it('refuses a kind without a resolver yet as not_applicable', async () => {
    await expect(ask({ action_kind: 'recovery.cancel_held_cart' })).resolves.toEqual({
      kind: 'refused',
      reason: 'not_applicable',
    });
  });

  it('refuses a subject that is unknown, not frozen, or another session’s', async () => {
    await expect(ask({ subject_ref: 'no-such-cart' })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    current = session('cashier', 'sess-other');
    await expect(ask()).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
    current = session('cashier', 'sess-cashier');
    raw.run(`UPDATE carts SET state = 'editing' WHERE cart_id = ?`, [cartId]);
    await expect(ask()).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });

  it('refuses approval_stale when the cart changes during the PIN check, writing no row', async () => {
    const realVerify = pins.verify.bind(pins);
    const spy = vi.spyOn(pins, 'verify').mockImplementationOnce(async (input) => {
      raw.run(`UPDATE carts SET cart_subtotal_minor = 99 WHERE cart_id = ?`, [cartId]);
      return realVerify(input);
    });
    await expect(ask()).resolves.toEqual({ kind: 'refused', reason: 'approval_stale' });
    expect(raw.exec('SELECT COUNT(*) FROM manager_approvals')[0]?.values[0]?.[0]).toBe(0);
    spy.mockRestore();
  });
});

describe('cart.cancelPostHandoff with an approval', () => {
  it('a cashier without an approval is refused, as before', async () => {
    await expect(cancel()).resolves.toEqual({
      kind: 'refused',
      reason: 'manager_attribution_required',
    });
    expect(cartState()).toBe('frozen_handed_off');
  });

  it('a valid approval cancels, is consumed in the same transaction and names the approver', async () => {
    const id = await approved();
    audit = [];
    await expect(cancel(id)).resolves.toEqual({ kind: 'ok' });
    expect(cartState()).toBe('cancelled');
    expect(approvalRow(id)['consumed_at']).toBe(T0);
    const event = audit.find((e) => e.action_category === 'cart.cancel.post_handoff');
    expect(event).toMatchObject({
      acting_operator_id: 'op-sess-cashier',
      approving_supervisor_id: MANAGER.userId,
      payload: { cart_id: cartId, handoff_action_id: 'handoff-1', approval_id: id },
    });
  });

  it('an approval is used once', async () => {
    const id = await approved();
    await cancel(id);
    // A second cart, frozen the same way, cannot reuse it.
    const other = await cart.create({ idempotency_key: 'create-2' });
    if (other.kind !== 'ok') throw new Error('create failed');
    raw.run(
      `UPDATE carts SET state = 'frozen_handed_off', handoff_envelope_json = ? WHERE cart_id = ?`,
      [
        JSON.stringify({ handoff_action_id: 'h-2', lines: [], discount_placeholders: [] }),
        other.cart_id,
      ],
    );
    await expect(
      cart.cancelPostHandoff({
        cart_id: other.cart_id,
        handoff_action_id: 'h-2',
        idempotency_key: 'cancel-other',
        approval_id: id,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });

  it('an expired approval refuses and rolls back: cart frozen, approval unconsumed, no outbox row', async () => {
    const id = await approved();
    clock = new Date(Date.parse(T0) + APPROVAL_TTL_MS + 1).toISOString();
    await expect(cancel(id)).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
    expect(cartState()).toBe('frozen_handed_off');
    expect(approvalRow(id)['consumed_at']).toBeNull();
    expect(
      raw.exec(
        `SELECT COUNT(*) FROM cart_action_outbox WHERE action_kind = 'cart.cancel.post_handoff'`,
      )[0]?.values[0]?.[0],
    ).toBe(0);
  });

  it('a cart changed since the approval refuses approval_stale and rolls back', async () => {
    const id = await approved();
    raw.run(`UPDATE carts SET cart_subtotal_minor = 99 WHERE cart_id = ?`, [cartId]);
    await expect(cancel(id)).resolves.toEqual({ kind: 'refused', reason: 'approval_stale' });
    expect(cartState()).toBe('frozen_handed_off');
    expect(approvalRow(id)['consumed_at']).toBeNull();
  });

  it('another cashier cannot use an approval granted to this one', async () => {
    const id = await approved();
    // The other cashier's session owns the cart for the gate's sake, but the
    // approval names its requester.
    raw.run(`UPDATE carts SET operator_session_id = 'sess-other' WHERE cart_id = ?`, [cartId]);
    current = session('cashier', 'sess-other');
    await expect(cancel(id)).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });

  it('a manager still cancels directly, with no approval', async () => {
    raw.run(`UPDATE carts SET operator_session_id = 'sess-m' WHERE cart_id = ?`, [cartId]);
    current = session('manager', 'sess-m');
    await expect(cancel()).resolves.toEqual({ kind: 'ok' });
  });
});

describe('consume — one refusal per binding (RT-443 acceptance)', () => {
  function consumeWith(
    id: string,
    over: Partial<Parameters<typeof service.consume>[0]> = {},
  ): ReturnType<typeof service.consume> {
    if (current === null) throw new Error('no session');
    return service.consume({
      approvalId: id,
      actionKind: 'cart.cancel_post_handoff',
      subjectRef: cartId,
      subject: { version: 'handoff:handoff-1', amountMinor: 12500 },
      session: current,
      ...over,
    });
  }

  it('the exact binding consumes', async () => {
    const id = await approved();
    expect(consumeWith(id)).toEqual({ kind: 'consumed', approverUserId: MANAGER.userId });
  });

  it('a wrong kind is approval_invalid and stays unconsumed', async () => {
    const id = await approved();
    expect(consumeWith(id, { actionKind: 'shift.pay_out' })).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(approvalRow(id)['consumed_at']).toBeNull();
  });

  it('a wrong subject is approval_invalid', async () => {
    const id = await approved();
    expect(consumeWith(id, { subjectRef: 'another-cart' })).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
  });

  it('a stale version is approval_stale', async () => {
    const id = await approved();
    expect(
      consumeWith(id, { subject: { version: 'handoff:handoff-2', amountMinor: 12500 } }),
    ).toEqual({ kind: 'refused', reason: 'approval_stale' });
  });

  it('an amount mismatch is approval_stale', async () => {
    const id = await approved();
    expect(
      consumeWith(id, { subject: { version: 'handoff:handoff-1', amountMinor: 12499 } }),
    ).toEqual({ kind: 'refused', reason: 'approval_stale' });
  });

  it('an already consumed approval is approval_invalid', async () => {
    const id = await approved();
    consumeWith(id);
    expect(consumeWith(id)).toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });
});
