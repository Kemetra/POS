/**
 * RT-17 slice 3 — the local shift cash-up store and its sync outbox
 * (migration 0043, [GATED] Jira RT-17 comment 10920).
 *
 * Recording a fact is ONE transaction: the immutable fact row, its outbox row
 * (the exact request body and Idempotency-Key, built once by `shift-wire.ts`)
 * and — through the 0043 trigger — its pending state row. A refused fact
 * writes nothing. The rules the repository applies before writing (the 0043
 * triggers back them up):
 *   • at most one open shift per terminal (`shift_already_open`);
 *   • a movement or a close only on the terminal's open shift
 *     (`shift_not_open`), rendered in that shift's currency;
 *   • a close's float and pay-in / pay-out totals equal the open's float and
 *     the shift's recorded movements (the trigger refuses otherwise).
 *
 * The drain reads ONE fact at a time (`nextFact`): the head of the terminal's
 * unsynced facts in causal order (`seq`: open → movements → close, and one
 * shift's close before the next shift's open). Backend-Core allows one open
 * shift per device and resolves a movement or a close only on a shift it has
 * recorded, so a fact sent before its predecessors would be refused (404
 * `shift_not_found`, 409 `shift_already_open`) or, worse, recorded out of order.
 * Hence:
 *   • `waiting` — the head is in backoff; nothing behind it is offered;
 *   • `blocked` — the head is dead-lettered; nothing behind it is offered until
 *     the head is repaired (RT-17 10919 decision 4: repaired on the
 *     manager-envelope path, RT-113 P3/P4). Facts stay queued, never lost.
 * Only the CURRENT pairing's terminal is drained (RT-221); a null terminal
 * drains nothing.
 *
 * The sync transitions apply only to a `pending` row and report whether they
 * did. Every send is an attempt, success included.
 *
 * No secret, no PII: ids, amounts, timestamps, the optional "no PII" movement
 * note and closed-set codes only.
 */
import type { DatabaseHandle } from '../db/client.js';
import {
  buildCashMovementRequest,
  buildCloseShiftRequest,
  buildOpenShiftRequest,
  type CashMovementFact,
  type ShiftCloseFact,
  type ShiftFactKind,
  type ShiftOpenFact,
  type ShiftWireRequest,
} from './shift-wire.js';

/** The terminal a fact is recorded on (the current pairing). */
export interface ShiftScope {
  tenantId: string;
  branchId: string;
  terminalId: string;
}

/** The drain's scope; a null terminal (unpaired / invalid pairing) drains nothing. */
export interface ShiftDrainScope {
  tenantId: string;
  branchId: string;
  terminalId: string | null;
}

export interface RecordShiftFactInput<F> {
  scope: ShiftScope;
  fact: F;
  /** ISO-8601 UTC: when the fact was queued. */
  now: string;
}

export interface RecordedShiftFact {
  seq: number;
  idempotencyKey: string;
}

export type ShiftCashupStateReason = 'shift_already_open' | 'shift_not_open';

/** A fact the terminal's shift state does not allow. */
export class ShiftCashupStateError extends Error {
  readonly reason: ShiftCashupStateReason;

  constructor(reason: ShiftCashupStateReason) {
    super(`shift cash-up refused: ${reason}`);
    this.name = 'ShiftCashupStateError';
    this.reason = reason;
  }
}

/** The terminal's open shift, with the totals a close needs. */
export interface OpenShiftView {
  shiftId: string;
  openedAt: string;
  openingUserId: string;
  currencyCode: string;
  openingFloatMinor: number;
  payInTotalMinor: number;
  payOutTotalMinor: number;
}

export type ShiftAuthPath = 'device' | 'envelope';

/** A queued fact, exactly as it is to be sent. */
export interface QueuedShiftFact {
  seq: number;
  factKind: ShiftFactKind;
  shiftId: string;
  authPath: ShiftAuthPath;
  idempotencyKey: string;
  /** The stored JSON body, sent byte for byte. */
  requestBody: string;
  attemptCount: number;
}

export type NextShiftFact =
  | { kind: 'idle' }
  | { kind: 'due'; fact: QueuedShiftFact }
  | { kind: 'waiting'; seq: number; nextRetryAt: string }
  | { kind: 'blocked'; seq: number; reason: string };

/** Why a pending fact is retried (stored in `last_error_category`). */
export type ShiftSyncRetryCategory = 'transient' | 'no_connection' | 'device_unauthorized';

/**
 * Why a fact is dead-lettered: the contract's terminal error codes
 * (`pos-shifts.openapi.yaml` 1.1.0-draft), `cashier_claim_refused` for a
 * device-path 403, and `rejected` for any other refusal.
 */
export type ShiftSyncDeadLetterReason =
  | 'cashier_claim_refused'
  | 'shift_payload_conflict'
  | 'idempotency_key_conflict'
  | 'shift_already_open'
  | 'shift_closed'
  | 'shift_not_found'
  | 'shift_cashup_inconsistent'
  | 'refund_ref_invalid'
  | 'currency_mismatch'
  | 'validation_error'
  | 'rejected';

export interface ShiftSyncTransition {
  seq: number;
  now: string;
}

export interface ShiftSyncRetry extends ShiftSyncTransition {
  nextRetryAt: string;
  category: ShiftSyncRetryCategory;
}

export interface ShiftSyncDeadLetter extends ShiftSyncTransition {
  reason: ShiftSyncDeadLetterReason;
}

export interface ShiftCashupRepo {
  recordOpen(input: RecordShiftFactInput<ShiftOpenFact>): RecordedShiftFact;
  recordMovement(input: RecordShiftFactInput<CashMovementFact>): RecordedShiftFact;
  recordClose(input: RecordShiftFactInput<ShiftCloseFact>): RecordedShiftFact;
  findOpenShift(scope: ShiftScope): OpenShiftView | null;
  nextFact(input: { scope: ShiftDrainScope; now: string }): NextShiftFact;
  markSynced(input: ShiftSyncTransition): boolean;
  recordRetry(input: ShiftSyncRetry): boolean;
  markDeadLetter(input: ShiftSyncDeadLetter): boolean;
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}
interface PrepareRun {
  run(...params: unknown[]): { changes: number };
}

interface HeadRow {
  seq: number;
  fact_kind: ShiftFactKind;
  shift_id: string;
  auth_path: ShiftAuthPath;
  idempotency_key: string;
  request_body: string;
  sync_status: 'pending' | 'dead_letter';
  attempt_count: number;
  next_retry_at: string | null;
  dead_letter_reason: string | null;
}

interface EnqueueInput {
  scope: ShiftScope;
  ref: { factKind: ShiftFactKind; shiftId: string; movementId: string | null };
  request: ShiftWireRequest;
  now: string;
}

const IDLE: NextShiftFact = Object.freeze({ kind: 'idle' });

const OPEN_SHIFT_SQL = `
  SELECT o.shift_id AS shiftId, o.opened_at AS openedAt, o.opening_user_id AS openingUserId,
         o.currency_code AS currencyCode, o.opening_float_minor AS openingFloatMinor,
         (SELECT COALESCE(SUM(m.amount_minor), 0) FROM shift_cashup_movements m
           WHERE m.shift_id = o.shift_id AND m.kind = 'pay_in') AS payInTotalMinor,
         (SELECT COALESCE(SUM(m.amount_minor), 0) FROM shift_cashup_movements m
           WHERE m.shift_id = o.shift_id AND m.kind = 'pay_out') AS payOutTotalMinor
  FROM shift_cashup_opens o
  WHERE o.tenant_id = ? AND o.branch_id = ? AND o.terminal_id = ?
    AND NOT EXISTS (SELECT 1 FROM shift_cashup_closes c WHERE c.shift_id = o.shift_id)`;

const HEAD_SQL = `
  SELECT o.seq, o.fact_kind, o.shift_id, o.auth_path, o.idempotency_key, o.request_body,
         s.sync_status, s.attempt_count, s.next_retry_at, s.dead_letter_reason
  FROM shift_sync_outbox o JOIN shift_sync_state s ON s.seq = o.seq
  WHERE o.tenant_id = ? AND o.branch_id = ? AND o.terminal_id = ?
    AND s.sync_status <> 'synced'
  ORDER BY o.seq ASC
  LIMIT 1`;

function queued(head: HeadRow): QueuedShiftFact {
  return {
    seq: head.seq,
    factKind: head.fact_kind,
    shiftId: head.shift_id,
    authPath: head.auth_path,
    idempotencyKey: head.idempotency_key,
    requestBody: head.request_body,
    attemptCount: head.attempt_count,
  };
}

/** The drain's view of the head fact at `now`. */
function classifyHead(head: HeadRow, now: string): NextShiftFact {
  if (head.sync_status === 'dead_letter') {
    return { kind: 'blocked', seq: head.seq, reason: head.dead_letter_reason ?? 'rejected' };
  }
  if (head.next_retry_at !== null && head.next_retry_at > now) {
    return { kind: 'waiting', seq: head.seq, nextRetryAt: head.next_retry_at };
  }
  return { kind: 'due', fact: queued(head) };
}

export function createShiftCashupRepo(db: DatabaseHandle): ShiftCashupRepo {
  const run = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql) as PrepareRun).run(...params).changes;

  function findOpenShift(scope: ShiftScope): OpenShiftView | null {
    const stmt = db.prepare(OPEN_SHIFT_SQL) as PrepareGet<OpenShiftView>;
    return stmt.get(scope.tenantId, scope.branchId, scope.terminalId) ?? null;
  }

  /** The terminal's open shift if it is `shiftId`, else `shift_not_open`. */
  function requireOpenShift(input: { scope: ShiftScope; shiftId: string }): OpenShiftView {
    const open = findOpenShift(input.scope);
    if (open?.shiftId !== input.shiftId.toLowerCase()) {
      throw new ShiftCashupStateError('shift_not_open');
    }
    return open;
  }

  function enqueue(input: EnqueueInput): RecordedShiftFact {
    const { scope, ref, request } = input;
    run(
      `INSERT INTO shift_sync_outbox (fact_kind, shift_id, movement_id, tenant_id, branch_id,
         terminal_id, auth_path, idempotency_key, request_body, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, 'device', ?, ?, ?)`,
      ref.factKind,
      ref.shiftId,
      ref.movementId,
      scope.tenantId,
      scope.branchId,
      scope.terminalId,
      request.idempotencyKey,
      request.body,
      input.now,
    );
    const row = (
      db.prepare('SELECT seq FROM shift_sync_outbox WHERE idempotency_key = ?') as PrepareGet<{
        seq: number;
      }>
    ).get(request.idempotencyKey);
    if (row === undefined) throw new Error('shift_sync_outbox: enqueued row not found');
    return { seq: row.seq, idempotencyKey: request.idempotencyKey };
  }

  function recordOpen(input: RecordShiftFactInput<ShiftOpenFact>): RecordedShiftFact {
    const { fact, request } = buildOpenShiftRequest(input.fact);
    const { scope, now } = input;
    return db.transaction(() => {
      if (findOpenShift(scope) !== null) throw new ShiftCashupStateError('shift_already_open');
      run(
        `INSERT INTO shift_cashup_opens (shift_id, tenant_id, branch_id, terminal_id,
           opening_user_id, currency_code, opening_float_minor, opened_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fact.shiftId,
        scope.tenantId,
        scope.branchId,
        scope.terminalId,
        fact.openingUserId,
        fact.currencyCode,
        fact.openingFloatMinor,
        fact.openedAt,
        now,
      );
      return enqueue({
        scope,
        ref: { factKind: 'open', shiftId: fact.shiftId, movementId: null },
        request,
        now,
      });
    })();
  }

  function recordMovement(input: RecordShiftFactInput<CashMovementFact>): RecordedShiftFact {
    const { scope, now } = input;
    return db.transaction(() => {
      const open = requireOpenShift({ scope, shiftId: input.fact.shiftId });
      const { fact, request } = buildCashMovementRequest({
        fact: input.fact,
        currencyCode: open.currencyCode,
      });
      run(
        `INSERT INTO shift_cashup_movements (movement_id, shift_id, kind, amount_minor,
           reason_code, note, occurred_at, operator_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fact.movementId,
        fact.shiftId,
        fact.kind,
        fact.amountMinor,
        fact.reasonCode,
        fact.note ?? null,
        fact.occurredAt,
        fact.operatorUserId,
        now,
      );
      return enqueue({
        scope,
        ref: { factKind: 'movement', shiftId: fact.shiftId, movementId: fact.movementId },
        request,
        now,
      });
    })();
  }

  function insertClose(input: { fact: ShiftCloseFact; now: string }): void {
    const { fact } = input;
    run(
      `INSERT INTO shift_cashup_closes (shift_id, closed_at, closing_user_id, close_kind,
         forced_reason, opening_float_minor, cash_sales_total_minor, cash_refunds_total_minor,
         pay_in_total_minor, pay_out_total_minor, expected_cash_minor, counted_cash_minor,
         variance_minor, sale_count, cash_refund_return_refs_json, variance_approved_by_user_id,
         created_at)
       VALUES (?, ?, ?, 'normal', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fact.shiftId,
      fact.closedAt,
      fact.closingUserId,
      fact.openingFloatMinor,
      fact.cashSalesTotalMinor,
      fact.cashRefundsTotalMinor,
      fact.payInTotalMinor,
      fact.payOutTotalMinor,
      fact.expectedCashMinor,
      fact.countedCashMinor,
      fact.varianceMinor,
      fact.saleCount,
      JSON.stringify(fact.cashRefundReturnRefs),
      fact.varianceApprovedByUserId ?? null,
      input.now,
    );
  }

  function recordClose(input: RecordShiftFactInput<ShiftCloseFact>): RecordedShiftFact {
    const { scope, now } = input;
    return db.transaction(() => {
      const open = requireOpenShift({ scope, shiftId: input.fact.shiftId });
      const { fact, request } = buildCloseShiftRequest({
        fact: input.fact,
        currencyCode: open.currencyCode,
      });
      insertClose({ fact, now });
      return enqueue({
        scope,
        ref: { factKind: 'close', shiftId: fact.shiftId, movementId: null },
        request,
        now,
      });
    })();
  }

  function nextFact(input: { scope: ShiftDrainScope; now: string }): NextShiftFact {
    const { scope } = input;
    if (scope.terminalId === null) return IDLE;
    const head = (db.prepare(HEAD_SQL) as PrepareGet<HeadRow>).get(
      scope.tenantId,
      scope.branchId,
      scope.terminalId,
    );
    return head === undefined ? IDLE : classifyHead(head, input.now);
  }

  function markSynced(input: ShiftSyncTransition): boolean {
    const changes = run(
      `UPDATE shift_sync_state
       SET sync_status = 'synced', attempt_count = attempt_count + 1, synced_at = ?,
           next_retry_at = NULL, last_error_category = NULL, last_attempt_at = ?, updated_at = ?
       WHERE seq = ? AND sync_status = 'pending'`,
      input.now,
      input.now,
      input.now,
      input.seq,
    );
    return changes > 0;
  }

  function recordRetry(input: ShiftSyncRetry): boolean {
    const changes = run(
      `UPDATE shift_sync_state
       SET attempt_count = attempt_count + 1, next_retry_at = ?, last_error_category = ?,
           last_attempt_at = ?, updated_at = ?
       WHERE seq = ? AND sync_status = 'pending'`,
      input.nextRetryAt,
      input.category,
      input.now,
      input.now,
      input.seq,
    );
    return changes > 0;
  }

  function markDeadLetter(input: ShiftSyncDeadLetter): boolean {
    const changes = run(
      `UPDATE shift_sync_state
       SET sync_status = 'dead_letter', dead_letter_reason = ?, attempt_count = attempt_count + 1,
           next_retry_at = NULL, last_attempt_at = ?, updated_at = ?
       WHERE seq = ? AND sync_status = 'pending'`,
      input.reason,
      input.now,
      input.now,
      input.seq,
    );
    return changes > 0;
  }

  return {
    recordOpen,
    recordMovement,
    recordClose,
    findOpenShift,
    nextFact,
    markSynced,
    recordRetry,
    markDeadLetter,
  };
}
