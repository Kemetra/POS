/**
 * S3c Wave G — shared test fixture for `payments.*` + `tender.*` bridge handlers.
 *
 * Provides typed in-memory test doubles for every collaborator the bridge
 * handlers reach for:
 *
 *   • SessionSource           — current operator session (or null)
 *   • PaymentAttemptFsm       — stubbed transition outcomes
 *   • TenderLineFsm           — stubbed apply / reverse outcomes
 *   • PaymentAuditEmitter     — capture sink for assertion
 *   • IdempotencyHelper       — fresh / replay / mismatch sequencing
 *   • repos (attempts/lines)  — minimal in-memory row stores
 *
 * **Rationale.** The FSMs are tested end-to-end against real SQL in S3b
 * (T080–T088 GREEN on `main`). Reproducing their transaction shape inside
 * handler tests would couple Slice 3c to Slice 3b's transaction internals —
 * exactly the over-coupling the cart bridge tests avoid by stubbing
 * `cartStore` rather than driving SQL. Bridge handlers only need to
 * verify: "called requireOperatorSession with X, called the FSM with Y on
 * its `ok` path, mapped the FSM's outcome to the bridge-api Response."
 *
 * The fixtures are intentionally permissive: each stub is a plain
 * `vi.fn()` whose default return value can be overridden per test. Tests
 * inject the fixture into `createPaymentsBridgeHandlers({ deps })` (Wave H
 * will implement that factory; until then, the import below is a forward
 * reference and the tests are RED).
 */

import { vi, type Mock } from 'vitest';

import type {
  OperatorSessionForPayments,
  PaymentAttemptForGating,
} from '../../../../../src/main/payments/require-operator-session.js';
import type {
  PaymentAttemptFsm,
  StartOutcome,
  ConfirmOutcome,
  CancelOutcome,
  FailOutcome,
  ForceFailOutcome,
} from '../../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import type {
  TenderLineFsm,
  ApplyOutcome,
  ReverseOutcome,
  MarkReversalPendingOutcome,
  ConfirmReversedOutcome,
} from '../../../../../src/main/payments/fsm/tender-line-fsm.js';
import type {
  IdempotencyHelper,
  ReserveOutcome,
} from '../../../../../src/main/payments/idempotency.js';
import type {
  PaymentAuditEmitter,
  PaymentAuditEvent,
} from '../../../../../src/main/payments/audit-emitter.js';
import type { PaymentAttemptRow } from '../../../../../src/main/payments/repositories/payment-attempts.repository.js';
import type { PaymentTenderLineRow } from '../../../../../src/main/payments/repositories/payment-tender-lines.repository.js';

// ── Session source ──────────────────────────────────────────────────────────

export interface SessionSource {
  getCurrentSession(): OperatorSessionForPayments | null;
}

export function makeSession(
  overrides: Partial<OperatorSessionForPayments> = {},
): OperatorSessionForPayments {
  return {
    role: 'cashier',
    operator_id: 'op-clerk-user-abc',
    operator_session_id: 'sess-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    display_name: 'Test Operator',
    ...overrides,
  };
}

export function makeSessionSource(session: OperatorSessionForPayments | null): SessionSource {
  return { getCurrentSession: () => session };
}

// ── Attempt + line row builders (for repo doubles + audit assertions) ───────

export function makeAttemptRow(overrides: Partial<PaymentAttemptRow> = {}): PaymentAttemptRow {
  return {
    payment_attempt_id: 'pa-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    acting_operator_id: 'op-clerk-user-abc',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: 1500,
    state: 'started',
    started_at: '2026-05-23T11:00:00.000Z',
    settled_at: null,
    cancelled_at: null,
    failed_at: null,
    force_failed_at: null,
    failure_reason: null,
    force_fail_attribution_operator_id: null,
    last_action_id: 'start-pa-1',
    ...overrides,
  };
}

export function makeLineRow(overrides: Partial<PaymentTenderLineRow> = {}): PaymentTenderLineRow {
  return {
    tender_line_id: 'tl-1',
    payment_attempt_id: 'pa-1',
    tender_type: 'cash',
    amount_applied_minor: 1500,
    state: 'applied',
    change_due_minor: null,
    external_reference: null,
    voucher_redemption_intent_token: null,
    voucher_authority_redemption_id: null,
    applied_at: '2026-05-23T11:00:01.000Z',
    refused_at: null,
    reversed_at: null,
    reversal_pending_since: null,
    refusal_reason: null,
    attribution_operator_id: 'op-clerk-user-abc',
    apply_order: 1,
    last_action_id: 'apply-tl-1',
    ...overrides,
  };
}

// ── Repository doubles (just enough for handler tests) ──────────────────────

export interface AttemptsRepoDouble {
  findById: Mock<(id: string) => PaymentAttemptRow | undefined>;
  findStartedByTerminal: Mock<(terminal_id: string) => PaymentAttemptRow | undefined>;
  insert: Mock;
  updateState: Mock;
}

export function makeAttemptsRepoDouble(
  rows: readonly PaymentAttemptRow[] = [],
): AttemptsRepoDouble {
  const byId = new Map<string, PaymentAttemptRow>();
  for (const r of rows) byId.set(r.payment_attempt_id, r);
  return {
    findById: vi.fn((id: string): PaymentAttemptRow | undefined => byId.get(id)),
    findStartedByTerminal: vi.fn((terminal_id: string): PaymentAttemptRow | undefined =>
      [...byId.values()].find((r) => r.terminal_id === terminal_id && r.state === 'started'),
    ),
    insert: vi.fn(),
    updateState: vi.fn(),
  };
}

export interface LinesRepoDouble {
  findByAttempt: Mock<(payment_attempt_id: string) => PaymentTenderLineRow[]>;
  findByLineId: Mock<(tender_line_id: string) => PaymentTenderLineRow | undefined>;
  insert: Mock;
  updateState: Mock;
  persistAuthorityRedemptionId: Mock;
  settlementSumMinor: Mock<(payment_attempt_id: string) => number>;
}

export function makeLinesRepoDouble(rows: readonly PaymentTenderLineRow[] = []): LinesRepoDouble {
  const byAttempt = new Map<string, PaymentTenderLineRow[]>();
  const byLineId = new Map<string, PaymentTenderLineRow>();
  for (const r of rows) {
    const list = byAttempt.get(r.payment_attempt_id) ?? [];
    list.push(r);
    byAttempt.set(r.payment_attempt_id, list);
    byLineId.set(r.tender_line_id, r);
  }
  return {
    findByAttempt: vi.fn((payment_attempt_id: string): PaymentTenderLineRow[] => [
      ...(byAttempt.get(payment_attempt_id) ?? []),
    ]),
    findByLineId: vi.fn((tender_line_id: string): PaymentTenderLineRow | undefined =>
      byLineId.get(tender_line_id),
    ),
    insert: vi.fn(),
    updateState: vi.fn(),
    persistAuthorityRedemptionId: vi.fn(),
    settlementSumMinor: vi.fn((payment_attempt_id: string): number => {
      const lines = byAttempt.get(payment_attempt_id) ?? [];
      let sum = 0;
      for (const l of lines) {
        if (l.state !== 'applied') continue;
        sum += l.amount_applied_minor - (l.change_due_minor ?? 0);
      }
      return sum;
    }),
  };
}

// ── FSM doubles ─────────────────────────────────────────────────────────────

export interface PaymentAttemptFsmDouble extends PaymentAttemptFsm {
  start: Mock<PaymentAttemptFsm['start']>;
  confirm: Mock<PaymentAttemptFsm['confirm']>;
  cancel: Mock<PaymentAttemptFsm['cancel']>;
  fail: Mock<PaymentAttemptFsm['fail']>;
  forceFail: Mock<PaymentAttemptFsm['forceFail']>;
}

export function makePaymentAttemptFsmDouble(): PaymentAttemptFsmDouble {
  // Production FSMs echo their input timestamps + ids on the ok path. The
  // stubs mirror that so tests can drive clock-handed-by-handler scenarios
  // without the stub silently overriding values the handler controls.
  return {
    start: vi.fn(
      (input): StartOutcome => ({
        kind: 'ok',
        payment_attempt_id: input.payment_attempt_id,
      }),
    ),
    confirm: vi.fn(
      (input): ConfirmOutcome => ({
        kind: 'ok',
        settled_at: input.settled_at,
      }),
    ),
    cancel: vi.fn(
      (input): CancelOutcome => ({
        kind: 'ok',
        cancelled_at: input.cancelled_at,
        reversed_tender_line_ids: [],
        reversal_pending_tender_line_ids: [],
      }),
    ),
    fail: vi.fn(
      (input): FailOutcome => ({
        kind: 'ok',
        failed_at: input.failed_at,
      }),
    ),
    forceFail: vi.fn(
      (input): ForceFailOutcome => ({
        kind: 'ok',
        force_failed_at: input.force_failed_at,
      }),
    ),
  };
}

export interface TenderLineFsmDouble extends TenderLineFsm {
  apply: Mock<TenderLineFsm['apply']>;
  reverse: Mock<TenderLineFsm['reverse']>;
  reverseInTransaction: Mock<TenderLineFsm['reverseInTransaction']>;
  markReversalPending: Mock<TenderLineFsm['markReversalPending']>;
  confirmReversed: Mock<TenderLineFsm['confirmReversed']>;
  listAppliedLifoIds: Mock<TenderLineFsm['listAppliedLifoIds']>;
}

export function makeTenderLineFsmDouble(): TenderLineFsmDouble {
  // Mirror production behaviour — echo input ids + timestamps on ok.
  return {
    apply: vi.fn(
      (input): ApplyOutcome => ({
        kind: 'ok',
        tender_line_id: input.tender_line_id,
        applied_at: input.applied_at,
      }),
    ),
    reverse: vi.fn(
      (input): ReverseOutcome => ({
        kind: 'ok',
        reversed_at: input.reversed_at,
        state: 'reversed',
        tender_type: 'cash',
        manual_void_required: false,
      }),
    ),
    reverseInTransaction: vi.fn(
      (input): ReverseOutcome => ({
        kind: 'ok',
        reversed_at: input.reversed_at,
        state: 'reversed',
        tender_type: 'cash',
        manual_void_required: false,
      }),
    ),
    markReversalPending: vi.fn(
      (input): MarkReversalPendingOutcome => ({
        kind: 'ok',
        reversal_pending_since: input.reversal_pending_since,
        tender_type: 'internal_voucher',
      }),
    ),
    confirmReversed: vi.fn(
      (input): ConfirmReversedOutcome => ({
        kind: 'ok',
        reversed_at: input.reversed_at,
        tender_type: 'internal_voucher',
      }),
    ),
    listAppliedLifoIds: vi.fn(() => [] as readonly string[]),
  };
}

// ── Idempotency helper double ───────────────────────────────────────────────

export interface IdempotencyHelperDouble extends IdempotencyHelper {
  checkOrReserve: Mock<IdempotencyHelper['checkOrReserve']>;
  /** Convenience — captured commits invoked by the handler under test. */
  commitCalls: number;
}

/**
 * `{ kind: 'replay' }` is shorthand for a replay of an action on `pa-1`; the
 * real helper also returns the original outbox row's ids, which the start /
 * apply / validate handlers rebuild their result from. Pass them explicitly
 * when the test depends on a specific row.
 */
export type IdempotencyDoubleOutcome =
  | ReserveOutcome
  | { kind: 'replay'; payment_attempt_id?: string; tender_line_id?: string | null };

export function makeIdempotencyHelperDouble(
  requested: IdempotencyDoubleOutcome | 'auto' = 'auto',
): IdempotencyHelperDouble {
  const state = { commitCalls: 0 };
  const outcome: ReserveOutcome | 'auto' =
    requested !== 'auto' && requested.kind === 'replay'
      ? {
          kind: 'replay',
          payment_attempt_id: requested.payment_attempt_id ?? 'pa-1',
          tender_line_id: requested.tender_line_id ?? null,
        }
      : requested;
  const checkOrReserve = vi.fn<IdempotencyHelper['checkOrReserve']>(() => {
    if (outcome === 'auto') {
      return {
        kind: 'fresh' as const,
        commit: (): void => {
          state.commitCalls += 1;
        },
      };
    }
    if (outcome.kind === 'fresh') {
      // Wrap the caller-supplied fresh outcome so we can count commits.
      return {
        kind: 'fresh' as const,
        commit: (): void => {
          state.commitCalls += 1;
          outcome.commit();
        },
      };
    }
    return outcome;
  });
  return Object.defineProperty({ checkOrReserve } as IdempotencyHelperDouble, 'commitCalls', {
    get: (): number => state.commitCalls,
    enumerable: true,
  });
}

// ── Audit emitter double (captures every emitted event) ─────────────────────

export interface AuditEmitterDouble extends PaymentAuditEmitter {
  readonly captured: readonly PaymentAuditEvent[];
}

export function makeAuditEmitterDouble(): AuditEmitterDouble {
  const captured: PaymentAuditEvent[] = [];
  const emitter: PaymentAuditEmitter = {
    emitPaymentSettled: vi.fn<PaymentAuditEmitter['emitPaymentSettled']>((input): void => {
      captured.push({
        action_category: 'payment.settled',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.settled_at,
        payload: { ...input },
      });
    }),
    emitPaymentCancelled: vi.fn<PaymentAuditEmitter['emitPaymentCancelled']>((input): void => {
      captured.push({
        action_category: 'payment.cancelled',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.cancelled_at,
        payload: { ...input },
      });
    }),
    emitPaymentFailed: vi.fn<PaymentAuditEmitter['emitPaymentFailed']>((input): void => {
      captured.push({
        action_category: 'payment.failed',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.failed_at,
        payload: { ...input },
      });
    }),
    emitTenderApplied: vi.fn<PaymentAuditEmitter['emitTenderApplied']>((input): void => {
      captured.push({
        action_category: 'tender.applied',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.applied_at,
        payload: { ...input },
      });
    }),
    emitTenderRefused: vi.fn<PaymentAuditEmitter['emitTenderRefused']>((input): void => {
      captured.push({
        action_category: 'tender.refused',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.refused_at,
        payload: { ...input },
      });
    }),
    emitTenderReversed: vi.fn<PaymentAuditEmitter['emitTenderReversed']>((input): void => {
      // Mirror the production emitter — only include reversal_pending_since
      // in the captured payload when the caller actually passed it. Keeps
      // the audit shape identical to what production writes (T231).
      const payload: Record<string, unknown> = { ...input };
      if (input.reversal_pending_since === undefined) {
        delete payload.reversal_pending_since;
      }
      captured.push({
        action_category: 'tender.reversed',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.reversed_at,
        payload,
      });
    }),
    emitTenderReversalPending: vi.fn<PaymentAuditEmitter['emitTenderReversalPending']>(
      (input): void => {
        captured.push({
          action_category: 'tender.reversal_pending',
          payment_attempt_id: input.payment_attempt_id,
          attribution_operator_id: input.attribution_operator_id,
          tenant_id: input.tenant_id,
          branch_id: input.branch_id,
          originating_terminal_id: input.originating_terminal_id,
          session_id: input.session_id,
          created_at: input.reversal_pending_since,
          payload: { ...input },
        });
      },
    ),
    emitRaw: vi.fn<PaymentAuditEmitter['emitRaw']>((event): void => {
      captured.push(event);
    }),
  };
  return Object.assign(emitter, {
    get captured(): readonly PaymentAuditEvent[] {
      return captured;
    },
  });
}

// ── Gating helper (mirrors require-operator-session shape) ──────────────────

export function gatingProjection(row: PaymentAttemptRow): PaymentAttemptForGating {
  return {
    operator_session_id: row.operator_session_id,
    tenant_id: row.tenant_id,
    branch_id: row.branch_id,
    terminal_id: row.terminal_id,
    state: row.state,
  };
}
