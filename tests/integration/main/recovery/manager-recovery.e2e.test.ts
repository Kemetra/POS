/**
 * RT-441 (RT-116 S6, §5) — manager recovery end to end over every migration
 * (sql.js): the real manager PIN store (MA-1), the real approval service
 * (MA-2), the real payment FSMs and handlers, and the recovery service.
 *
 * A cashier took 5,000 of a 15,000 sale in cash, then their session ended:
 * the attempt is this terminal's stuck attempt (RT-442). A manager signed in
 * (in recovery mode) clears it, each action with its own approval.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  initGrantSql,
} from '../../../../src/main/operator/__tests__/__helpers__/offline-grant-fixture.js';
// Nested transactions (a savepoint), as better-sqlite3 does in production.
import { makeSqlJsHandle as handleFor } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';
import {
  createManagerPinStore,
  type ManagerPinStore,
} from '../../../../src/main/operator/manager-pin-store.js';
import {
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../../../../src/main/operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import { bindPaymentActionOutboxRepository } from '../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { bindPaymentAttemptsRepository } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { createPaymentAttemptFsm } from '../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from '../../../../src/main/payments/fsm/tender-line-fsm.js';
import { createIdempotencyHelper } from '../../../../src/main/payments/idempotency.js';
import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';
import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';
import { createPaymentsCancelHandler } from '../../../../src/main/payments/handlers/payments-cancel.js';
import { createPaymentAuditEmitter } from '../../../../src/main/payments/audit-emitter.js';
import type { OperatorSessionForPayments } from '../../../../src/main/payments/require-operator-session.js';
import {
  createManagerRecovery,
  createRecoveryPaymentPort,
  type ManagerRecovery,
} from '../../../../src/main/recovery/manager-recovery.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { ManagerActionKind } from '../../../../src/shared/operator/manager-action-kinds.js';

const TERMINAL = 'term-1';
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL };
const MANAGER = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a', pin: '246810' };
const OTHER_MANAGER = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000b', pin: '13579135' };
const CASHIER_OP = 'op-cashier';
const DEAD_SESSION = 'sess-cashier-dead';
const NOW = '2026-10-13T09:00:00.000Z';
const TOTAL = 15_000;
const PAID = 5_000;

function manager(over: Partial<OperatorSessionRecord> = {}): OperatorSessionRecord {
  return {
    id: 'sess-mgr',
    operator_id: 'op-mgr',
    display_name: 'Mona Manager',
    role: 'manager',
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    started_at: NOW,
    backend_session_id: 'b-mgr',
    last_activity_at: NOW,
    lock_state: 'active',
    locked_at: null,
    manager_user_id: MANAGER.userId,
    recovery_of: 'pending',
    ...over,
  };
}

let raw: SqlJsDatabase;
let pins: ManagerPinStore;
let approvals: ManagerApprovalService;
let recovery: ManagerRecovery;
let current: OperatorSessionRecord | null;
let audit: AuditEvent[];
let endRecoverySession: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
let attemptId: string;
let cashierScope: OperatorSessionForPayments;
let stack: ReturnType<typeof paymentStack>;

function paymentStack(db: ReturnType<typeof handleFor>) {
  const attempts = bindPaymentAttemptsRepository(db);
  const lines = bindPaymentTenderLinesRepository(db);
  const outbox = bindPaymentActionOutboxRepository(db);
  const tenderLineFsm = createTenderLineFsm({ db, attempts, lines, outbox });
  const paymentAttemptFsm = createPaymentAttemptFsm({ db, attempts, lines, outbox });
  const shared = {
    attemptsRepo: attempts,
    linesRepo: lines,
    idempotency: createIdempotencyHelper({ outbox }),
    auditEmitter: createPaymentAuditEmitter({ sink: { write: () => undefined } }),
    clock: () => new Date(NOW),
  };
  const uuid = (): string => crypto.randomUUID();
  const build = (getCurrentSession: () => OperatorSessionForPayments | null) => ({
    start: createPaymentsStartHandler({
      ...shared,
      getCurrentSession,
      paymentAttemptFsm,
      uuid,
      checkCartForPayment: () => ({ kind: 'ok' }),
      attemptHasLiveTender: () => false,
    }),
    apply: createTenderApplyHandler({ ...shared, getCurrentSession, tenderLineFsm, uuid }),
    confirm: createPaymentsConfirmHandler({ ...shared, getCurrentSession, paymentAttemptFsm }),
    cancel: createPaymentsCancelHandler({ ...shared, getCurrentSession, paymentAttemptFsm }),
  });
  return { build };
}

function insertCart(cart_id: string, state: string, session_id = DEAD_SESSION): void {
  raw.run(
    `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
       operator_session_id, state, cart_subtotal_minor, handoff_envelope_json, last_action_id,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cart_id,
      SCOPE.tenantId,
      SCOPE.branchId,
      TERMINAL,
      CASHIER_OP,
      session_id,
      state,
      TOTAL,
      state === 'frozen_handed_off'
        ? JSON.stringify({
            handoff_action_id: `h-${cart_id}`,
            lines: [],
            discount_placeholders: [],
          })
        : null,
      `a-${cart_id}`,
      NOW,
      NOW,
    ],
  );
}

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(async () => {
  raw = freshGrantDb();
  const db = handleFor(raw);
  audit = [];
  endRecoverySession = vi.fn<() => Promise<unknown>>(() => Promise.resolve());
  pins = createManagerPinStore({ db, safeStorage: aeadSafeStorage() });
  for (const m of [MANAGER, OTHER_MANAGER]) {
    await pins.enrol({
      scope: SCOPE,
      userId: m.userId,
      displayName: `Manager ${m.userId.slice(-1)}`,
      sealed: await pins.seal(m.pin),
      now: NOW,
      onlineAt: NOW,
      guard: () => undefined,
    });
  }
  stack = paymentStack(db);
  // The cashier's sale: a frozen cart, a started attempt, 5,000 in cash.
  cashierScope = {
    role: 'cashier',
    operator_id: CASHIER_OP,
    operator_session_id: DEAD_SESSION,
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    terminal_id: TERMINAL,
    display_name: 'Cashier',
  };
  const asCashier = stack.build(() => cashierScope);
  insertCart('cart-stuck', 'frozen_handed_off');
  const started = await asCashier.start({
    envelope_handoff_action_id: 'h-cart-stuck',
    envelope_cart_id: 'cart-stuck',
    envelope_subtotal_minor: TOTAL,
    envelope_version: 'v1',
    idempotency_key: 'k-start',
  });
  if (started.kind !== 'ok') throw new Error('start refused');
  attemptId = started.payment_attempt_id;
  const paid = await asCashier.apply({
    payment_attempt_id: attemptId,
    tender_type: 'cash',
    amount_applied_minor: PAID,
    idempotency_key: 'k-pay',
  });
  if (paid.kind !== 'ok') throw new Error('apply refused');

  current = manager({ recovery_of: attemptId });
  const ref: { current: ManagerRecovery | null } = { current: null };
  approvals = createManagerApprovalService({
    db,
    getSession: () => current,
    isSessionLocked: () => false,
    currentTerminalId: () => TERMINAL,
    managerPins: pins,
    resolvers: {
      'recovery.complete_attempt': (i) => ref.current?.resolvers.completeAttempt(i) ?? null,
      'recovery.cancel_attempt': (i) => ref.current?.resolvers.cancelAttempt(i) ?? null,
      'recovery.cancel_held_cart': (i) => ref.current?.resolvers.cancelHeldCart(i) ?? null,
    },
    auditEmitter: { emit: (e) => audit.push(e) },
    now: () => NOW,
  });
  recovery = createManagerRecovery({
    db,
    getSession: () => current,
    resolveTerminalId: () => TERMINAL,
    approvals,
    cartStore: bindCartStore(db),
    payments: createRecoveryPaymentPort((get) => stack.build(get)),
    auditEmitter: { emit: (e) => audit.push(e) },
    endRecoverySession,
    clock: () => new Date(NOW),
  });
  ref.current = recovery;
});

afterEach(() => {
  raw.close();
});

function managerRef(userId: string): string {
  return (
    pins.list({ scope: SCOPE, now: NOW }).find((m) => m.displayName.endsWith(userId.slice(-1)))
      ?.managerRef ?? ''
  );
}

async function approve(
  kind: ManagerActionKind,
  subject_ref: string,
  approver = MANAGER,
): Promise<string> {
  const outcome = await approvals.request({
    action_kind: kind,
    subject_ref,
    reason_code: 'manager_recovery',
    approver_ref: managerRef(approver.userId),
    pin: approver.pin,
  });
  if (outcome.kind !== 'approved') throw new Error(`not approved: ${outcome.reason}`);
  return outcome.approvalId;
}

const value = (sql: string, params: unknown[] = []): unknown =>
  raw.exec(sql, params as never)[0]?.values[0]?.[0];
const attemptState = (): unknown =>
  value('SELECT state FROM payment_attempts WHERE payment_attempt_id = ?', [attemptId]);
const categories = (): string[] => audit.map((e) => e.action_category);
const UNKNOWN_APPROVAL = '00000000-0000-4000-8000-000000000000';

describe('recovery.listHeld — totals only', () => {
  it('shows the stuck payment and the held carts as a summary, no line items', () => {
    insertCart('cart-draft', 'editing');
    const view = recovery.listHeld();
    expect(view).toEqual({
      kind: 'held',
      recovery_mode: true,
      stuck: {
        payment_attempt_id: attemptId,
        cart_id: 'cart-stuck',
        owning_operator_id: CASHIER_OP,
        line_count: 0,
        total_minor: TOTAL,
        cash_minor: PAID,
        card_minor: 0,
        voucher_minor: 0,
        remaining_minor: TOTAL - PAID,
        started_at: NOW,
      },
      held: [
        {
          cart_id: 'cart-draft',
          owning_operator_id: CASHIER_OP,
          kind: 'draft',
          parked: false,
          line_count: 0,
          total_minor: TOTAL,
          updated_at: NOW,
        },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(/display_name|item_ref|label/);
  });

  it('is manager / admin only', () => {
    current = { ...manager(), role: 'cashier' };
    expect(recovery.listHeld()).toEqual({ kind: 'refused', reason: 'role_mismatch' });
  });
});

describe('approval.listApprovers for recovery', () => {
  it('offers only the signed-in manager’s own record', () => {
    const answer = approvals.listApprovers({ actionKind: 'recovery.complete_attempt' });
    expect(answer).toEqual({
      kind: 'approvers',
      approvers: [{ approver_ref: managerRef(MANAGER.userId), display_name: 'Manager a' }],
    });
  });

  it('offers nobody to a session without a captured manager id', () => {
    current = manager({ manager_user_id: undefined });
    expect(approvals.listApprovers({ actionKind: 'recovery.cancel_held_cart' })).toEqual({
      kind: 'approvers',
      approvers: [],
    });
  });
});

describe('recovery.completeAttempt', () => {
  it('needs an approval', async () => {
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: UNKNOWN_APPROVAL,
        cash_received_minor: TOTAL - PAID,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
    expect(attemptState()).toBe('started');
  });

  it('an approval for another action does not complete it', async () => {
    const id = await approve('recovery.cancel_attempt', attemptId);
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_received_minor: TOTAL - PAID,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });

  it('a payment that moved since the approval is stale', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    const asCashier = stack.build(() => cashierScope);
    await asCashier.apply({
      payment_attempt_id: attemptId,
      tender_type: 'cash',
      amount_applied_minor: 1_000,
      idempotency_key: 'k-more',
    });
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_received_minor: TOTAL,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_stale' });
    expect(attemptState()).toBe('started');
  });

  it('the approver is the signed-in manager: another manager’s PIN is refused', async () => {
    await expect(approve('recovery.complete_attempt', attemptId, OTHER_MANAGER)).rejects.toThrow(
      'approval_unavailable',
    );
  });

  it('is requested on behalf of the original operator (requester ≠ approver)', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    expect(
      value('SELECT requester_operator_id FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBe(CASHIER_OP);
    expect(
      value('SELECT approver_user_id FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBe(MANAGER.userId);
  });

  it('refuses less cash than the remaining balance, spending nothing', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_received_minor: 9_999,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'cash_insufficient' });
    expect(
      value('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBeNull();
  });

  it('collects the rest, settles through the standard path, audits both, ends recovery', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    audit = [];
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_received_minor: 20_000,
      }),
    ).resolves.toEqual({ kind: 'completed', change_due_minor: 10_000 });
    expect(attemptState()).toBe('settled');
    expect(audit.find((e) => e.action_category === 'payment.recovery_completed')).toMatchObject({
      acting_operator_id: CASHIER_OP,
      approving_supervisor_id: MANAGER.userId,
      payload: { payment_attempt_id: attemptId, cart_id: 'cart-stuck', approval_id: id },
    });
    expect(endRecoverySession).toHaveBeenCalledOnce();
  });
});

describe('recovery.cancelAttempt', () => {
  it('needs the cash-returned confirmation when cash is live, before any approval is spent', async () => {
    const id = await approve('recovery.cancel_attempt', attemptId);
    await expect(
      recovery.cancelAttempt({ payment_attempt_id: attemptId, approval_id: id }),
    ).resolves.toEqual({ kind: 'refused', reason: 'confirmation_required' });
    expect(
      value('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBeNull();
    expect(attemptState()).toBe('started');
  });

  it('needs an approval bound to this attempt', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    await expect(
      recovery.cancelAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_returned_confirmed: true,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });

  it('reverses the tender explicitly, audits the recovery, ends recovery', async () => {
    const id = await approve('recovery.cancel_attempt', attemptId);
    audit = [];
    await expect(
      recovery.cancelAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_returned_confirmed: true,
      }),
    ).resolves.toEqual({ kind: 'cancelled' });
    expect(attemptState()).toBe('cancelled');
    expect(
      value('SELECT state FROM payment_tender_lines WHERE payment_attempt_id = ?', [attemptId]),
    ).toBe('reversed');
    expect(audit.find((e) => e.action_category === 'payment.recovery_cancelled')).toMatchObject({
      acting_operator_id: CASHIER_OP,
      approving_supervisor_id: MANAGER.userId,
      payload: { cash_returned_confirmed: true, card_void_confirmed_on_terminal: false },
    });
    expect(endRecoverySession).toHaveBeenCalledOnce();
  });
});

describe('recovery.cancelHeldCart', () => {
  it.each([
    ['editing', 'manager_cancelled_held', 'cart.void'],
    ['frozen_handed_off', 'manager_voided_post_handoff', 'cart.cancel.post_handoff'],
  ])('cancels a held %s cart as %s, with %s', async (state, reason, kind) => {
    insertCart('cart-held', state);
    const id = await approve('recovery.cancel_held_cart', 'cart-held');
    audit = [];
    expect(recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: id })).toEqual({
      kind: 'cancelled',
    });
    expect(value(`SELECT cancellation_reason FROM carts WHERE cart_id = 'cart-held'`)).toBe(reason);
    expect(value(`SELECT action_kind FROM cart_action_outbox WHERE cart_id = 'cart-held'`)).toBe(
      kind,
    );
    expect(categories()).toEqual(['cart.held_cancelled_by_manager']);
    expect(audit[0]).toMatchObject({
      acting_operator_id: CASHIER_OP,
      approving_supervisor_id: MANAGER.userId,
    });
    expect(endRecoverySession).not.toHaveBeenCalled();
  });

  it('needs an approval, and a stale cart rolls everything back', async () => {
    insertCart('cart-held', 'editing');
    expect(
      recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: UNKNOWN_APPROVAL }),
    ).toEqual({
      kind: 'refused',
      reason: 'approval_invalid',
    });
    const id = await approve('recovery.cancel_held_cart', 'cart-held');
    raw.run(`UPDATE carts SET cart_subtotal_minor = 1 WHERE cart_id = 'cart-held'`);
    expect(recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: id })).toEqual({
      kind: 'refused',
      reason: 'approval_stale',
    });
    expect(value(`SELECT state FROM carts WHERE cart_id = 'cart-held'`)).toBe('editing');
    expect(
      value('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBeNull();
  });

  it('never cancels the stuck payment’s cart (its payment is open)', () => {
    expect(
      recovery.cancelHeldCart({ cart_id: 'cart-stuck', approval_id: UNKNOWN_APPROVAL }),
    ).toEqual({ kind: 'refused', reason: 'not_found' });
  });
});
