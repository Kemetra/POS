/**
 * RT-861 — the cashier-path manual discount records its approver's role, end
 * to end over the full migration stack (sql.js) with the real manager PIN
 * store, approval service, cart bridge and durable audit emitter:
 *
 *   • `approval.request` copies the approving PIN record's role into
 *     `manager_approvals.approver_role` when it grants (0056);
 *   • the add reads it from the consumed approval into the
 *     `cart.discount.manager_authorized` payload, as the direct path does;
 *   • the role is the one at grant: a later refresh of the PIN record does not
 *     change an approval already granted;
 *   • a record without a role (enrolled before 0056) grants an approval with
 *     none, and the payload has no `approver_role`: never a guessed one.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { AuditEmitter } from '../../audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../audit/audit-events-store.js';
import { discountApprovalSubjectRef } from '../../../shared/cart/discount-approval.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import {
  bootDiscountHarness,
  cartWithLines,
  type DiscountHarness,
} from './__helpers__/discount-harness.js';

const TERMINAL = 'term-1';
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL };
const MANAGER_USER = '0190f5a2-3b4c-7d8e-9f01-00000000000a';
const CASHIER_USER = '0190f5a2-3b4c-7d8e-9f01-0000000000cc';
const T0 = '2026-10-24T09:00:00.000Z';

const CASHIER: OperatorSessionRecord = {
  id: 'sess-cashier',
  operator_id: 'op-sess-cashier',
  display_name: 'Test Cashier',
  role: 'cashier',
  tenant_id: SCOPE.tenantId,
  branch_id: SCOPE.branchId,
  started_at: T0,
  backend_session_id: 'b-sess-cashier',
  last_activity_at: T0,
  lock_state: 'active',
  locked_at: null,
  user_id: CASHIER_USER,
};

let raw: SqlJsDatabase;
let h: DiscountHarness;
let audit: AuditEvent[];
let cartId: string;
let lineId: string;

beforeAll(async () => {
  await initGrantSql();
});

afterEach(() => {
  raw.close();
});

/** The stack with one manager PIN record of `role` (none: enrolled before 0056). */
async function boot(role?: 'manager' | 'admin'): Promise<void> {
  raw = freshGrantDb();
  const db = handleFor(raw);
  const durable = new AuditEmitter(bindAuditEventsStoreDb(db));
  audit = [];
  h = await bootDiscountHarness({
    db,
    terminalId: TERMINAL,
    scope: SCOPE,
    manager: {
      userId: MANAGER_USER,
      pin: '246810',
      displayName: 'Mona Manager',
      ...(role === undefined ? {} : { role }),
    },
    enrolledAt: T0,
    unitPriceMinor: 4500,
    getSession: () => CASHIER,
    now: () => T0,
    audit: {
      emit: (e) => {
        durable.emit(e);
        audit.push(e);
      },
    },
  });
  const built = await cartWithLines(h.cart, ['SKU-A'], 2);
  cartId = built.cartId;
  [lineId = ''] = built.lineIds;
}

async function approved(): Promise<string> {
  const outcome = await h.ask({
    subject_ref: discountApprovalSubjectRef({
      cart_id: cartId,
      line_id: lineId,
      placeholder_kind: 'manual_pct_10',
    }),
    reason_code: 'promotion',
  });
  if (outcome.kind !== 'approved') throw new Error(`not approved: ${outcome.reason}`);
  return outcome.approvalId;
}

function add(approvalId: string) {
  return h.cart.discountPlaceholdersAdd({
    cart_id: cartId,
    line_id: lineId,
    placeholder_kind: 'manual_pct_10',
    idempotency_key: 'dp-add-1',
    approval_id: approvalId,
  });
}

function approverRoleOf(approvalId: string): unknown {
  return raw.exec('SELECT approver_role FROM manager_approvals WHERE approval_id = ?', [
    approvalId,
  ])[0]?.values[0]?.[0];
}

function discountPayload(): Record<string, unknown> | undefined {
  return audit.find((e) => e.action_category === 'cart.discount.manager_authorized')?.payload;
}

function durablePayload(): unknown {
  const json = raw.exec(
    `SELECT payload FROM audit_events WHERE action_category = 'cart.discount.manager_authorized'`,
  )[0]?.values[0]?.[0];
  return typeof json === 'string' ? JSON.parse(json) : undefined;
}

describe('RT-861 — the cashier path records the approver’s role', () => {
  it.each(['manager', 'admin'] as const)(
    'an approval by a %s carries the role, and so does the discount audit',
    async (role) => {
      await boot(role);
      const id = await approved();
      expect(approverRoleOf(id)).toBe(role);
      await expect(add(id)).resolves.toMatchObject({ kind: 'ok' });
      expect(discountPayload()).toEqual({
        cart_id: cartId,
        cart_line_id: lineId,
        placeholder_id: 'dp-add-1',
        approval_id: id,
        reason_code: 'promotion',
        kind: 'percent',
        value: 10,
        amount_minor: 900,
        approver_role: role,
      });
      expect(durablePayload()).toMatchObject({ approver_role: role });
    },
  );

  it('the role is the one at grant: a later refresh does not change it', async () => {
    await boot('manager');
    const id = await approved();
    h.pins.refreshRole({ scope: SCOPE, userId: MANAGER_USER, role: 'admin' });
    await add(id);
    expect(approverRoleOf(id)).toBe('manager');
    expect(discountPayload()).toMatchObject({ approver_role: 'manager' });
  });

  it('a PIN record without a role grants an approval without one: none is guessed', async () => {
    await boot();
    const id = await approved();
    expect(approverRoleOf(id)).toBeNull();
    await expect(add(id)).resolves.toMatchObject({ kind: 'ok' });
    expect(discountPayload()).not.toHaveProperty('approver_role');
    expect(durablePayload()).not.toHaveProperty('approver_role');
  });
});
