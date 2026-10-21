/**
 * 004-operator-session T089 — forced-close handler (RT-554 (b)).
 *
 * Handles a manager/admin's forced close of a stuck shift OF THIS TERMINAL:
 * the terminal's open shift in the cash-up tables (`shift_cashup_opens`), the
 * cash-up computed in main from local truth and the manager's blind count, and
 * the contract forced close (`closeKind: forced`) queued as a manager-envelope
 * row for Backend-Core. The legacy 004 `shifts` table (0007) is not used: no
 * production code ever wrote it, which is why every forced close used to be
 * refused with the generic "state changed".
 *
 * Enforces: role gate (AD-1), the live manager identity (`users.id`),
 * idempotency by `event_id`, and audit emission (FR-028 / FR-025) in the SAME
 * transaction as the close (a failed audit leaves the shift open).
 *
 * Refusals: a shift this terminal does not hold → `not_closable_here`
 * (Backend-Core resolves a shift only for the device that opened it); one this
 * terminal already closed → `state_invalid` once Backend-Core has the close
 * (the list is only stale) and `closed_here_unsent` before that (it is still
 * on the list); in-flight drawer cash or parked sales → `close_blocked`. The count, the reason and every id stay out of the
 * logs (P7).
 */

import type { Logger } from 'pino';
import type { DatabaseHandle } from '../db/client.js';
import type { SessionManager, OperatorSessionRecord } from './session-manager.js';
import type { PairingStore } from '../pairing/store.js';
import type { AuditEmitter } from '../audit/audit-emitter.js';
import type {
  OperatorRefusal,
  AuditEvent,
  RefusalCategory,
} from '../../shared/audit/event-shape.js';
import { OperatorRefusalError } from '../../shared/audit/event-shape.js';
import type { ForceCloseShiftRequest, ForceCloseShiftResponse } from '../../shared/bridge-api.js';
import { requireRole } from './role-enforcement.js';
import {
  ShiftCashupRefusedError,
  type ForcedClosedShift,
  type ShiftCashupRefusalReason,
  type ShiftCashupService,
} from '../shift-cashup/shift-cashup-service.js';
import { ShiftCashupStateError } from '../shift-cashup/shift-cashup-repo.js';

// ─── Local prepare shape ──────────────────────────────────────────────────────

type PrepareGet<T> = { get(...p: unknown[]): T | undefined };

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface ForcedCloseHandlerDeps {
  /** The audit idempotency read and the "already closed here" read; no writes. */
  db: DatabaseHandle;
  sessionManager: Pick<SessionManager, 'getCurrent'>;
  pairingStore: Pick<PairingStore, 'getStatus'>;
  auditEmitter: AuditEmitter;
  /** The cash-up service over the terminal's own tables. */
  shiftCashup: Pick<ShiftCashupService, 'forceCloseShift'>;
  /**
   * Kicks the shift sync drain and resolves true when the queue is empty
   * afterwards (the forced close reached Backend-Core). Absent: never "sent".
   */
  deliverNow?: () => Promise<boolean>;
  /**
   * RT-772: called once a committed forced close has finished its delivery attempt (sent or
   * queued), just before the handler answers. A safe-point trigger for an update install: it
   * runs after the drain, never during it, and can never fail the close.
   */
  onCloseDelivered?: () => void;
  /** Optional logger. Tests omit it. */
  logger?: Logger;
}

/** What each cash-up refusal means to the manager (exhaustive by type). */
const CATEGORY_OF_REASON: Readonly<Record<ShiftCashupRefusalReason, RefusalCategory>> = {
  // The cash-up is off: this terminal records no shifts, so it holds none.
  feature_disabled: 'not_closable_here',
  no_session: 'not_signed_in',
  session_locked: 'not_signed_in',
  no_cashier_identity: 'not_signed_in',
  pay_out_exceeds_drawer_cash: 'invalid_input',
  variance_approval_required: 'invalid_input',
  clock_regressed: 'invalid_input',
  drawer_activity_pending: 'close_blocked',
  parked_sales_present: 'close_blocked',
  approver_invalid: 'invalid_input',
  approver_locked: 'invalid_input',
  approver_is_closer: 'invalid_input',
  approver_expired: 'invalid_input',
  approval_stale: 'invalid_input',
  aggregate_out_of_range: 'invalid_input',
  amount_out_of_range: 'invalid_input',
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export class ForcedCloseHandler {
  constructor(private readonly deps: ForcedCloseHandlerDeps) {}

  async forceCloseShift(
    req: ForceCloseShiftRequest,
  ): Promise<ForceCloseShiftResponse | OperatorRefusal> {
    const session = this.deps.sessionManager.getCurrent();

    try {
      requireRole(['manager', 'admin'], session);
    } catch (err) {
      if (err instanceof OperatorRefusalError) return this.refuse(err.category);
      return this.refuse('invalid_input');
    }

    // requireRole throws on null session — safe to narrow here.
    const actor = session as OperatorSessionRecord;

    // The closing user of the fact is the manager's `users.id`, captured at
    // their online sign-in; without it the manager must sign in again.
    const managerUserId = actor.manager_user_id;
    if (managerUserId === undefined || managerUserId === '') return this.refuse('not_signed_in');

    const shiftId = req.shift_id.toLowerCase();

    // Idempotency (AD-3): the same event_id already recorded → success no-op.
    // Delivery is kicked again: the first answer may have been lost.
    if (this.alreadyRecorded({ eventId: req.event_id, tenantId: actor.tenant_id, shiftId })) {
      return this.forcedClosed({ req, outcome: 'forced_closed_idempotent' });
    }

    // Pre-fetch async work before the synchronous write.
    const originatingTerminalId = await this.originatingTerminalId();

    try {
      this.deps.shiftCashup.forceCloseShift({
        shiftId,
        countedCashMinor: req.counted_cash_minor,
        forcedReason: req.reason,
        managerUserId,
        operatorSessionId: actor.id,
        // Inside the close's transaction: a failed audit leaves the shift open.
        onRecorded: (closed) => {
          this.deps.auditEmitter.emit(
            this.auditEvent({ req, actor, originatingTerminalId, closed }),
          );
        },
      });
    } catch (err) {
      return this.refuse(await this.categoryOf({ err, shiftId }));
    }

    return this.forcedClosed({ req, outcome: 'forced_closed' });
  }

  private async forcedClosed(input: {
    req: ForceCloseShiftRequest;
    outcome: string;
  }): Promise<ForceCloseShiftResponse> {
    const delivery = await this.deliver();
    this.logOutcome(input.outcome, delivery);
    this.notifyDelivered();
    return { kind: 'forced_closed', audit_event_id: input.req.event_id, delivery };
  }

  private notifyDelivered(): void {
    try {
      this.deps.onCloseDelivered?.();
    } catch {
      // The close is already committed; the hook logs its own failures.
    }
  }

  /** `sent` only when the drain says Backend-Core has it; a failing drain is `queued`. */
  private async deliver(): Promise<'sent' | 'queued'> {
    try {
      return (await this.deps.deliverNow?.()) === true ? 'sent' : 'queued';
    } catch {
      return 'queued';
    }
  }

  private async categoryOf(input: { err: unknown; shiftId: string }): Promise<RefusalCategory> {
    const { err } = input;
    if (err instanceof ShiftCashupStateError) return this.notOpenCategory(input.shiftId);
    if (err instanceof ShiftCashupRefusedError) return CATEGORY_OF_REASON[err.reason];
    // A fact the POS refuses to record, or a failing audit (nothing was written).
    return 'invalid_input';
  }

  /**
   * Not this terminal's open shift: never held here, or already closed here.
   * Closed here and not at the server yet, the stuck list still shows it, so a
   * "state changed" would be false: say it is not at the server yet.
   */
  private async notOpenCategory(shiftId: string): Promise<RefusalCategory> {
    if (!this.closedHere(shiftId)) return 'not_closable_here';
    // The first answer may have been lost, or the drain not run yet: try once more.
    await this.deliver();
    return this.closeReachedServer(shiftId) ? 'state_invalid' : 'closed_here_unsent';
  }

  private async originatingTerminalId(): Promise<string> {
    const status = await this.deps.pairingStore.getStatus();
    return status.kind === 'paired' ? status.terminal_id : '';
  }

  private alreadyRecorded(input: { eventId: string; tenantId: string; shiftId: string }): boolean {
    const row = (
      this.deps.db.prepare(
        `SELECT 1 FROM audit_events
         WHERE event_id = ? AND tenant_id = ? AND shift_id = ?
           AND action_category = 'shift.forced_close'`,
      ) as PrepareGet<{ '1': number }>
    ).get(input.eventId, input.tenantId, input.shiftId);
    return row !== undefined;
  }

  /** True when this terminal already holds a close (normal or forced) for the shift. */
  private closedHere(shiftId: string): boolean {
    const row = (
      this.deps.db.prepare(`SELECT 1 FROM shift_cashup_closes WHERE shift_id = ?`) as PrepareGet<{
        '1': number;
      }>
    ).get(shiftId);
    return row !== undefined;
  }

  /** True when Backend-Core has the shift's close (its outbox row, or a repair of it, is synced). */
  private closeReachedServer(shiftId: string): boolean {
    const row = (
      this.deps.db.prepare(
        `SELECT 1 FROM shift_sync_outbox o JOIN shift_sync_state s ON s.seq = o.seq
          WHERE o.fact_kind = 'close' AND o.shift_id = ? AND s.sync_status = 'synced'`,
      ) as PrepareGet<{ '1': number }>
    ).get(shiftId);
    return row !== undefined;
  }

  private auditEvent(input: {
    req: ForceCloseShiftRequest;
    actor: OperatorSessionRecord;
    originatingTerminalId: string;
    closed: ForcedClosedShift;
  }): AuditEvent {
    const { req, actor, closed } = input;
    return {
      event_id: req.event_id,
      tenant_id: actor.tenant_id,
      branch_id: actor.branch_id,
      originating_terminal_id: input.originatingTerminalId,
      acting_operator_id: actor.operator_id,
      session_id: actor.id,
      shift_id: closed.shiftId,
      action_category: 'shift.forced_close',
      created_at: new Date().toISOString(),
      approving_supervisor_id: null,
      // No count, no variance: the audit never carries an amount (FR-024).
      payload: {
        shift_id: closed.shiftId,
        shift_owner_id: closed.openingUserId,
        forced_close_actor_id: actor.operator_id,
        forced_close_reason: req.reason,
        ...(req.annotation !== undefined ? { annotation: req.annotation } : {}),
      },
    };
  }

  private refuse(category: RefusalCategory): OperatorRefusal {
    this.deps.logger?.info(
      { event: 'operator.forced_close.refused', category },
      'forced-close refused',
    );
    return { kind: 'refused', category };
  }

  private logOutcome(kind: string, delivery: 'sent' | 'queued'): void {
    this.deps.logger?.info(
      { event: 'operator.forced_close.outcome', kind, delivery },
      'forced-close outcome',
    );
  }
}
