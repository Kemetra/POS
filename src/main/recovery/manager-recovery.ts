/**
 * RT-441 (RT-116 S6, §5) — manager recovery on this terminal.
 *
 * A manager or admin clears what an absent operator left behind:
 *
 *   • the terminal's STUCK attempt (RT-442: started, holding live tender, bound
 *     to an ended session) — complete it through the standard 006 path
 *     (collect the remaining cash, then confirm: settlement and 008
 *     finalization run unchanged), or cancel it with an explicit LIFO
 *     reversal (`payments.cancel` semantics) once the manager confirms the
 *     cash went back and any card payment was voided on its terminal;
 *   • a HELD cart of another session (a draft, or a handed-off cart with no
 *     open payment) — cancel it with a reason: `manager_cancelled_held` for a
 *     draft, `manager_voided_post_handoff` for a handed-off cart.
 *
 * Every action consumes its OWN RT-114 approval (the signed-in manager's PIN,
 * MA-2), bound to its subject, version and amount, requested on behalf of the
 * original operator. The audit is dual-attributed: `acting_operator_id` is the
 * original operator, `approving_supervisor_id` the manager (RT-116 M12).
 *
 * Ownership (M5) is not relaxed for anyone else: the payment calls run through
 * a recovery-scoped session — the attempt's own session id — built here only
 * after the approval is consumed. The cart cancel and its approval commit in
 * one transaction. A recovery-mode session ends once its stuck attempt is
 * resolved (§5.1).
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import type { AuditEvent } from '../../shared/audit/event-shape.js';
import type {
  RecoveryCancelAttemptRequest,
  RecoveryCancelAttemptResponse,
  RecoveryCancelHeldCartRequest,
  RecoveryCancelHeldCartResponse,
  RecoveryCompleteAttemptRequest,
  RecoveryCompleteAttemptResponse,
  RecoveryHeldCartView,
  RecoveryListHeldResponse,
  RecoveryRefusal,
  RecoveryRefusalReason,
  RecoveryStuckAttemptView,
} from '../../shared/operator/recovery.js';
import type {
  PaymentsCancelRequest,
  PaymentsCancelResponse,
  PaymentsConfirmRequest,
  PaymentsConfirmResponse,
  TenderApplyRequest,
  TenderApplyResponse,
} from '../../shared/bridge-api.js';
import type { DatabaseHandle } from '../db/client.js';
import type { CartStore } from '../cart/cart-store.js';
import type {
  ApprovalSubject,
  ApprovalSubjectResolver,
  ManagerApprovalService,
} from '../operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../operator/session-manager.js';
import type { OperatorSessionForPayments } from '../payments/require-operator-session.js';

/** The payment handlers, run under a recovery-scoped session. */
export interface RecoveryPaymentPort {
  apply(scope: OperatorSessionForPayments, req: TenderApplyRequest): Promise<TenderApplyResponse>;
  confirm(
    scope: OperatorSessionForPayments,
    req: PaymentsConfirmRequest,
  ): Promise<PaymentsConfirmResponse>;
  cancel(
    scope: OperatorSessionForPayments,
    req: PaymentsCancelRequest,
  ): Promise<PaymentsCancelResponse>;
}

/** The three payment handlers, built against a given session getter. */
export interface RecoveryPaymentHandlers {
  apply: (req: TenderApplyRequest) => Promise<TenderApplyResponse>;
  confirm: (req: PaymentsConfirmRequest) => Promise<PaymentsConfirmResponse>;
  cancel: (req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>;
}

/**
 * The recovery payment port: handlers built once with a getter that answers
 * the scope of the call in flight, and nothing outside one. Recovery runs one
 * action at a time, so one slot is enough.
 */
export function createRecoveryPaymentPort(
  build: (getCurrentSession: () => OperatorSessionForPayments | null) => RecoveryPaymentHandlers,
): RecoveryPaymentPort {
  let scope: OperatorSessionForPayments | null = null;
  const handlers = build(() => scope);
  async function within<T>(next: OperatorSessionForPayments, run: () => Promise<T>): Promise<T> {
    scope = next;
    try {
      return await run();
    } finally {
      scope = null;
    }
  }
  return {
    apply: (s, req) => within(s, () => handlers.apply(req)),
    confirm: (s, req) => within(s, () => handlers.confirm(req)),
    cancel: (s, req) => within(s, () => handlers.cancel(req)),
  };
}

export interface ManagerRecoveryDeps {
  db: DatabaseHandle;
  getSession: () => OperatorSessionRecord | null;
  /** The pairing row's real terminal_id, or null when unpaired. */
  resolveTerminalId: () => string | null;
  approvals: Pick<ManagerApprovalService, 'consume'>;
  cartStore: Pick<CartStore, 'cancelCartAndOutbox'>;
  payments: RecoveryPaymentPort;
  auditEmitter: { emit(event: AuditEvent): void };
  /** End the recovery session (a sign-out, with its backend tail). */
  endRecoverySession: () => Promise<unknown>;
  clock?: () => Date;
  logger?: Pick<Logger, 'info' | 'error'>;
}

export interface ManagerRecovery {
  listHeld(): RecoveryListHeldResponse;
  completeAttempt(req: RecoveryCompleteAttemptRequest): Promise<RecoveryCompleteAttemptResponse>;
  cancelAttempt(req: RecoveryCancelAttemptRequest): Promise<RecoveryCancelAttemptResponse>;
  cancelHeldCart(req: RecoveryCancelHeldCartRequest): RecoveryCancelHeldCartResponse;
  /** The approval subjects of the three recovery kinds (MA-2 resolvers). */
  resolvers: {
    completeAttempt: ApprovalSubjectResolver;
    cancelAttempt: ApprovalSubjectResolver;
    cancelHeldCart: ApprovalSubjectResolver;
  };
}

interface StuckRow {
  payment_attempt_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  acting_operator_id: string;
  operator_session_id: string;
  envelope_cart_id: string;
  envelope_subtotal_minor: number;
  started_at: string;
  last_action_id: string;
}

interface HeldRow {
  cart_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  owning_operator_id: string;
  operator_session_id: string;
  state: string;
  cart_subtotal_minor: number;
  last_action_id: string | null;
  updated_at: string;
  parked: number;
}

interface LiveLine {
  tender_type: string;
  amount_applied_minor: number;
}

type Get<T> = { get(...params: unknown[]): T | undefined };
type All<T> = { all(...params: unknown[]): T[] };

const LIVE = `('applying', 'applied', 'reversal_pending')`;

class RecoveryRefused extends Error {
  constructor(readonly reason: RecoveryRefusalReason) {
    super(reason);
    this.name = 'RecoveryRefused';
  }
}

const refused = (reason: RecoveryRefusalReason): RecoveryRefusal => ({ kind: 'refused', reason });

/** A manager / admin session on this paired terminal, as `manager()` admits it. */
interface Admitted {
  session: OperatorSessionRecord;
  terminal_id: string;
}

/** The input an MA-2 subject resolver receives. */
interface SubjectInput {
  subjectRef: string;
  session: OperatorSessionRecord;
}

function admissionRefusal(session: OperatorSessionRecord | null): RecoveryRefusalReason | null {
  if (session === null) return 'no_session';
  if (session.lock_state === 'locked') return 'session_locked';
  const isManager = session.role === 'manager' || session.role === 'admin';
  return isManager ? null : 'role_mismatch';
}

/** §5.2: live cash or card tender needs its confirmation before anything is spent. */
function confirmationMissing(
  liveTypes: ReadonlySet<string>,
  req: RecoveryCancelAttemptRequest,
): boolean {
  const cashUnconfirmed = liveTypes.has('cash') && req.cash_returned_confirmed !== true;
  const cardUnconfirmed =
    liveTypes.has('external_card_terminal') && req.card_void_confirmed_on_terminal !== true;
  return cashUnconfirmed || cardUnconfirmed;
}

type CartCancellation = Parameters<CartStore['cancelCartAndOutbox']>;

/**
 * The cart write of a manager cancel: `manager_cancelled_held` for a draft,
 * `manager_voided_post_handoff` for a handed-off cart. The original operator
 * acts; the manager is the attribution.
 */
function heldCancellation(
  row: HeldRow,
  session: OperatorSessionRecord,
  stamp: { approval_id: string; at: string; action_id: string },
): CartCancellation {
  const frozen = row.state === 'frozen_handed_off';
  const { approval_id, at, action_id } = stamp;
  return [
    {
      cart_id: row.cart_id,
      cancelled_at: at,
      cancellation_reason: frozen ? 'manager_voided_post_handoff' : 'manager_cancelled_held',
      last_action_id: action_id,
      updated_at: at,
    },
    {
      action_id,
      cart_id: row.cart_id,
      line_id: null,
      action_kind: frozen ? 'cart.cancel.post_handoff' : 'cart.void',
      acting_operator_id: row.owning_operator_id,
      attribution_operator_id: session.operator_id,
      operator_session_id: row.operator_session_id,
      payload_json: JSON.stringify({ cart_id: row.cart_id, approval_id, recovery: true }),
      applied_at: at,
    },
  ];
}

export function createManagerRecovery(deps: ManagerRecoveryDeps): ManagerRecovery {
  const { db } = deps;
  const now = (): string => (deps.clock?.() ?? new Date()).toISOString();
  let busy = false;

  /** A live, unlocked manager / admin session on a paired terminal. */
  function manager(): Admitted | RecoveryRefusal {
    const session = deps.getSession();
    const reason = admissionRefusal(session);
    if (reason !== null || session === null) return refused(reason ?? 'no_session');
    const terminal_id = deps.resolveTerminalId();
    if (terminal_id === null) return refused('no_session');
    return { session, terminal_id };
  }

  /** The terminal named on a resolver call, for the session asking. */
  function admittedFor(session: OperatorSessionRecord): Admitted | null {
    const terminal_id = deps.resolveTerminalId();
    return terminal_id === null ? null : { session, terminal_id };
  }

  const stuckRow = (at: Admitted): StuckRow | undefined =>
    (
      db.prepare(
        `SELECT a.payment_attempt_id, a.tenant_id, a.branch_id, a.terminal_id,
                a.acting_operator_id, a.operator_session_id, a.envelope_cart_id,
                a.envelope_subtotal_minor, a.started_at, a.last_action_id
           FROM payment_attempts a
          WHERE a.terminal_id = ? AND a.state = 'started' AND a.operator_session_id <> ?
            AND EXISTS (SELECT 1 FROM payment_tender_lines l
                         WHERE l.payment_attempt_id = a.payment_attempt_id AND l.state IN ${LIVE})
          LIMIT 1`,
      ) as Get<StuckRow>
    ).get(at.terminal_id, at.session.id);

  const liveLines = (row: Pick<StuckRow, 'payment_attempt_id'>): LiveLine[] =>
    (
      db.prepare(
        `SELECT tender_type, amount_applied_minor FROM payment_tender_lines
          WHERE payment_attempt_id = ? AND state IN ${LIVE}`,
      ) as All<LiveLine>
    ).all(row.payment_attempt_id);

  const lineCount = (cart_id: string): number =>
    (
      db.prepare(
        `SELECT COUNT(*) AS n FROM cart_lines WHERE cart_id = ? AND removed_at IS NULL`,
      ) as Get<{ n: number }>
    ).get(cart_id)?.n ?? 0;

  /**
   * Held carts of OTHER sessions on this terminal: a draft, or a handed-off
   * cart whose sale is open (not settled, no open attempt, no force-failed
   * live tender). The stuck attempt's cart is listed as the stuck payment.
   */
  const heldRows = (at: Admitted, cart_id?: string): HeldRow[] =>
    (
      db.prepare(
        `SELECT c.cart_id, c.tenant_id, c.branch_id, c.terminal_id, c.owning_operator_id,
                c.operator_session_id, c.state, c.cart_subtotal_minor, c.last_action_id,
                c.updated_at, c.parked_at IS NOT NULL AS parked
           FROM carts c
          WHERE c.terminal_id = ? AND c.operator_session_id <> ?
            AND c.state IN ('editing', 'discount_pending_attribution', 'frozen_handed_off')
            ${cart_id === undefined ? '' : 'AND c.cart_id = ?'}
            AND NOT EXISTS (
              SELECT 1 FROM payment_attempts a
               WHERE a.envelope_cart_id = c.cart_id
                 AND (a.state IN ('settled', 'started')
                      OR (a.state = 'force_failed' AND EXISTS (
                            SELECT 1 FROM payment_tender_lines l
                             WHERE l.payment_attempt_id = a.payment_attempt_id
                               AND l.state IN ${LIVE}))))
          ORDER BY c.updated_at DESC, c.rowid DESC`,
      ) as All<HeldRow>
    ).all(at.terminal_id, at.session.id, ...(cart_id === undefined ? [] : [cart_id]));

  /** Another operator's held cart (never the asker's own), or null. */
  function othersHeldCart(at: Admitted, cart_id: string): HeldRow | null {
    const [row] = heldRows(at, cart_id);
    if (row === undefined || row.owning_operator_id === at.session.operator_id) return null;
    return row;
  }

  function stuckView(row: StuckRow): RecoveryStuckAttemptView {
    const lines = liveLines(row);
    const sum = (type: string): number =>
      lines.filter((l) => l.tender_type === type).reduce((n, l) => n + l.amount_applied_minor, 0);
    const paid = lines.reduce((n, l) => n + l.amount_applied_minor, 0);
    return {
      payment_attempt_id: row.payment_attempt_id,
      cart_id: row.envelope_cart_id,
      owning_operator_id: row.acting_operator_id,
      line_count: lineCount(row.envelope_cart_id),
      total_minor: row.envelope_subtotal_minor,
      cash_minor: sum('cash'),
      card_minor: sum('external_card_terminal'),
      voucher_minor: sum('internal_voucher'),
      remaining_minor: Math.max(0, row.envelope_subtotal_minor - paid),
      started_at: row.started_at,
    };
  }

  function heldView(row: HeldRow): RecoveryHeldCartView {
    return {
      cart_id: row.cart_id,
      owning_operator_id: row.owning_operator_id,
      kind: row.state === 'frozen_handed_off' ? 'handed_off' : 'draft',
      parked: row.parked === 1,
      line_count: lineCount(row.cart_id),
      total_minor: row.cart_subtotal_minor,
      updated_at: row.updated_at,
    };
  }

  // ── Approval subjects (MA-2 resolvers) ──────────────────────────────────

  /** The stuck attempt named by `subjectRef`, if it is another operator's. */
  function othersStuckAttempt(input: SubjectInput): StuckRow | null {
    const at = admittedFor(input.session);
    const row = at === null ? undefined : stuckRow(at);
    if (row?.payment_attempt_id !== input.subjectRef) return null;
    return row.acting_operator_id === input.session.operator_id ? null : row;
  }

  function attemptSubject(
    input: SubjectInput,
    amount: (row: StuckRow) => number,
  ): ApprovalSubject | null {
    const row = othersStuckAttempt(input);
    if (row === null) return null;
    return {
      version: attemptVersion(row),
      amountMinor: amount(row),
      requesterOperatorId: row.acting_operator_id,
    };
  }

  /**
   * The attempt as an approval sees it: its last attempt-level action and
   * every tender line's id, state and amount. A tender change does not touch
   * the attempt row, so the lines are part of the version.
   */
  function attemptVersion(row: StuckRow): string {
    const lines = (
      db.prepare(
        `SELECT tender_line_id, state, amount_applied_minor FROM payment_tender_lines
          WHERE payment_attempt_id = ? ORDER BY apply_order, tender_line_id`,
      ) as All<{ tender_line_id: string; state: string; amount_applied_minor: number }>
    ).all(row.payment_attempt_id);
    const tender = lines.map(
      (l) => `${l.tender_line_id}:${l.state}:${String(l.amount_applied_minor)}`,
    );
    return `attempt:${row.last_action_id}|${tender.join(',')}`;
  }

  const liveTotal = (row: StuckRow): number =>
    liveLines(row).reduce((n, l) => n + l.amount_applied_minor, 0);

  function cartSubject(input: SubjectInput): ApprovalSubject | null {
    const at = admittedFor(input.session);
    const row = at === null ? null : othersHeldCart(at, input.subjectRef);
    if (row === null) return null;
    return {
      version: `cart:${row.last_action_id ?? row.updated_at}`,
      amountMinor: row.cart_subtotal_minor,
      requesterOperatorId: row.owning_operator_id,
    };
  }

  const resolvers = {
    completeAttempt: (input: SubjectInput) =>
      attemptSubject(input, (row) => row.envelope_subtotal_minor),
    cancelAttempt: (input: SubjectInput) => attemptSubject(input, liveTotal),
    cancelHeldCart: (input: SubjectInput) => cartSubject(input),
  };

  // ── Shared steps ─────────────────────────────────────────────────────────

  function audit(input: {
    category:
      | 'payment.recovery_completed'
      | 'payment.recovery_cancelled'
      | 'cart.held_cancelled_by_manager';
    scope: { tenant_id: string; branch_id: string; terminal_id: string };
    original_operator_id: string;
    session: OperatorSessionRecord;
    approver_user_id: string;
    payload: Record<string, unknown>;
  }): void {
    try {
      deps.auditEmitter.emit({
        event_id: randomUUID(),
        tenant_id: input.scope.tenant_id,
        branch_id: input.scope.branch_id,
        originating_terminal_id: input.scope.terminal_id,
        acting_operator_id: input.original_operator_id,
        session_id: input.session.id,
        shift_id: null,
        action_category: input.category,
        created_at: now(),
        approving_supervisor_id: input.approver_user_id,
        payload: input.payload,
      });
    } catch (err) {
      deps.logger?.error({ err, category: input.category }, 'recovery.audit_failed');
    }
  }

  /** Consume the attempt approval on its own; the payment calls follow. */
  function consumeForAttempt(
    kind: 'recovery.complete_attempt' | 'recovery.cancel_attempt',
    req: { payment_attempt_id: string; approval_id: string },
    session: OperatorSessionRecord,
  ): string {
    const input = { subjectRef: req.payment_attempt_id, session };
    const subject =
      kind === 'recovery.complete_attempt'
        ? resolvers.completeAttempt(input)
        : resolvers.cancelAttempt(input);
    if (subject === null) throw new RecoveryRefused('not_found');
    const outcome = db.transaction(() =>
      deps.approvals.consume({
        approvalId: req.approval_id,
        actionKind: kind,
        subjectRef: req.payment_attempt_id,
        subject,
        session,
      }),
    )();
    if (outcome.kind === 'refused') throw new RecoveryRefused(outcome.reason);
    return outcome.approverUserId;
  }

  /** The attempt's own session id (M5), the manager as the acting operator. */
  function scopeFor(row: StuckRow, session: OperatorSessionRecord): OperatorSessionForPayments {
    return {
      role: session.role,
      operator_id: session.operator_id,
      operator_session_id: row.operator_session_id,
      tenant_id: row.tenant_id,
      branch_id: row.branch_id,
      terminal_id: row.terminal_id,
      display_name: session.display_name,
    };
  }

  async function finishRecovery(session: OperatorSessionRecord, row: StuckRow): Promise<void> {
    if (session.recovery_of !== row.payment_attempt_id) return;
    try {
      await deps.endRecoverySession();
    } catch (err) {
      deps.logger?.error({ err }, 'recovery.end_session_failed');
    }
  }

  /** A refusal thrown inside becomes the answer; anything else is logged. */
  function refusalOf(err: unknown, logAs: string): RecoveryRefusal {
    if (err instanceof RecoveryRefused) return refused(err.reason);
    deps.logger?.error({ err }, logAs);
    return refused('recovery_unavailable');
  }

  /** One recovery action at a time. */
  async function guarded<T>(run: () => Promise<T>): Promise<T | RecoveryRefusal> {
    if (busy) return refused('recovery_unavailable');
    busy = true;
    try {
      return await run();
    } catch (err) {
      return refusalOf(err, 'recovery.failed');
    } finally {
      busy = false;
    }
  }

  function stuckFor(req: {
    payment_attempt_id: string;
  }): { session: OperatorSessionRecord; row: StuckRow } | RecoveryRefusal {
    const admitted = manager();
    if ('kind' in admitted) return admitted;
    const row = stuckRow(admitted);
    if (row?.payment_attempt_id !== req.payment_attempt_id) return refused('not_found');
    return { session: admitted.session, row };
  }

  /** Collect the remaining cash, if any; the change due, or a refusal. */
  async function collectRemaining(
    row: StuckRow,
    session: OperatorSessionRecord,
    req: RecoveryCompleteAttemptRequest,
    remaining_minor: number,
  ): Promise<number | RecoveryRefusal> {
    if (remaining_minor === 0) return 0;
    const applied = await deps.payments.apply(scopeFor(row, session), {
      payment_attempt_id: row.payment_attempt_id,
      tender_type: 'cash',
      amount_applied_minor: req.cash_received_minor ?? 0,
      idempotency_key: `${req.approval_id}:apply`,
    });
    if (applied.kind !== 'ok') return refused('payment_refused');
    return applied.change_due_minor ?? 0;
  }

  async function completeStuck(
    row: StuckRow,
    session: OperatorSessionRecord,
    req: RecoveryCompleteAttemptRequest,
  ): Promise<RecoveryCompleteAttemptResponse> {
    const { remaining_minor } = stuckView(row);
    const cash = req.cash_received_minor ?? 0;
    if (remaining_minor > 0 && cash < remaining_minor) return refused('cash_insufficient');
    const approver = consumeForAttempt('recovery.complete_attempt', req, session);
    const change = await collectRemaining(row, session, req, remaining_minor);
    if (typeof change !== 'number') return change;
    const confirmed = await deps.payments.confirm(scopeFor(row, session), {
      payment_attempt_id: row.payment_attempt_id,
      idempotency_key: `${req.approval_id}:confirm`,
    });
    if (confirmed.kind !== 'ok') return refused('payment_refused');
    audit({
      category: 'payment.recovery_completed',
      scope: row,
      original_operator_id: row.acting_operator_id,
      session,
      approver_user_id: approver,
      payload: {
        payment_attempt_id: row.payment_attempt_id,
        cart_id: row.envelope_cart_id,
        approval_id: req.approval_id,
      },
    });
    await finishRecovery(session, row);
    return { kind: 'completed', change_due_minor: change };
  }

  async function cancelStuck(
    row: StuckRow,
    session: OperatorSessionRecord,
    req: RecoveryCancelAttemptRequest,
  ): Promise<RecoveryCancelAttemptResponse> {
    const liveTypes = new Set(liveLines(row).map((l) => l.tender_type));
    if (confirmationMissing(liveTypes, req)) return refused('confirmation_required');
    const approver = consumeForAttempt('recovery.cancel_attempt', req, session);
    const cancelled = await deps.payments.cancel(scopeFor(row, session), {
      payment_attempt_id: row.payment_attempt_id,
      idempotency_key: `${req.approval_id}:cancel`,
    });
    if (cancelled.kind !== 'ok') return refused('payment_refused');
    audit({
      category: 'payment.recovery_cancelled',
      scope: row,
      original_operator_id: row.acting_operator_id,
      session,
      approver_user_id: approver,
      payload: {
        payment_attempt_id: row.payment_attempt_id,
        cart_id: row.envelope_cart_id,
        approval_id: req.approval_id,
        cash_returned_confirmed: req.cash_returned_confirmed === true,
        card_void_confirmed_on_terminal: req.card_void_confirmed_on_terminal === true,
      },
    });
    await finishRecovery(session, row);
    return { kind: 'cancelled' };
  }

  /** The cancel and its approval commit together, inside the caller's transaction. */
  function cancelHeldInTransaction(
    row: HeldRow,
    session: OperatorSessionRecord,
    req: RecoveryCancelHeldCartRequest,
  ): void {
    const subject = cartSubject({ subjectRef: req.cart_id, session });
    if (subject === null) throw new RecoveryRefused('not_found');
    const consumed = deps.approvals.consume({
      approvalId: req.approval_id,
      actionKind: 'recovery.cancel_held_cart',
      subjectRef: req.cart_id,
      subject,
      session,
    });
    if (consumed.kind === 'refused') throw new RecoveryRefused(consumed.reason);
    const stamp = { approval_id: req.approval_id, at: now(), action_id: randomUUID() };
    deps.cartStore.cancelCartAndOutbox(...heldCancellation(row, session, stamp));
    audit({
      category: 'cart.held_cancelled_by_manager',
      scope: row,
      original_operator_id: row.owning_operator_id,
      session,
      approver_user_id: consumed.approverUserId,
      payload: {
        cart_id: row.cart_id,
        approval_id: req.approval_id,
        kind: row.state === 'frozen_handed_off' ? 'handed_off' : 'draft',
        parked: row.parked === 1,
      },
    });
  }

  return {
    resolvers,

    listHeld() {
      const admitted = manager();
      if ('kind' in admitted) return admitted;
      const stuck = stuckRow(admitted);
      return {
        kind: 'held',
        recovery_mode: admitted.session.recovery_of !== undefined,
        stuck: stuck === undefined ? null : stuckView(stuck),
        held: heldRows(admitted).map(heldView),
      };
    },

    completeAttempt(req) {
      return guarded(async () => {
        const found = stuckFor(req);
        return 'kind' in found ? found : completeStuck(found.row, found.session, req);
      });
    },

    cancelAttempt(req) {
      return guarded(async () => {
        const found = stuckFor(req);
        return 'kind' in found ? found : cancelStuck(found.row, found.session, req);
      });
    },

    cancelHeldCart(req) {
      const admitted = manager();
      if ('kind' in admitted) return admitted;
      const row = othersHeldCart(admitted, req.cart_id);
      if (row === null) return refused('not_found');
      try {
        db.transaction(() => {
          cancelHeldInTransaction(row, admitted.session, req);
        })();
      } catch (err) {
        return refusalOf(err, 'recovery.cancel_held_cart_failed');
      }
      return { kind: 'cancelled' };
    },
  };
}
