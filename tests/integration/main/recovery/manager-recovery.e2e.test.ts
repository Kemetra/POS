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
import { realSettlementDeps } from '../../../unit/main/payments/__fixtures__/real-settlement-deps.js';
import { createPaymentsCancelHandler } from '../../../../src/main/payments/handlers/payments-cancel.js';
import { createPaymentAuditEmitter } from '../../../../src/main/payments/audit-emitter.js';
import type { OperatorSessionForPayments } from '../../../../src/main/payments/require-operator-session.js';
import {
  createManagerRecovery,
  createRecoveryPaymentPort,
  type ManagerRecovery,
  type ManagerRecoveryDeps,
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
    confirm: createPaymentsConfirmHandler({
      ...shared,
      ...realSettlementDeps({
        db,
        paymentAttemptFsm,
        attempts,
        lines,
        auditEmitter: shared.auditEmitter,
      }),
      getCurrentSession,
      paymentAttemptFsm,
    }),
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

async function enrolManagers(db: ReturnType<typeof handleFor>): Promise<void> {
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
}

/** The cashier's sale: a frozen cart, a started attempt, 5,000 in cash. */
async function seedStuckSale(): Promise<void> {
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
}

let handle: ReturnType<typeof handleFor>;
const recoveryRef: { current: ManagerRecovery | null } = { current: null };

/** The recovery service over the real stack; a test may swap a dependency. */
function buildRecovery(over: Partial<ManagerRecoveryDeps> = {}): ManagerRecovery {
  const built = createManagerRecovery({
    db: handle,
    getSession: () => current,
    resolveTerminalId: () => TERMINAL,
    approvals,
    cartStore: bindCartStore(handle),
    payments: createRecoveryPaymentPort((get) => stack.build(get)),
    auditEmitter: { emit: (e) => audit.push(e) },
    endRecoverySession,
    clock: () => new Date(NOW),
    ...over,
  });
  recoveryRef.current = built;
  return built;
}

function wireApprovals(): void {
  const via =
    (
      pick: (
        r: ManagerRecovery,
      ) => ManagerRecovery['resolvers'][keyof ManagerRecovery['resolvers']],
    ) =>
    (i: Parameters<ManagerRecovery['resolvers']['completeAttempt']>[0]) =>
      recoveryRef.current === null ? null : pick(recoveryRef.current)(i);
  approvals = createManagerApprovalService({
    db: handle,
    getSession: () => current,
    isSessionLocked: () => false,
    currentTerminalId: () => TERMINAL,
    managerPins: pins,
    resolvers: {
      'recovery.complete_attempt': via((r) => r.resolvers.completeAttempt),
      'recovery.cancel_attempt': via((r) => r.resolvers.cancelAttempt),
      'recovery.cancel_held_cart': via((r) => r.resolvers.cancelHeldCart),
    },
    auditEmitter: { emit: (e) => audit.push(e) },
    now: () => NOW,
  });
}

beforeEach(async () => {
  raw = freshGrantDb();
  handle = handleFor(raw);
  audit = [];
  endRecoverySession = vi.fn<() => Promise<unknown>>(() => Promise.resolve());
  await enrolManagers(handle);
  stack = paymentStack(handle);
  await seedStuckSale();
  current = manager({ recovery_of: attemptId });
  wireApprovals();
  recovery = buildRecovery();
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

/** 15,000 cash for the 10,000 remainder (5,000 change), or the cash-returned confirmation. */
const PAYING = { cash_received_minor: TOTAL };
const RETURNED = { cash_returned_confirmed: true };
const ATTEMPT_KIND = {
  complete: 'recovery.complete_attempt',
  cancel: 'recovery.cancel_attempt',
} as const;

/** Approve the stuck attempt (for `kind`, default the action's own), then run the action. */
async function runAttempt(
  action: 'complete' | 'cancel',
  opts: {
    service?: ManagerRecovery;
    kind?: ManagerActionKind;
    extra?: { cash_received_minor?: number; cash_returned_confirmed?: boolean };
  } = {},
): Promise<unknown> {
  const service = opts.service ?? recovery;
  const approval_id = await approve(opts.kind ?? ATTEMPT_KIND[action], attemptId);
  const req = { payment_attempt_id: attemptId, approval_id, ...opts.extra };
  return action === 'complete' ? service.completeAttempt(req) : service.cancelAttempt(req);
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
    await expect(
      runAttempt('complete', { kind: 'recovery.cancel_attempt', extra: PAYING }),
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
    await expect(
      runAttempt('cancel', { kind: 'recovery.complete_attempt', extra: RETURNED }),
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

const refusedWith = (reason: string) => ({ kind: 'refused', reason });

async function payByCard(amount: number): Promise<void> {
  const paid = await stack
    .build(() => cashierScope)
    .apply({
      payment_attempt_id: attemptId,
      tender_type: 'external_card_terminal',
      amount_applied_minor: amount,
      external_reference: 'A1B2C3',
      idempotency_key: 'k-card',
    });
  if (paid.kind !== 'ok') throw new Error(`card refused: ${JSON.stringify(paid)}`);
}

const realPort = () => createRecoveryPaymentPort((get) => stack.build(get));
const quietLogger = () => ({ info: vi.fn(), error: vi.fn() });

describe('recovery — who may recover', () => {
  it.each<[string, () => OperatorSessionRecord | null, string]>([
    ['signed out', () => null, 'no_session'],
    ['locked', () => manager({ lock_state: 'locked' }), 'session_locked'],
    ['a cashier', () => manager({ role: 'cashier' }), 'role_mismatch'],
  ])('refuses every action when %s', async (_label, session, reason) => {
    insertCart('cart-held', 'editing');
    current = session();
    expect(recovery.listHeld()).toEqual(refusedWith(reason));
    await expect(
      recovery.completeAttempt({ payment_attempt_id: attemptId, approval_id: UNKNOWN_APPROVAL }),
    ).resolves.toEqual(refusedWith(reason));
    await expect(
      recovery.cancelAttempt({ payment_attempt_id: attemptId, approval_id: UNKNOWN_APPROVAL }),
    ).resolves.toEqual(refusedWith(reason));
    expect(
      recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: UNKNOWN_APPROVAL }),
    ).toEqual(refusedWith(reason));
  });

  it('serves an admin', () => {
    current = manager({ role: 'admin' });
    expect(recovery.listHeld()).toMatchObject({ kind: 'held' });
  });

  it('refuses on an unpaired terminal, and resolves no approval subject there', () => {
    insertCart('cart-held', 'editing');
    const unpaired = buildRecovery({ resolveTerminalId: () => null });
    expect(unpaired.listHeld()).toEqual(refusedWith('no_session'));
    const session = manager();
    expect(unpaired.resolvers.completeAttempt({ subjectRef: attemptId, session })).toBeNull();
    expect(unpaired.resolvers.cancelHeldCart({ subjectRef: 'cart-held', session })).toBeNull();
  });

  it('never lets an operator recover their own sale from a new session', async () => {
    insertCart('cart-held', 'editing');
    const session = manager({ operator_id: CASHIER_OP, recovery_of: undefined });
    current = session;
    expect(recovery.resolvers.completeAttempt({ subjectRef: attemptId, session })).toBeNull();
    expect(recovery.resolvers.cancelHeldCart({ subjectRef: 'cart-held', session })).toBeNull();
    await expect(
      recovery.completeAttempt({
        payment_attempt_id: attemptId,
        approval_id: UNKNOWN_APPROVAL,
        cash_received_minor: TOTAL,
      }),
    ).resolves.toEqual(refusedWith('not_found'));
    expect(
      recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: UNKNOWN_APPROVAL }),
    ).toEqual(refusedWith('not_found'));
  });
});

describe('recovery.listHeld — what it lists', () => {
  it('lists no stuck payment once it is resolved, and a handed-off cart as handed off', async () => {
    const id = await approve('recovery.cancel_attempt', attemptId);
    await recovery.cancelAttempt({
      payment_attempt_id: attemptId,
      approval_id: id,
      cash_returned_confirmed: true,
    });
    insertCart('cart-frozen', 'frozen_handed_off');
    const view = recovery.listHeld();
    expect(view).toMatchObject({ kind: 'held', stuck: null });
    expect(view.kind === 'held' && view.held.map((h) => [h.cart_id, h.kind])).toContainEqual([
      'cart-frozen',
      'handed_off',
    ]);
  });

  it('flags a parked cart (spec 024 §4.3; migration 0050)', () => {
    insertCart('cart-parked', 'editing');
    raw.run(`UPDATE carts SET parked_at = ? WHERE cart_id = 'cart-parked'`, [NOW]);
    const view = recovery.listHeld();
    expect(view.kind === 'held' && view.held).toEqual([
      expect.objectContaining({ cart_id: 'cart-parked', parked: true }),
    ]);
  });

  it('shows card tender as card, and uses the real clock by default', async () => {
    await payByCard(2_000);
    const unclocked = buildRecovery({ clock: undefined });
    const view = unclocked.listHeld();
    expect(view.kind === 'held' && view.stuck).toMatchObject({
      cash_minor: PAID,
      card_minor: 2_000,
      remaining_minor: TOTAL - PAID - 2_000,
    });
  });
});

describe('recovery.completeAttempt — refusals and failures', () => {
  it('refuses an attempt that is not this terminal’s stuck attempt', async () => {
    await expect(
      recovery.completeAttempt({ payment_attempt_id: 'other', approval_id: UNKNOWN_APPROVAL }),
    ).resolves.toEqual(refusedWith('not_found'));
  });

  it('refuses no cash at all when something remains', async () => {
    const id = await approve('recovery.complete_attempt', attemptId);
    await expect(
      recovery.completeAttempt({ payment_attempt_id: attemptId, approval_id: id }),
    ).resolves.toEqual(refusedWith('cash_insufficient'));
  });

  it.each([
    ['the cash apply', 'apply', 'complete', PAYING],
    ['the confirm', 'confirm', 'complete', PAYING],
    ['the cancel', 'cancel', 'cancel', RETURNED],
  ] as const)('answers payment_refused when %s is refused', async (_label, step, action, extra) => {
    const refusal = () =>
      Promise.resolve({ kind: 'refused' as const, reason: 'no_session' as const });
    const service = buildRecovery({ payments: { ...realPort(), [step]: refusal } });
    await expect(runAttempt(action, { service, extra })).resolves.toEqual(
      refusedWith('payment_refused'),
    );
    expect(attemptState()).toBe('started');
  });

  interface Fault {
    label: string;
    faulty: (logger: ReturnType<typeof quietLogger>) => Partial<ManagerRecoveryDeps>;
    answer: unknown;
    logged: unknown;
    message: string;
  }
  it.each<Fault>([
    {
      label: 'a payment call throws',
      faulty: (logger) => ({
        logger,
        payments: { ...realPort(), apply: () => Promise.reject(new Error('disk full')) },
      }),
      answer: refusedWith('recovery_unavailable'),
      logged: expect.anything(),
      message: 'recovery.failed',
    },
    {
      label: 'ending the recovery session fails',
      faulty: (logger) => ({
        logger,
        endRecoverySession: () => Promise.reject(new Error('backend down')),
      }),
      answer: { kind: 'completed', change_due_minor: 5_000 },
      logged: expect.anything(),
      message: 'recovery.end_session_failed',
    },
    {
      label: 'the audit sink throws',
      faulty: (logger) => ({
        logger,
        auditEmitter: {
          emit: () => {
            throw new Error('sink down');
          },
        },
      }),
      answer: { kind: 'completed', change_due_minor: 5_000 },
      logged: { err: expect.any(Error) as unknown, category: 'payment.recovery_completed' },
      message: 'recovery.audit_failed',
    },
  ])('logs it when $label', async ({ faulty, answer, logged, message }) => {
    const logger = quietLogger();
    const service = buildRecovery(faulty(logger));
    await expect(runAttempt('complete', { service, extra: PAYING })).resolves.toEqual(answer);
    expect(logger.error).toHaveBeenCalledWith(logged, message);
  });

  it('runs one action at a time', async () => {
    const real = realPort();
    let release: () => void = () => undefined;
    const slow = buildRecovery({
      payments: {
        ...real,
        apply: (scope, req) =>
          new Promise((resolve) => {
            release = () => {
              resolve(real.apply(scope, req));
            };
          }),
      },
    });
    const id = await approve('recovery.complete_attempt', attemptId);
    const first = slow.completeAttempt({
      payment_attempt_id: attemptId,
      approval_id: id,
      cash_received_minor: TOTAL,
    });
    await expect(
      slow.cancelAttempt({ payment_attempt_id: attemptId, approval_id: UNKNOWN_APPROVAL }),
    ).resolves.toEqual(refusedWith('recovery_unavailable'));
    release();
    await expect(first).resolves.toMatchObject({ kind: 'completed' });
  });

  it('completes a fully tendered attempt with no cash, outside recovery mode', async () => {
    const rest = await stack
      .build(() => cashierScope)
      .apply({
        payment_attempt_id: attemptId,
        tender_type: 'cash',
        amount_applied_minor: TOTAL - PAID,
        idempotency_key: 'k-rest',
      });
    expect(rest.kind).toBe('ok');
    current = manager({ recovery_of: undefined });
    const id = await approve('recovery.complete_attempt', attemptId);
    await expect(
      recovery.completeAttempt({ payment_attempt_id: attemptId, approval_id: id }),
    ).resolves.toEqual({ kind: 'completed', change_due_minor: 0 });
    expect(attemptState()).toBe('settled');
    expect(endRecoverySession).not.toHaveBeenCalled();
  });
});

describe('recovery.cancelAttempt — confirmations and failures', () => {
  it('needs the card-void confirmation when card is live', async () => {
    await payByCard(2_000);
    const id = await approve('recovery.cancel_attempt', attemptId);
    await expect(
      recovery.cancelAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_returned_confirmed: true,
      }),
    ).resolves.toEqual(refusedWith('confirmation_required'));
    await expect(
      recovery.cancelAttempt({
        payment_attempt_id: attemptId,
        approval_id: id,
        cash_returned_confirmed: true,
        card_void_confirmed_on_terminal: true,
      }),
    ).resolves.toEqual({ kind: 'cancelled' });
  });
});

describe('recovery.cancelHeldCart — failures', () => {
  it('versions a cart with no last action by its update time', async () => {
    insertCart('cart-held', 'editing');
    raw.run(`UPDATE carts SET last_action_id = NULL WHERE cart_id = 'cart-held'`);
    const id = await approve('recovery.cancel_held_cart', 'cart-held');
    expect(recovery.cancelHeldCart({ cart_id: 'cart-held', approval_id: id })).toEqual({
      kind: 'cancelled',
    });
  });

  it('rolls back and answers recovery_unavailable when the cart write throws', async () => {
    insertCart('cart-held', 'editing');
    const logger = quietLogger();
    const failing = buildRecovery({
      logger,
      cartStore: {
        cancelCartAndOutbox: () => {
          throw new Error('constraint');
        },
      },
    });
    const id = await approve('recovery.cancel_held_cart', 'cart-held');
    expect(failing.cancelHeldCart({ cart_id: 'cart-held', approval_id: id })).toEqual(
      refusedWith('recovery_unavailable'),
    );
    expect(
      value('SELECT consumed_at FROM manager_approvals WHERE approval_id = ?', [id]),
    ).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      'recovery.cancel_held_cart_failed',
    );
  });
});
