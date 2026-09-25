/**
 * T111 — `payment_attempts` repository.
 *
 * Owns SQL access for the `payment_attempts` table (006-payments-tender
 * Slice 3a). Wraps the production `DatabaseHandle` interface so tests can
 * inject a sql.js adapter. The surface is intentionally narrow per
 * tasks.md T111: insert, updateState, findById, findStartedByTerminal —
 * just what S3b's FSM + S3c's bridge handlers need.
 *
 * No business logic lives here. FSM transition rules, idempotency, and
 * audit emission are owned by S3b modules; this file only reads and writes
 * rows. The migration layer (0012 + 0013) is the authoritative schema; the
 * partial unique index on (terminal_id) WHERE state='started' makes
 * double-settlement prevention a SQL-level guarantee (research §R-6).
 */

import type { DatabaseHandle } from '../../db/client.js';

// ── Narrow better-sqlite3 surfaces (R1: no native binding required at test time) ──

interface PrepareRun {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

// ── Closed enums (mirror 006 data-model.md §"Entity: PaymentAttempt") ──

export type PaymentAttemptState = 'started' | 'settled' | 'cancelled' | 'failed' | 'force_failed';

export type PaymentFailureReason =
  | 'cart_lost'
  | 'operator_session_terminated'
  | 'dependency_unavailable'
  | 'internal_error'
  | 'stale_handoff'
  | 'tender_underpaid'
  | 'non_cash_overpayment_refused'
  | 'voucher_not_found'
  | 'voucher_expired'
  | 'voucher_cancelled'
  | 'voucher_already_redeemed'
  | 'voucher_tenant_mismatch'
  | 'voucher_branch_mismatch'
  | 'split_tender_rollback'
  /**
   * Wave 5b — manager-initiated terminal transition (FR-021 / plan AD-5).
   * Used exclusively by `payments.forceFail` when a manager or admin
   * breaks a stuck `started` attempt during incident response. The
   * audit row carries dual attribution (manager actor + original
   * cashier); the manager identity MUST NEVER cross the bridge to a
   * cashier-visible surface (FR-021 last clause).
   */
  | 'manager_force_failed';

export interface PaymentAttemptRow {
  payment_attempt_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  acting_operator_id: string;
  operator_session_id: string;
  envelope_handoff_action_id: string;
  envelope_cart_id: string;
  envelope_subtotal_minor: number;
  state: PaymentAttemptState;
  started_at: string;
  settled_at: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
  force_failed_at: string | null;
  failure_reason: PaymentFailureReason | null;
  force_fail_attribution_operator_id: string | null;
  last_action_id: string;
}

export interface InsertPaymentAttemptInput {
  payment_attempt_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  acting_operator_id: string;
  operator_session_id: string;
  envelope_handoff_action_id: string;
  envelope_cart_id: string;
  envelope_subtotal_minor: number;
  started_at: string;
  last_action_id: string;
}

/**
 * Discriminated union per state — the type system enforces which auxiliary
 * fields are required (and forbidden) for each transition target, so the
 * repository never needs runtime validation between two trusted main-process
 * callers (CLAUDE.md "trust internal code, validate at boundaries").
 */
export type UpdatePaymentAttemptStateInput =
  | {
      payment_attempt_id: string;
      state: 'settled' | 'cancelled';
      timestamp: string;
      last_action_id: string;
    }
  | {
      payment_attempt_id: string;
      state: 'failed';
      timestamp: string;
      last_action_id: string;
      failure_reason: PaymentFailureReason;
    }
  | {
      payment_attempt_id: string;
      state: 'force_failed';
      timestamp: string;
      last_action_id: string;
      failure_reason: PaymentFailureReason;
      force_fail_attribution_operator_id: string;
    };

export interface PaymentAttemptsRepository {
  insert(input: InsertPaymentAttemptInput): void;
  /**
   * Transitions a payment attempt to a terminal state.
   *
   * **Caller contract:** the FSM (S3b) is responsible for verifying that the
   * target attempt exists and that the transition is legal before calling
   * this method. This method does NOT throw on `payment_attempt_id`
   * not-found — the UPDATE silently affects zero rows. The S3b FSM calls
   * `findById` first as part of its transition matrix, which is also where
   * legal-vs-illegal transition enforcement happens. Trust-internal-code
   * boundary per CLAUDE.md.
   */
  updateState(input: UpdatePaymentAttemptStateInput): void;
  findById(payment_attempt_id: string): PaymentAttemptRow | undefined;
  findStartedByTerminal(terminal_id: string): PaymentAttemptRow | undefined;
}

export function bindPaymentAttemptsRepository(db: DatabaseHandle): PaymentAttemptsRepository {
  const insertStmt = db.prepare(
    `INSERT INTO payment_attempts (
       payment_attempt_id, tenant_id, branch_id, terminal_id,
       acting_operator_id, operator_session_id,
       envelope_handoff_action_id, envelope_cart_id, envelope_subtotal_minor,
       state, started_at, last_action_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)`,
  ) as PrepareRun;

  const updateToSettled = db.prepare(
    `UPDATE payment_attempts
        SET state='settled', settled_at=?, last_action_id=?
      WHERE payment_attempt_id=?`,
  ) as PrepareRun;

  const updateToCancelled = db.prepare(
    `UPDATE payment_attempts
        SET state='cancelled', cancelled_at=?, last_action_id=?
      WHERE payment_attempt_id=?`,
  ) as PrepareRun;

  const updateToFailed = db.prepare(
    `UPDATE payment_attempts
        SET state='failed', failed_at=?, failure_reason=?, last_action_id=?
      WHERE payment_attempt_id=?`,
  ) as PrepareRun;

  const updateToForceFailed = db.prepare(
    `UPDATE payment_attempts
        SET state='force_failed',
            force_failed_at=?,
            failure_reason=?,
            force_fail_attribution_operator_id=?,
            last_action_id=?
      WHERE payment_attempt_id=?`,
  ) as PrepareRun;

  const findByIdStmt = db.prepare(
    `SELECT * FROM payment_attempts WHERE payment_attempt_id=?`,
  ) as PrepareGet<PaymentAttemptRow>;

  const findStartedByTerminalStmt = db.prepare(
    `SELECT * FROM payment_attempts WHERE terminal_id=? AND state='started' LIMIT 1`,
  ) as PrepareGet<PaymentAttemptRow>;

  return {
    insert(input: InsertPaymentAttemptInput): void {
      insertStmt.run(
        input.payment_attempt_id,
        input.tenant_id,
        input.branch_id,
        input.terminal_id,
        input.acting_operator_id,
        input.operator_session_id,
        input.envelope_handoff_action_id,
        input.envelope_cart_id,
        input.envelope_subtotal_minor,
        input.started_at,
        input.last_action_id,
      );
    },

    updateState(input: UpdatePaymentAttemptStateInput): void {
      switch (input.state) {
        case 'settled':
          updateToSettled.run(input.timestamp, input.last_action_id, input.payment_attempt_id);
          return;
        case 'cancelled':
          updateToCancelled.run(input.timestamp, input.last_action_id, input.payment_attempt_id);
          return;
        case 'failed':
          updateToFailed.run(
            input.timestamp,
            input.failure_reason,
            input.last_action_id,
            input.payment_attempt_id,
          );
          return;
        case 'force_failed':
          updateToForceFailed.run(
            input.timestamp,
            input.failure_reason,
            input.force_fail_attribution_operator_id,
            input.last_action_id,
            input.payment_attempt_id,
          );
          return;
      }
    },

    findById(payment_attempt_id: string): PaymentAttemptRow | undefined {
      return findByIdStmt.get(payment_attempt_id) ?? undefined;
    },

    findStartedByTerminal(terminal_id: string): PaymentAttemptRow | undefined {
      return findStartedByTerminalStmt.get(terminal_id) ?? undefined;
    },
  };
}

/**
 * Read-only per-cart lookup for the post-handoff cancel guard (spec 005
 * FR-008/FR-033): true while any attempt for the cart is `started` (payment in
 * progress) or `settled` (the sale is paid). A cart stays `frozen_handed_off`
 * after settlement, so the cart row alone cannot tell a paid sale from an
 * unpaid handoff. Cancelled / failed / force-failed attempts do not block.
 */
export function bindCartPaymentGuard(db: DatabaseHandle): (envelope_cart_id: string) => boolean {
  const stmt = db.prepare(
    `SELECT 1 AS blocking FROM payment_attempts
      WHERE envelope_cart_id=? AND state IN ('started', 'settled') LIMIT 1`,
  ) as PrepareGet<{ blocking: number }>;
  return (envelope_cart_id) => stmt.get(envelope_cart_id) !== undefined;
}
