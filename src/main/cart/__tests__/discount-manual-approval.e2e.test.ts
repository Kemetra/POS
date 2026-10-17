/**
 * RT-608 (RT-28, spec 005 FR-023 revised) — manager-only manual discounts on
 * the RT-114 Manager Approval PIN, end to end over the full migration stack
 * (sql.js): the real manager PIN store (MA-1, real Argon2id), the real
 * approval service (MA-2) with the `cart.discount.manual` resolver, and the
 * real cart bridge (`discountPlaceholdersAdd` / `discountPlaceholdersRemove`).
 *
 *   • resolver: the requesting session's own mutable cart and live line; the
 *     version binds cart, line, `placeholder_kind`, line version and scope;
 *     amount null (O1); null for anyone else's cart, a frozen cart or a
 *     missing / removed line;
 *   • add: no threshold. A cashier needs an approval for ANY discount, even
 *     1%; a valid one is consumed exactly once, in the add's own transaction,
 *     and recorded as the approver; every mismatch refuses and writes
 *     nothing; an exact replay returns the original outcome without
 *     re-consuming; a manager / admin applies directly (D2);
 *   • remove: allowed for every role (D4).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import { createManagerPinStore, type ManagerPinStore } from '../../operator/manager-pin-store.js';
import {
  APPROVAL_TTL_MS,
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../../operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { CartBridgeHandlers, type ItemRefResolver } from '../cart-bridge.js';
import { bindCartStore, type CartStore } from '../cart-store.js';
import { manualDiscountApprovalResolver } from '../discount-approval.js';
import {
  discountApprovalSubjectRef,
  parseDiscountApprovalSubjectRef,
} from '../../../shared/cart/discount-approval.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { ManagerApprovalRequest } from '../../../shared/operator/manager-approval.js';

const TERMINAL = 'term-1';
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL };
const MANAGER = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a', pin: '246810' };
const CASHIER_USER = '0190f5a2-3b4c-7d8e-9f01-0000000000cc';
const T0 = '2026-10-17T09:00:00.000Z';
const HOUR = 3_600_000;

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

const resolveItem: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

let raw: SqlJsDatabase;
let pins: ManagerPinStore;
let service: ManagerApprovalService;
let store: CartStore;
let cart: CartBridgeHandlers;
let current: OperatorSessionRecord | null;
let clock: string;
let audit: AuditEvent[];
let emitFails: boolean;
let cartId: string;
let lineId: string;
let line2Id: string;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(async () => {
  raw = freshGrantDb();
  const db = handleFor(raw);
  audit = [];
  emitFails = false;
  clock = T0;
  current = session('cashier', 'sess-cashier');
  const emitter = {
    emit: (e: AuditEvent) => {
      if (emitFails && e.action_category.startsWith('cart.')) throw new Error('disk full');
      audit.push(e);
    },
  };
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
  store = bindCartStore(db);
  service = createManagerApprovalService({
    db,
    getSession: () => current,
    isSessionLocked: () => false,
    currentTerminalId: () => TERMINAL,
    managerPins: pins,
    resolvers: { 'cart.discount.manual': manualDiscountApprovalResolver(store) },
    auditEmitter: emitter,
    now: () => clock,
  });
  cart = new CartBridgeHandlers({
    getCurrentSession: () => current,
    getTerminalId: () => TERMINAL,
    cartStore: store,
    resolveItemRef: resolveItem,
    auditEmitter: emitter as never,
    cartPaymentStatus: () => 'none',
    approvals: service,
    clock: () => new Date(clock),
  });
  const created = await cart.create({ idempotency_key: 'create-1' });
  if (created.kind !== 'ok') throw new Error('create failed');
  cartId = created.cart_id;
  lineId = await addLine('SKU-A', 'line-add-1');
  line2Id = await addLine('SKU-B', 'line-add-2');
});

afterEach(() => {
  raw.close();
});

async function addLine(itemRef: string, key: string): Promise<string> {
  const added = await cart.linesAdd({
    cart_id: cartId,
    item_ref: itemRef,
    quantity: 1,
    idempotency_key: key,
  });
  if (added.kind !== 'ok') throw new Error(`linesAdd failed: ${added.reason}`);
  return added.line_id;
}

function managerRef(): string {
  return pins.list({ scope: SCOPE, now: T0 })[0]?.managerRef ?? '';
}

function subjectRef(line = lineId, kind = 'percent_1', cart_id = cartId): string {
  return discountApprovalSubjectRef({ cart_id, line_id: line, placeholder_kind: kind });
}

function ask(over: Partial<ManagerApprovalRequest> = {}) {
  return service.request({
    action_kind: 'cart.discount.manual',
    subject_ref: subjectRef(),
    reason_code: 'loyal_customer',
    approver_ref: managerRef(),
    pin: MANAGER.pin,
    ...over,
  });
}

async function approved(over: Partial<ManagerApprovalRequest> = {}): Promise<string> {
  const outcome = await ask(over);
  if (outcome.kind !== 'approved') throw new Error(`not approved: ${outcome.reason}`);
  return outcome.approvalId;
}

function add(over: Record<string, unknown> = {}) {
  return cart.discountPlaceholdersAdd({
    cart_id: cartId,
    line_id: lineId,
    placeholder_kind: 'percent_1',
    idempotency_key: 'dp-add-1',
    ...over,
  });
}

function count(sql: string): unknown {
  return raw.exec(sql)[0]?.values[0]?.[0];
}

function placeholders(): Record<string, unknown>[] {
  const res = raw.exec('SELECT * FROM cart_line_discount_placeholders')[0];
  if (res === undefined) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}

function consumedAt(id: string): unknown {
  return raw.exec('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id])[0]
    ?.values[0]?.[0];
}

function discountAudit(): AuditEvent[] {
  return audit.filter((e) => e.action_category.startsWith('cart.discount.'));
}

/** Nothing of the add was written. */
function expectNothingWritten(): void {
  expect(placeholders()).toEqual([]);
  expect(
    count(
      `SELECT COUNT(*) FROM cart_action_outbox WHERE action_kind = 'cart.discount_placeholder.add'`,
    ),
  ).toBe(0);
  expect(discountAudit()).toEqual([]);
}

describe('discount approval subject ref', () => {
  it('round-trips cart, line and kind', () => {
    const ref = subjectRef(lineId, 'percent_15');
    expect(parseDiscountApprovalSubjectRef(ref)).toEqual({
      cart_id: cartId,
      line_id: lineId,
      placeholder_kind: 'percent_15',
    });
  });

  it.each([['no-separators'], ['only_one'], ['a__b'], ['_x_y']])('rejects %s', (ref) => {
    expect(parseDiscountApprovalSubjectRef(ref)).toBeNull();
  });
});

describe('cart.discount.manual resolver', () => {
  const resolve = (ref: string, s = current) =>
    manualDiscountApprovalResolver(store)({ subjectRef: ref, session: s as OperatorSessionRecord });

  /** The subject's version for a ref that must resolve. */
  const versionOf = (ref: string): string => {
    const subject = resolve(ref);
    if (subject === null) throw new Error(`not approvable: ${ref}`);
    return subject.version;
  };

  it('binds cart, line, kind, line version and scope, with no amount (O1)', () => {
    expect(resolve(subjectRef())).toMatchObject({ amountMinor: null });
    const version = versionOf(subjectRef());
    for (const part of [cartId, lineId, 'percent_1', SCOPE.tenantId, SCOPE.branchId]) {
      expect(version).toContain(part);
    }
    // Another line or kind is another subject.
    expect(versionOf(subjectRef(line2Id))).not.toBe(version);
    expect(versionOf(subjectRef(lineId, 'percent_2'))).not.toBe(version);
  });

  it('moves with the line version', async () => {
    const before = resolve(subjectRef())?.version;
    await cart.linesUpdate({
      cart_id: cartId,
      line_id: lineId,
      op: 'increment',
      delta: 1,
      version: 1,
      idempotency_key: 'qty-1',
    });
    expect(resolve(subjectRef())?.version).not.toBe(before);
  });

  it('is null for another session, a frozen cart, a parked cart or a missing / removed line', async () => {
    expect(resolve(subjectRef(), session('cashier', 'sess-other'))).toBeNull();
    expect(resolve(subjectRef('7f3c1e2a-0b4d-4c5e-8f60-000000000999'))).toBeNull();
    expect(resolve('not-a-discount-ref')).toBeNull();
    await cart.linesRemove({
      cart_id: cartId,
      line_id: line2Id,
      version: 1,
      idempotency_key: 'rm',
    });
    expect(resolve(subjectRef(line2Id))).toBeNull();
    raw.run(`UPDATE carts SET parked_at = ? WHERE cart_id = ?`, [T0, cartId]);
    expect(resolve(subjectRef())).toBeNull();
    raw.run(`UPDATE carts SET parked_at = NULL, state = 'frozen_handed_off' WHERE cart_id = ?`, [
      cartId,
    ]);
    expect(resolve(subjectRef())).toBeNull();
  });

  it('a manager asks for nothing (C6: applies directly)', async () => {
    raw.run(`UPDATE carts SET operator_session_id = 'sess-m' WHERE cart_id = ?`, [cartId]);
    current = session('manager', 'sess-m');
    await expect(ask()).resolves.toEqual({ kind: 'refused', reason: 'not_applicable' });
  });

  it('refuses the approver who is the requester (four-eyes)', async () => {
    current = { ...session('cashier', 'sess-cashier'), user_id: MANAGER.userId };
    await expect(ask()).resolves.toEqual({ kind: 'refused', reason: 'approval_unavailable' });
  });
});

describe('cart.discountPlaceholders.add — cashier session', () => {
  it('refuses ANY discount without an approval, even 1% (no threshold)', async () => {
    for (const kind of ['percent_1', 'percent_10', 'percent_50', 'fixed_note']) {
      await expect(add({ placeholder_kind: kind, idempotency_key: `k-${kind}` })).resolves.toEqual({
        kind: 'refused',
        reason: 'manager_attribution_required',
      });
    }
    expectNothingWritten();
  });

  it('a valid approval applies, is consumed once in the same transaction and names the approver', async () => {
    const id = await approved();
    audit = [];
    await expect(add({ approval_id: id })).resolves.toEqual({
      kind: 'ok',
      placeholder_id: 'dp-add-1',
      requires_manager_attribution: true,
    });
    expect(consumedAt(id)).toBe(T0);
    expect(placeholders()).toEqual([
      expect.objectContaining({
        placeholder_id: 'dp-add-1',
        cart_id: cartId,
        line_id: lineId,
        placeholder_kind: 'percent_1',
        requires_manager_attribution: 1,
        attribution_operator_id: MANAGER.userId,
      }),
    ]);
    const outbox = raw.exec(
      `SELECT acting_operator_id, attribution_operator_id FROM cart_action_outbox
        WHERE action_id = 'dp-add-1'`,
    )[0]?.values[0];
    expect(outbox).toEqual(['op-sess-cashier', MANAGER.userId]);
    expect(discountAudit()).toEqual([
      expect.objectContaining({
        action_category: 'cart.discount.manager_authorized',
        acting_operator_id: 'op-sess-cashier',
        approving_supervisor_id: MANAGER.userId,
        payload: {
          cart_id: cartId,
          cart_line_id: lineId,
          placeholder_id: 'dp-add-1',
          approval_id: id,
          reason_code: 'loyal_customer',
        },
      }),
    ]);
  });

  it('never emits the historical above_threshold category, and no PIN anywhere', async () => {
    const id = await approved({ subject_ref: subjectRef(lineId, 'percent_50') });
    await add({ placeholder_kind: 'percent_50', approval_id: id });
    expect(audit.map((e) => e.action_category)).not.toContain('cart.discount.above_threshold');
    const dump = JSON.stringify([
      audit,
      raw.exec('SELECT * FROM cart_action_outbox'),
      placeholders(),
    ]);
    expect(dump).not.toContain(MANAGER.pin);
  });

  it('works offline inside the RT-114 window (O3, C5) and not after it', async () => {
    // No backend is involved: the PIN is verified locally against MA-1.
    clock = new Date(Date.parse(T0) + 23 * HOUR).toISOString();
    const id = await approved();
    await expect(add({ approval_id: id })).resolves.toMatchObject({ kind: 'ok' });
    clock = new Date(Date.parse(T0) + 25 * HOUR).toISOString();
    await expect(ask({ subject_ref: subjectRef(line2Id) })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_unavailable',
    });
  });

  it('an expired approval refuses approval_invalid and writes nothing', async () => {
    const id = await approved();
    clock = new Date(Date.parse(T0) + APPROVAL_TTL_MS + 1).toISOString();
    await expect(add({ approval_id: id })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expectNothingWritten();
    expect(consumedAt(id)).toBeNull();
  });

  it('an approval is used once', async () => {
    const id = await approved();
    await add({ approval_id: id });
    await expect(add({ approval_id: id, idempotency_key: 'dp-add-2' })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expect(placeholders()).toHaveLength(1);
  });

  it('an unknown approval_id refuses approval_invalid', async () => {
    await expect(add({ approval_id: '0190f5a2-3b4c-7d8e-9f01-0000000000ff' })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expectNothingWritten();
  });

  it('a wrong-kind approval (cart.cancel_post_handoff) on the same subject refuses', async () => {
    // Approvals are append-only: forge the other kind as its own row, bound to
    // this very subject, version and requester.
    const granted = await approved();
    const res = raw.exec('SELECT * FROM manager_approvals WHERE approval_id = ?', [granted])[0];
    if (res === undefined) throw new Error('no approval row');
    const row = Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i] ?? null]));
    const id = '0190f5a2-3b4c-7d8e-9f01-0000000000ee';
    const cols = Object.keys(row);
    raw.run(
      `INSERT INTO manager_approvals (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) =>
        c === 'approval_id' ? id : c === 'action_kind' ? 'cart.cancel_post_handoff' : row[c],
      ) as never,
    );
    await expect(add({ approval_id: id })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expectNothingWritten();
    expect(consumedAt(id)).toBeNull();
  });

  it.each([
    ['another line', (): Record<string, unknown> => ({ line_id: line2Id })],
    [
      'another placeholder_kind',
      (): Record<string, unknown> => ({ placeholder_kind: 'percent_2' }),
    ],
  ])('an approval spent on %s refuses approval_invalid', async (_l, over) => {
    const id = await approved();
    await expect(add({ ...over(), approval_id: id })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expectNothingWritten();
    expect(consumedAt(id)).toBeNull();
  });

  it('an approval spent on another cart refuses approval_invalid', async () => {
    const id = await approved();
    // A second editing cart of the same session, with its own line.
    raw.run(`UPDATE carts SET state = 'cancelled' WHERE cart_id = ?`, [cartId]);
    const other = await cart.create({ idempotency_key: 'create-2' });
    if (other.kind !== 'ok') throw new Error('create failed');
    const otherCart = other.cart_id;
    const otherLine = await cart.linesAdd({
      cart_id: otherCart,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'other-line',
    });
    if (otherLine.kind !== 'ok') throw new Error('linesAdd failed');
    await expect(
      add({ cart_id: otherCart, line_id: otherLine.line_id, approval_id: id }),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
    expect(consumedAt(id)).toBeNull();
  });

  it('a line changed since the approval refuses approval_stale and writes nothing', async () => {
    const id = await approved();
    await cart.linesUpdate({
      cart_id: cartId,
      line_id: lineId,
      op: 'increment',
      delta: 1,
      version: 1,
      idempotency_key: 'qty-1',
    });
    await expect(add({ approval_id: id })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_stale',
    });
    expectNothingWritten();
    expect(consumedAt(id)).toBeNull();
  });

  it('a line removed since the approval refuses and writes nothing', async () => {
    const id = await approved();
    await cart.linesRemove({ cart_id: cartId, line_id: lineId, version: 1, idempotency_key: 'rm' });
    const outcome = await add({ approval_id: id });
    expect(outcome.kind).toBe('refused');
    expectNothingWritten();
    expect(consumedAt(id)).toBeNull();
  });

  it('another cashier cannot use an approval granted to this one (wrong requester)', async () => {
    const id = await approved();
    raw.run(`UPDATE carts SET operator_session_id = 'sess-other' WHERE cart_id = ?`, [cartId]);
    current = { ...session('cashier', 'sess-other'), user_id: 'another-cashier' };
    await expect(add({ approval_id: id })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expectNothingWritten();
  });

  it('a failing audit write rolls everything back, the approval unconsumed', async () => {
    const id = await approved();
    emitFails = true;
    await expect(add({ approval_id: id })).rejects.toThrow('disk full');
    expectNothingWritten();
    expect(consumedAt(id)).toBeNull();
  });

  it('an exact replay returns the original outcome without re-consuming', async () => {
    const id = await approved();
    const first = await add({ approval_id: id });
    expect(first.kind).toBe('ok');
    // The response was lost: the renderer retries with the same key (with or
    // without the now-consumed approval).
    await expect(add({ approval_id: id })).resolves.toEqual(first);
    await expect(add()).resolves.toEqual(first);
    expect(placeholders()).toHaveLength(1);
    expect(discountAudit()).toHaveLength(1);
    expect(consumedAt(id)).toBe(T0);
  });

  it('a key reused for another line or kind is idempotency_payload_mismatch', async () => {
    const id = await approved();
    await add({ approval_id: id });
    await expect(add({ line_id: line2Id })).resolves.toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
    await expect(add({ placeholder_kind: 'percent_2' })).resolves.toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
  });

  it('a spoofed approver id is ignored: still refused without an approval', async () => {
    await expect(add({ attribution_operator_id: MANAGER.userId })).resolves.toEqual({
      kind: 'refused',
      reason: 'manager_attribution_required',
    });
    expectNothingWritten();
  });
});

describe('cart.discountPlaceholders.add — manager / admin session (D2)', () => {
  beforeEach(() => {
    raw.run(`UPDATE carts SET operator_session_id = 'sess-m' WHERE cart_id = ?`, [cartId]);
  });

  it.each([['manager'], ['admin']] as const)(
    'a %s applies directly and is recorded as the approver',
    async (role) => {
      current = { ...session(role, 'sess-m'), manager_user_id: MANAGER.userId.toUpperCase() };
      await expect(add()).resolves.toEqual({
        kind: 'ok',
        placeholder_id: 'dp-add-1',
        requires_manager_attribution: true,
      });
      expect(placeholders()[0]).toMatchObject({
        requires_manager_attribution: 1,
        attribution_operator_id: MANAGER.userId,
      });
      expect(discountAudit()).toEqual([
        expect.objectContaining({
          action_category: 'cart.discount.manager_authorized',
          acting_operator_id: 'op-sess-m',
          approving_supervisor_id: MANAGER.userId,
          payload: { cart_id: cartId, cart_line_id: lineId, placeholder_id: 'dp-add-1' },
        }),
      ]);
    },
  );

  it('a spoofed approver id is ignored: the session is the approver', async () => {
    current = session('manager', 'sess-m');
    await add({ attribution_operator_id: 'someone-else' });
    expect(placeholders()[0]?.['attribution_operator_id']).toBe('op-sess-m');
    expect(discountAudit()[0]?.approving_supervisor_id).toBe('op-sess-m');
  });

  it('a missing line is refused and writes nothing', async () => {
    current = session('manager', 'sess-m');
    await expect(add({ line_id: '7f3c1e2a-0b4d-4c5e-8f60-000000000999' })).resolves.toEqual({
      kind: 'refused',
      reason: 'wrong_owner',
    });
    expectNothingWritten();
  });
});

describe('cart.discountPlaceholders.remove (D4)', () => {
  it('a cashier removes an approved discount with no manager; outbox only, no audit row', async () => {
    const id = await approved();
    await add({ approval_id: id });
    audit = [];
    await expect(
      cart.discountPlaceholdersRemove({
        cart_id: cartId,
        placeholder_id: 'dp-add-1',
        idempotency_key: 'dp-rm-1',
      }),
    ).resolves.toEqual({ kind: 'ok' });
    expect(placeholders()).toEqual([]);
    expect(
      raw.exec(
        `SELECT action_kind, acting_operator_id FROM cart_action_outbox WHERE action_id = 'dp-rm-1'`,
      )[0]?.values[0],
    ).toEqual(['cart.discount_placeholder.remove', 'op-sess-cashier']);
    expect(audit).toEqual([]);
  });
});
