/**
 * RT-854 (RT-699 I1; doc 28 §3, §4, §7, §8) — the manual discount made real
 * in main, end to end over the full migration stack (sql.js) with the real
 * manager PIN store, approval service and cart bridge:
 *
 *   • the approval binds the computed amount (`amountMinor`) and the token, so
 *     an approval for 10% can never be spent on 20%;
 *   • `approval.request` for `cart.discount.manual` takes only a reason from
 *     the closed list (§11.2); a cashier's add may restate it, and must match;
 *   • a manager / admin add carries a validated `reason_code` (§4.2) and
 *     records its own role as `approver_role` in the audit payload;
 *   • refusals: a non-canonical token or an amount above the gross
 *     (`invalid_payload`), a second discount on a line
 *     (`discount_already_applied`), a quantity change on a discounted line
 *     (`line_discounted`);
 *   • the reason and the token are part of the add's replay identity;
 *   • the handoff envelope carries `discount_total_minor` / `total_due_minor`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { AuditEmitter } from '../../audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../audit/audit-events-store.js';
import type { CartBridgeHandlers } from '../cart-bridge.js';
import type { CartStore } from '../cart-store.js';
import { manualDiscountApprovalResolver } from '../discount-approval.js';
import { discountApprovalSubjectRef } from '../../../shared/cart/discount-approval.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { ManagerApprovalRequest } from '../../../shared/operator/manager-approval.js';
import {
  bootDiscountHarness,
  cartWithLines,
  type DiscountHarness,
} from './__helpers__/discount-harness.js';

const TERMINAL = 'term-1';
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL };
const MANAGER = {
  userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a',
  pin: '246810',
  displayName: 'Mona Manager',
};
const CASHIER_USER = '0190f5a2-3b4c-7d8e-9f01-0000000000cc';
const T0 = '2026-10-24T09:00:00.000Z';
/** Every line: 2 × 45.00, gross 9000 minor units. */
const UNIT_PRICE = 4500;
const QTY = 2;
const GROSS = UNIT_PRICE * QTY;

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
let h: DiscountHarness;
let store: CartStore;
let cart: CartBridgeHandlers;
let current: OperatorSessionRecord | null;
let audit: AuditEvent[];
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
  current = session('cashier', 'sess-cashier');
  // The real emitter too: the RT-614 trust check reads `audit_events`.
  const durable = new AuditEmitter(bindAuditEventsStoreDb(db));
  h = await bootDiscountHarness({
    db,
    terminalId: TERMINAL,
    scope: SCOPE,
    manager: MANAGER,
    enrolledAt: T0,
    unitPriceMinor: UNIT_PRICE,
    getSession: () => current,
    now: () => T0,
    audit: {
      emit: (e) => {
        durable.emit(e);
        audit.push(e);
      },
    },
  });
  ({ store, cart } = h);
  const built = await cartWithLines(cart, ['SKU-A', 'SKU-B'], QTY);
  cartId = built.cartId;
  [lineId = '', line2Id = ''] = built.lineIds;
});

afterEach(() => {
  raw.close();
});

function subjectRef(kind = 'manual_pct_10', line = lineId): string {
  return discountApprovalSubjectRef({ cart_id: cartId, line_id: line, placeholder_kind: kind });
}

function ask(over: Partial<ManagerApprovalRequest> = {}) {
  return h.ask({ subject_ref: subjectRef(), reason_code: 'promotion', ...over });
}

async function approved(over: Partial<ManagerApprovalRequest> = {}): Promise<string> {
  const outcome = await ask(over);
  if (outcome.kind !== 'approved') throw new Error(`not approved: ${outcome.reason}`);
  return outcome.approvalId;
}

const add = (over: Record<string, unknown> = {}) =>
  cart.discountPlaceholdersAdd({
    cart_id: cartId,
    line_id: lineId,
    placeholder_kind: 'manual_pct_10',
    idempotency_key: 'dp-add-1',
    ...over,
  });

function asManager(role: 'manager' | 'admin' = 'manager'): void {
  raw.run(`UPDATE carts SET operator_session_id = 'sess-m' WHERE cart_id = ?`, [cartId]);
  current = { ...session(role, 'sess-m'), manager_user_id: MANAGER.userId };
}

function rows(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const res = raw.exec(sql, params as never)[0];
  if (res === undefined) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}

function approvalRow(id: string): Record<string, unknown> | undefined {
  return rows('SELECT * FROM manager_approvals WHERE approval_id = ?', [id])[0];
}

function discountAudit(): AuditEvent[] {
  return audit.filter((e) => e.action_category === 'cart.discount.manager_authorized');
}

function expectNoDiscountWritten(): void {
  expect(rows('SELECT * FROM cart_line_discount_placeholders')).toEqual([]);
  expect(discountAudit()).toEqual([]);
}

function update(op: Record<string, unknown>, key: string) {
  return cart.linesUpdate({
    cart_id: cartId,
    line_id: lineId,
    version: 1,
    idempotency_key: key,
    ...op,
  } as never);
}

describe('the approval binds the computed amount (doc 28 §3.1)', () => {
  const resolve = (ref: string) =>
    manualDiscountApprovalResolver(store)({
      subjectRef: ref,
      session: current as OperatorSessionRecord,
    });

  it('amountMinor is the discount on the line gross, and the version carries it', () => {
    const pct = resolve(subjectRef('manual_pct_10'));
    expect(pct?.amountMinor).toBe(900);
    expect(pct?.version).toContain('a900');
    expect(resolve(subjectRef('manual_amt_250'))?.amountMinor).toBe(250);
    expect(resolve(subjectRef('manual_pct_100'))?.amountMinor).toBe(GROSS);
  });

  it('is not approvable for a non-canonical token or an amount above the gross', () => {
    expect(resolve(subjectRef('percent_10'))).toBeNull();
    expect(resolve(subjectRef('manual_pct_010'))).toBeNull();
    expect(resolve(subjectRef(`manual_amt_${String(GROSS + 1)}`))).toBeNull();
  });

  it('the granted approval row stores the amount', async () => {
    const id = await approved();
    expect(approvalRow(id)).toMatchObject({ amount_minor: 900, reason_code: 'promotion' });
  });

  it('an approval for 10% cannot be spent on 20%', async () => {
    const id = await approved();
    await expect(add({ placeholder_kind: 'manual_pct_20', approval_id: id })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expectNoDiscountWritten();
    expect(approvalRow(id)?.['consumed_at']).toBeNull();
  });
});

describe('approval.request — the closed reason list for cart.discount.manual (§11.2)', () => {
  it.each([
    'promotion',
    'loyal_or_contract_customer',
    'near_expiry_or_damaged',
    'price_correction',
  ])('grants %s', async (reason) => {
    await expect(ask({ reason_code: reason })).resolves.toMatchObject({ kind: 'approved' });
  });

  it.each(['loyal_customer', 'customer_left', 'other'])(
    'refuses %s with invalid_input and grants nothing',
    async (reason) => {
      await expect(ask({ reason_code: reason })).resolves.toEqual({
        kind: 'refused',
        reason: 'invalid_input',
      });
      expect(rows('SELECT * FROM manager_approvals')).toEqual([]);
    },
  );
});

describe('cashier path: the approval carries the value and the reason', () => {
  it('applies the approved amount; the audit row carries kind, value, amount and reason', async () => {
    const id = await approved({ reason_code: 'near_expiry_or_damaged' });
    await expect(add({ approval_id: id })).resolves.toEqual({
      kind: 'ok',
      placeholder_id: 'dp-add-1',
      requires_manager_attribution: true,
    });
    expect(approvalRow(id)?.['consumed_at']).toBe(T0);
    expect(discountAudit()).toEqual([
      expect.objectContaining({
        acting_operator_id: 'op-sess-cashier',
        approving_supervisor_id: MANAGER.userId,
        payload: {
          cart_id: cartId,
          cart_line_id: lineId,
          placeholder_id: 'dp-add-1',
          approval_id: id,
          reason_code: 'near_expiry_or_damaged',
          kind: 'percent',
          value: 10,
          amount_minor: 900,
        },
      }),
    ]);
  });

  it('an amount discount records value = amount_minor', async () => {
    const id = await approved({ subject_ref: subjectRef('manual_amt_250') });
    await add({ placeholder_kind: 'manual_amt_250', approval_id: id });
    expect(discountAudit()[0]?.payload).toMatchObject({
      kind: 'amount',
      value: 250,
      amount_minor: 250,
    });
  });

  it('a restated reason equal to the approval’s applies', async () => {
    const id = await approved();
    await expect(add({ approval_id: id, reason_code: 'promotion' })).resolves.toMatchObject({
      kind: 'ok',
    });
  });

  it('a restated reason that differs from the approval’s refuses approval_invalid, unconsumed', async () => {
    const id = await approved();
    await expect(add({ approval_id: id, reason_code: 'price_correction' })).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    expectNoDiscountWritten();
    expect(approvalRow(id)?.['consumed_at']).toBeNull();
  });

  it('a restated reason outside the closed list refuses invalid_payload', async () => {
    const id = await approved();
    await expect(add({ approval_id: id, reason_code: 'other' })).resolves.toEqual({
      kind: 'refused',
      reason: 'invalid_payload',
    });
    expect(approvalRow(id)?.['consumed_at']).toBeNull();
  });

  it('a 1% discount that rounds to 0 is allowed (amount 0)', async () => {
    // 1% of 9000 is 90; use an amount line to show the 0 case on a small gross.
    const resolve = manualDiscountApprovalResolver(store);
    raw.run(
      `UPDATE cart_lines SET unit_price_minor = 1, line_subtotal_minor = 1, quantity = 1 WHERE line_id = ?`,
      [lineId],
    );
    expect(
      resolve({
        subjectRef: subjectRef('manual_pct_1'),
        session: current as OperatorSessionRecord,
      })?.amountMinor,
    ).toBe(0);
    const id = await approved({ subject_ref: subjectRef('manual_pct_1') });
    await expect(add({ placeholder_kind: 'manual_pct_1', approval_id: id })).resolves.toMatchObject(
      { kind: 'ok' },
    );
    expect(discountAudit()[0]?.payload).toMatchObject({ amount_minor: 0 });
  });
});

describe('manager / admin direct path (D2, §4.2)', () => {
  it.each([['manager'], ['admin']] as const)(
    'a %s applies with a reason and is recorded with its role',
    async (role) => {
      asManager(role);
      await expect(add({ reason_code: 'price_correction' })).resolves.toMatchObject({
        kind: 'ok',
      });
      expect(discountAudit()).toEqual([
        expect.objectContaining({
          acting_operator_id: 'op-sess-m',
          approving_supervisor_id: MANAGER.userId,
          payload: {
            cart_id: cartId,
            cart_line_id: lineId,
            placeholder_id: 'dp-add-1',
            reason_code: 'price_correction',
            kind: 'percent',
            value: 10,
            amount_minor: 900,
            approver_role: role,
          },
        }),
      ]);
      expect(rows('SELECT * FROM manager_approvals')).toEqual([]);
    },
  );

  it.each([[undefined], ['loyal_customer'], [''], [42]])(
    'a missing or unknown reason %j refuses invalid_payload',
    async (reason) => {
      asManager();
      await expect(add(reason === undefined ? {} : { reason_code: reason })).resolves.toEqual({
        kind: 'refused',
        reason: 'invalid_payload',
      });
      expectNoDiscountWritten();
    },
  );

  it.each([
    'percent_10',
    'manual_pct_0',
    'manual_pct_101',
    'manual_pct_010',
    'manual_amt_1.5',
    `manual_amt_${String(GROSS + 1)}`,
  ])('token %s refuses invalid_payload', async (token) => {
    asManager();
    await expect(add({ placeholder_kind: token, reason_code: 'promotion' })).resolves.toEqual({
      kind: 'refused',
      reason: 'invalid_payload',
    });
    expectNoDiscountWritten();
  });

  it('a full-gross amount gives a free line', async () => {
    asManager();
    await expect(
      add({ placeholder_kind: `manual_amt_${String(GROSS)}`, reason_code: 'promotion' }),
    ).resolves.toMatchObject({ kind: 'ok' });
    expect(discountAudit()[0]?.payload).toMatchObject({ amount_minor: GROSS });
  });
});

describe('one discount per line (OD-28-6)', () => {
  it('a second discount on the same line refuses discount_already_applied', async () => {
    asManager();
    await add({ reason_code: 'promotion' });
    await expect(
      add({
        idempotency_key: 'dp-add-2',
        placeholder_kind: 'manual_pct_5',
        reason_code: 'promotion',
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'discount_already_applied' });
    expect(rows('SELECT * FROM cart_line_discount_placeholders')).toHaveLength(1);
  });

  it('a cashier’s second discount is refused before its approval is consumed', async () => {
    const first = await approved();
    await add({ approval_id: first });
    const second = await approved({ subject_ref: subjectRef('manual_pct_5') });
    await expect(
      add({ idempotency_key: 'dp-add-2', placeholder_kind: 'manual_pct_5', approval_id: second }),
    ).resolves.toEqual({ kind: 'refused', reason: 'discount_already_applied' });
    expect(approvalRow(second)?.['consumed_at']).toBeNull();
  });

  it('after a remove (D4) the line takes a new discount', async () => {
    asManager();
    await add({ reason_code: 'promotion' });
    await cart.discountPlaceholdersRemove({
      cart_id: cartId,
      placeholder_id: 'dp-add-1',
      idempotency_key: 'dp-rm-1',
    });
    await expect(
      add({
        idempotency_key: 'dp-add-2',
        placeholder_kind: 'manual_pct_20',
        reason_code: 'promotion',
      }),
    ).resolves.toMatchObject({ kind: 'ok' });
  });

  it('another line of the cart is unaffected', async () => {
    asManager();
    await add({ reason_code: 'promotion' });
    await expect(
      add({ idempotency_key: 'dp-add-2', line_id: line2Id, reason_code: 'promotion' }),
    ).resolves.toMatchObject({ kind: 'ok' });
  });
});

describe('a quantity change on a discounted line is refused (OD-28-7)', () => {
  beforeEach(async () => {
    asManager();
    await add({ reason_code: 'promotion' });
  });

  it.each([
    ['increment', { op: 'increment' }],
    ['decrement', { op: 'decrement' }],
    ['absolute', { op: 'set', absolute: 5 }],
  ])('%s refuses line_discounted and leaves the line as it was', async (_label, op) => {
    await expect(update(op, `qty-${_label}`)).resolves.toEqual({
      kind: 'refused',
      reason: 'line_discounted',
    });
    expect(rows('SELECT quantity, version FROM cart_lines WHERE line_id = ?', [lineId])).toEqual([
      { quantity: QTY, version: 1 },
    ]);
  });

  it('re-scanning the same item onto the discounted line (merge) refuses line_discounted', async () => {
    await expect(
      cart.linesAdd({ cart_id: cartId, item_ref: 'SKU-A', quantity: 1, idempotency_key: 'rescan' }),
    ).resolves.toEqual({ kind: 'refused', reason: 'line_discounted' });
  });

  it('undoing a scan merge made before the discount is not available (the discount is the newest action)', async () => {
    await cart.discountPlaceholdersRemove({
      cart_id: cartId,
      placeholder_id: 'dp-add-1',
      idempotency_key: 'dp-rm-1',
    });
    const merged = await cart.linesAdd({
      cart_id: cartId,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'merge-1',
    });
    expect(merged).toMatchObject({ kind: 'ok', merged: true });
    await add({ idempotency_key: 'dp-add-2', reason_code: 'promotion' });
    await expect(
      cart.undoLast({ cart_id: cartId, target_action_id: 'merge-1', idempotency_key: 'undo-1' }),
    ).resolves.toEqual({ kind: 'refused', reason: 'undo_not_available' });
    expect(rows('SELECT quantity FROM cart_lines WHERE line_id = ?', [lineId])).toEqual([
      { quantity: QTY + 1 },
    ]);
  });

  it('a quantity set to 0 removes the line (a removal, not a quantity change)', async () => {
    await expect(update({ op: 'set', absolute: 0 }, 'qty-zero')).resolves.toMatchObject({
      kind: 'ok',
    });
    expect(
      rows('SELECT removed_at FROM cart_lines WHERE line_id = ?', [lineId])[0]?.['removed_at'],
    ).not.toBeNull();
  });

  it('after the discount is removed the quantity changes again', async () => {
    await cart.discountPlaceholdersRemove({
      cart_id: cartId,
      placeholder_id: 'dp-add-1',
      idempotency_key: 'dp-rm-1',
    });
    await expect(update({ op: 'increment' }, 'qty-after')).resolves.toMatchObject({ kind: 'ok' });
  });

  it('a different line still changes quantity', async () => {
    await expect(
      cart.linesUpdate({
        cart_id: cartId,
        line_id: line2Id,
        op: 'increment',
        version: 1,
        idempotency_key: 'qty-line2',
      } as never),
    ).resolves.toMatchObject({ kind: 'ok' });
  });
});

describe('replay identity carries the token and the reason (§4.1 step 5)', () => {
  it('an exact replay returns the original outcome with one placeholder and one audit row', async () => {
    asManager();
    const first = await add({ reason_code: 'promotion' });
    await expect(add({ reason_code: 'promotion' })).resolves.toEqual(first);
    expect(discountAudit()).toHaveLength(1);
  });

  it('the same key with a different reason is idempotency_payload_mismatch', async () => {
    asManager();
    await add({ reason_code: 'promotion' });
    await expect(add({ reason_code: 'price_correction' })).resolves.toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
  });

  it('a manager replay that omits the reason is idempotency_payload_mismatch (the direct path needs one)', async () => {
    asManager();
    await add({ reason_code: 'promotion' });
    await expect(add()).resolves.toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
    expect(discountAudit()).toHaveLength(1);
  });

  it('a cashier replay without restating the reason still replays', async () => {
    const id = await approved();
    const first = await add({ approval_id: id });
    await expect(add()).resolves.toEqual(first);
    await expect(add({ reason_code: 'price_correction' })).resolves.toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
  });

  it('after the placeholder is removed, the same key with another token is still a mismatch', async () => {
    asManager();
    await add({ reason_code: 'promotion' });
    await cart.discountPlaceholdersRemove({
      cart_id: cartId,
      placeholder_id: 'dp-add-1',
      idempotency_key: 'dp-rm-1',
    });
    await expect(
      add({ placeholder_kind: 'manual_pct_20', reason_code: 'promotion' }),
    ).resolves.toEqual({ kind: 'refused', reason: 'idempotency_payload_mismatch' });
  });

  it('the outbox row stores the token and the reason, no amount and no approver', async () => {
    asManager();
    await add({ reason_code: 'promotion' });
    const payload = rows(
      `SELECT payload_json FROM cart_action_outbox WHERE action_id = 'dp-add-1'`,
    )[0]?.['payload_json'];
    expect(JSON.parse(String(payload))).toEqual({
      cart_id: cartId,
      cart_line_id: lineId,
      placeholder_kind: 'manual_pct_10',
      reason_code: 'promotion',
    });
  });
});

describe('handoff envelope totals (doc 28 §3.3, v1 extension)', () => {
  function handoff(key = 'handoff-1') {
    return cart.handoff({
      cart_id: cartId,
      per_line_versions: [
        { line_id: lineId, version: 1 },
        { line_id: line2Id, version: 1 },
      ],
      idempotency_key: key,
    });
  }

  it('without a discount, discount 0 and due = subtotal', async () => {
    const out = await handoff();
    expect(out).toMatchObject({
      kind: 'ok',
      envelope: {
        envelope_version: 'v1',
        subtotal_minor: 2 * GROSS,
        discount_total_minor: 0,
        total_due_minor: 2 * GROSS,
      },
    });
  });

  it('subtotal stays Σ gross; the discount and the net ride beside it', async () => {
    asManager();
    await add({ reason_code: 'promotion' });
    await add({
      idempotency_key: 'dp-add-2',
      line_id: line2Id,
      placeholder_kind: 'manual_amt_500',
      reason_code: 'promotion',
    });
    const out = await handoff();
    expect(out).toMatchObject({
      kind: 'ok',
      envelope: {
        subtotal_minor: 2 * GROSS,
        discount_total_minor: 1400,
        total_due_minor: 2 * GROSS - 1400,
      },
    });
    const persisted = rows('SELECT handoff_envelope_json FROM carts WHERE cart_id = ?', [
      cartId,
    ])[0];
    expect(JSON.parse(String(persisted?.['handoff_envelope_json']))).toMatchObject({
      discount_total_minor: 1400,
      total_due_minor: 2 * GROSS - 1400,
    });
  });

  it('a fully discounted cart hands off with 0 due', async () => {
    asManager();
    await add({ placeholder_kind: 'manual_pct_100', reason_code: 'promotion' });
    await add({
      idempotency_key: 'dp-add-2',
      line_id: line2Id,
      placeholder_kind: `manual_amt_${String(GROSS)}`,
      reason_code: 'promotion',
    });
    await expect(handoff()).resolves.toMatchObject({
      kind: 'ok',
      envelope: { discount_total_minor: 2 * GROSS, total_due_minor: 0 },
    });
  });

  it('a line whose gross moved since the approval (resume re-price) refuses unauthorized_discount until the discount is re-added', async () => {
    asManager();
    await add({ reason_code: 'promotion' });
    // What an accepted resume price change does (`park-store.ts` reprice): the
    // gross moves, the placeholder stays. 10% of 9000 was approved as 900.
    raw.run(
      `UPDATE cart_lines SET unit_price_minor = 5000, line_subtotal_minor = 10000 WHERE line_id = ?`,
      [lineId],
    );
    await expect(handoff()).resolves.toEqual({ kind: 'refused', reason: 'unauthorized_discount' });
    await cart.discountPlaceholdersRemove({
      cart_id: cartId,
      placeholder_id: 'dp-add-1',
      idempotency_key: 'dp-rm-1',
    });
    await add({ idempotency_key: 'dp-add-2', reason_code: 'promotion' });
    await expect(handoff('handoff-2')).resolves.toMatchObject({
      kind: 'ok',
      envelope: { discount_total_minor: 1000 },
    });
  });

  it('a trusted placeholder with a non-canonical kind refuses unauthorized_discount', async () => {
    asManager();
    await add({ reason_code: 'promotion' });
    // A pre-I1 opaque kind: the audit row exists (trusted), but there is no value.
    raw.run(
      `UPDATE cart_line_discount_placeholders SET placeholder_kind = 'percent_10' WHERE placeholder_id = 'dp-add-1'`,
    );
    await expect(handoff()).resolves.toEqual({ kind: 'refused', reason: 'unauthorized_discount' });
  });
});
