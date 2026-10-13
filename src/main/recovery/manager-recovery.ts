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

/** Spec 024: `carts.parked_at` exists once PK-2's migration has run. */
function parkedColumn(db: DatabaseHandle): string {
  const cols = (db.prepare(`PRAGMA table_info(carts)`) as All<{ name: string }>).all();
  return cols.some((c) => c.name === 'parked_at') ? 'parked_at IS NOT NULL' : '0';
}

class RecoveryRefused extends Error {
  constructor(readonly reason: RecoveryRefusalReason) {
    super(reason);
    this.name = 'RecoveryRefused';
  }
}

const refused = (reason: RecoveryRefusalReason): RecoveryRefusal => ({ kind: 'refused', reason });

export function createManagerRecovery(deps: ManagerRecoveryDeps): ManagerRecovery {
  const { db } = deps;
  const now = (): string => (deps.clock?.() ?? new Date()).toISOString();
  let busy = false;

  /** A live, unlocked manager / admin session on a paired terminal. */
  function manager(): { session: OperatorSessionRecord; terminal_id: string } | RecoveryRefusal {
    const session = deps.getSession();
    if (session === null) return refused('no_session');
    if (session.lock_state === 'locked') return refused('session_locked');
    if (session.role !== 'manager' && session.role !== 'admin') return refused('role_mismatch');
    const terminal_id = deps.resolveTerminalId();
    if (terminal_id === null) return refused('no_session');
    return { session, terminal_id };
  }

  const stuckRow = (terminal_id: string, session_id: string): StuckRow | undefined =>
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
    ).get(terminal_id, session_id);

  const liveLines = (payment_attempt_id: string): LiveLine[] =>
    (
      db.prepare(
        `SELECT tender_type, amount_applied_minor FROM payment_tender_lines
          WHERE payment_attempt_id = ? AND state IN ${LIVE}`,
      ) as All<LiveLine>
    ).all(payment_attempt_id);

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
  const heldRows = (terminal_id: string, session_id: string, cart_id?: string): HeldRow[] =>
    (
      db.prepare(
        `SELECT c.cart_id, c.tenant_id, c.branch_id, c.terminal_id, c.owning_operator_id,
                c.operator_session_id, c.state, c.cart_subtotal_minor, c.last_action_id,
                c.updated_at, ${parkedColumn(db)} AS parked
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
    ).all(...[terminal_id, session_id, ...(cart_id === undefined ? [] : [cart_id])]);

  function stuckView(row: StuckRow): RecoveryStuckAttemptView {
    const lines = liveLines(row.payment_attempt_id);
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

  function attemptSubject(
    subjectRef: string,
    session: OperatorSessionRecord,
    amount: (row: StuckRow) => number,
  ): ApprovalSubject | null {
    const terminal_id = deps.resolveTerminalId();
    if (terminal_id === null) return null;
    const row = stuckRow(terminal_id, session.id);
    if (row?.payment_attempt_id !== subjectRef || row.acting_operator_id === session.operator_id) {
      return null;
    }
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
    liveLines(row.payment_attempt_id).reduce((n, l) => n + l.amount_applied_minor, 0);

  function cartSubject(subjectRef: string, session: OperatorSessionRecord): ApprovalSubject | null {
    const terminal_id = deps.resolveTerminalId();
    if (terminal_id === null) return null;
    const [row] = heldRows(terminal_id, session.id, subjectRef);
    if (row === undefined || row.owning_operator_id === session.operator_id) return null;
    return {
      version: `cart:${row.last_action_id ?? row.updated_at}`,
      amountMinor: row.cart_subtotal_minor,
      requesterOperatorId: row.owning_operator_id,
    };
  }

  const resolvers = {
    completeAttempt: ({
      subjectRef,
      session,
    }: {
      subjectRef: string;
      session: OperatorSessionRecord;
    }) => attemptSubject(subjectRef, session, (row) => row.envelope_subtotal_minor),
    cancelAttempt: ({
      subjectRef,
      session,
    }: {
      subjectRef: string;
      session: OperatorSessionRecord;
    }) => attemptSubject(subjectRef, session, liveTotal),
    cancelHeldCart: ({
      subjectRef,
      session,
    }: {
      subjectRef: string;
      session: OperatorSessionRecord;
    }) => cartSubject(subjectRef, session),
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
    const subject =
      kind === 'recovery.complete_attempt'
        ? resolvers.completeAttempt({ subjectRef: req.payment_attempt_id, session })
        : resolvers.cancelAttempt({ subjectRef: req.payment_attempt_id, session });
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

  async function finishRecovery(session: OperatorSessionRecord, attempt_id: string) {
    if (session.recovery_of !== attempt_id) return;
    try {
      await deps.endRecoverySession();
    } catch (err) {
      deps.logger?.error({ err }, 'recovery.end_session_failed');
    }
  }

  /** One recovery action at a time; any refusal thrown inside becomes the answer. */
  async function guarded<T>(run: () => Promise<T>): Promise<T | RecoveryRefusal> {
    if (busy) return refused('recovery_unavailable');
    busy = true;
    try {
      return await run();
    } catch (err) {
      if (err instanceof RecoveryRefused) return refused(err.reason);
      deps.logger?.error({ err }, 'recovery.failed');
      return refused('recovery_unavailable');
    } finally {
      busy = false;
    }
  }

  function stuckFor(
    payment_attempt_id: string,
  ): { session: OperatorSessionRecord; row: StuckRow } | RecoveryRefusal {
    const admitted = manager();
    if ('kind' in admitted) return admitted;
    const row = stuckRow(admitted.terminal_id, admitted.session.id);
    if (row?.payment_attempt_id !== payment_attempt_id) return refused('not_found');
    return { session: admitted.session, row };
  }

  return {
    resolvers,

    listHeld() {
      const admitted = manager();
      if ('kind' in admitted) return admitted;
      const { session, terminal_id } = admitted;
      const stuck = stuckRow(terminal_id, session.id);
      return {
        kind: 'held',
        recovery_mode: session.recovery_of !== undefined,
        stuck: stuck === undefined ? null : stuckView(stuck),
        held: heldRows(terminal_id, session.id).map(heldView),
      };
    },

    completeAttempt(req) {
      return guarded(async () => {
        const found = stuckFor(req.payment_attempt_id);
        if ('kind' in found) return found;
        const { session, row } = found;
        const { remaining_minor } = stuckView(row);
        const cash = req.cash_received_minor ?? 0;
        if (remaining_minor > 0 && cash < remaining_minor) return refused('cash_insufficient');
        const approver = consumeForAttempt('recovery.complete_attempt', req, session);
        const scope = scopeFor(row, session);
        let change = 0;
        if (remaining_minor > 0) {
          const applied = await deps.payments.apply(scope, {
            payment_attempt_id: row.payment_attempt_id,
            tender_type: 'cash',
            amount_applied_minor: cash,
            idempotency_key: `${req.approval_id}:apply`,
          });
          if (applied.kind !== 'ok') return refused('payment_refused');
          change = applied.change_due_minor ?? 0;
        }
        const confirmed = await deps.payments.confirm(scope, {
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
        await finishRecovery(session, row.payment_attempt_id);
        return { kind: 'completed' as const, change_due_minor: change };
      });
    },

    cancelAttempt(req) {
      return guarded(async () => {
        const found = stuckFor(req.payment_attempt_id);
        if ('kind' in found) return found;
        const { session, row } = found;
        const types = new Set(liveLines(row.payment_attempt_id).map((l) => l.tender_type));
        if (
          (types.has('cash') && req.cash_returned_confirmed !== true) ||
          (types.has('external_card_terminal') && req.card_void_confirmed_on_terminal !== true)
        ) {
          return refused('confirmation_required');
        }
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
        await finishRecovery(session, row.payment_attempt_id);
        return { kind: 'cancelled' as const };
      });
    },

    cancelHeldCart(req) {
      const admitted = manager();
      if ('kind' in admitted) return admitted;
      const { session, terminal_id } = admitted;
      const [row] = heldRows(terminal_id, session.id, req.cart_id);
      if (row === undefined || row.owning_operator_id === session.operator_id) {
        return refused('not_found');
      }
      const frozen = row.state === 'frozen_handed_off';
      try {
        db.transaction(() => {
          const subject = cartSubject(req.cart_id, session);
          if (subject === null) throw new RecoveryRefused('not_found');
          const consumed = deps.approvals.consume({
            approvalId: req.approval_id,
            actionKind: 'recovery.cancel_held_cart',
            subjectRef: req.cart_id,
            subject,
            session,
          });
          if (consumed.kind === 'refused') throw new RecoveryRefused(consumed.reason);
          const at = now();
          const action_id = randomUUID();
          deps.cartStore.cancelCartAndOutbox(
            {
              cart_id: row.cart_id,
              cancelled_at: at,
              cancellation_reason: frozen
                ? 'manager_voided_post_handoff'
                : 'manager_cancelled_held',
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
              payload_json: JSON.stringify({
                cart_id: row.cart_id,
                approval_id: req.approval_id,
                recovery: true,
              }),
              applied_at: at,
            },
          );
          audit({
            category: 'cart.held_cancelled_by_manager',
            scope: row,
            original_operator_id: row.owning_operator_id,
            session,
            approver_user_id: consumed.approverUserId,
            payload: {
              cart_id: row.cart_id,
              approval_id: req.approval_id,
              kind: frozen ? 'handed_off' : 'draft',
              parked: row.parked === 1,
            },
          });
        })();
      } catch (err) {
        if (err instanceof RecoveryRefused) return refused(err.reason);
        deps.logger?.error({ err }, 'recovery.cancel_held_cart_failed');
        return refused('recovery_unavailable');
      }
      return { kind: 'cancelled' };
    },
  };
}
