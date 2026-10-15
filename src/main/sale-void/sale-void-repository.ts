/**
 * RT-530 — the sale-void journal repository (migration 0054).
 *
 * The journal is written BEFORE a void is sent, in the transaction that
 * consumes its manager approval. Every state change is a guarded UPDATE that
 * only moves a row out of `pending` / `unknown`, so a second confirmation (a
 * replayed answer) changes nothing and reports `false`: the caller then writes
 * no second audit event. The schema triggers are the backstop.
 *
 * `DatabaseHandle` is injected so tests run on sql.js.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { SaleVoidState, ServerVoidRefusal } from '../../shared/sale-void/types.js';

export interface VoidScope {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
}

/** The facts of a void at the moment it was requested (all immutable). */
export interface NewVoidEntry {
  readonly voidId: string;
  readonly scope: VoidScope;
  readonly saleId: string;
  readonly saleNumber: string;
  /** `pos-pulse-void:<uuid>`: the void's provenance and its Idempotency-Key. */
  readonly externalId: string;
  readonly approvalId: string;
  readonly approverUserId: string;
  /** The requester's `users.id`: the only operator whose envelope may send it. */
  readonly requesterUserId: string;
  readonly requesterOperatorId: string;
  readonly requesterDisplayName: string;
  readonly operatorSessionId: string;
  readonly policyVersion: string;
  readonly approvedAt: string;
  /** The business day the void claims (`YYYY-MM-DD`). */
  readonly businessDate: string;
  /** The sale total the approval was bound to, in minor units. */
  readonly amountMinor: number;
  /** The net cash of the voided sale: what leaves the drawer. */
  readonly cashMinor: number;
  readonly currencyCode: string;
  readonly now: string;
}

export interface VoidEntry extends Omit<NewVoidEntry, 'now'> {
  readonly state: SaleVoidState;
  readonly refusalReason: ServerVoidRefusal | null;
  /** The server's void event reference once confirmed. */
  readonly voidRef: string | null;
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly lastErrorCategory: string | null;
  readonly confirmedAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly requestedAt: string;
}

/** One row at one instant: the argument of the simple transitions. */
export interface VoidStamp {
  readonly voidId: string;
  readonly now: string;
}

export interface UnknownInput extends VoidStamp {
  /** A closed-set category of why the answer is unknown (e.g. `unauthorized`). */
  readonly category: string;
}

export interface ConfirmVoidInput extends VoidStamp {
  readonly voidRef: string;
}

export interface RefuseVoidInput extends VoidStamp {
  readonly reason: ServerVoidRefusal;
}

export interface SaleVoidRepository {
  /** Insert the row; `within` (the audit event) runs inside the same transaction. */
  insert(entry: NewVoidEntry, within?: (inserted: VoidEntry) => void): void;
  /**
   * Insert the row `build` returns. `build` runs INSIDE the transaction, before
   * the insert, so it can spend the manager approval and read its evidence: a
   * throw from `build`, the insert or `within` rolls everything back.
   */
  insertFrom(build: () => NewVoidEntry, within?: (inserted: VoidEntry) => void): void;
  read(voidId: string): VoidEntry | null;
  readByApproval(approvalId: string): VoidEntry | null;
  /** The sale's live void (pending, unknown or confirmed), if any. */
  liveForSale(saleId: string): VoidEntry | null;
  /** This terminal's voids, newest first. */
  listRecent(scope: VoidScope, limit: number): VoidEntry[];
  /** This terminal's `pending` / `unknown` voids, oldest first (send order). */
  listUnresolved(scope: VoidScope): VoidEntry[];
  /** This terminal's refused voids staff have not acknowledged. */
  listUnacknowledgedRefused(scope: VoidScope): VoidEntry[];
  recordAttempt(stamp: VoidStamp): void;
  /** pending/unknown -> unknown. False when the row was already final. */
  markUnknown(input: UnknownInput): boolean;
  /** pending/unknown -> confirmed. False when already confirmed or final. */
  markConfirmed(input: ConfirmVoidInput): boolean;
  /** pending/unknown -> refused. False when already final. */
  markRefused(input: RefuseVoidInput): boolean;
  /** Staff saw a final refusal; false when it is not refused or already seen. */
  acknowledge(stamp: VoidStamp): boolean;
}

interface Stmt {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface Row {
  void_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  sale_id: string;
  sale_number: string;
  external_id: string;
  approval_id: string;
  approver_user_id: string;
  requester_user_id: string;
  requester_operator_id: string;
  requester_display_name: string;
  operator_session_id: string;
  approval_policy_version: string;
  approved_at: string;
  business_date: string;
  amount_minor: number;
  cash_minor: number;
  currency_code: string;
  state: SaleVoidState;
  refusal_reason: ServerVoidRefusal | null;
  void_ref: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error_category: string | null;
  confirmed_at: string | null;
  acknowledged_at: string | null;
  requested_at: string;
}

const UNRESOLVED = `state IN ('pending', 'unknown')`;
const SCOPE_WHERE = 'tenant_id = ? AND branch_id = ? AND terminal_id = ?';

function scopeParams(scope: VoidScope): string[] {
  return [scope.tenantId, scope.branchId, scope.terminalId];
}

function toEntry(row: Row): VoidEntry {
  return {
    voidId: row.void_id,
    scope: { tenantId: row.tenant_id, branchId: row.branch_id, terminalId: row.terminal_id },
    saleId: row.sale_id,
    saleNumber: row.sale_number,
    externalId: row.external_id,
    approvalId: row.approval_id,
    approverUserId: row.approver_user_id,
    requesterUserId: row.requester_user_id,
    requesterOperatorId: row.requester_operator_id,
    requesterDisplayName: row.requester_display_name,
    operatorSessionId: row.operator_session_id,
    policyVersion: row.approval_policy_version,
    approvedAt: row.approved_at,
    businessDate: row.business_date,
    amountMinor: row.amount_minor,
    cashMinor: row.cash_minor,
    currencyCode: row.currency_code,
    state: row.state,
    refusalReason: row.refusal_reason,
    voidRef: row.void_ref,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    lastErrorCategory: row.last_error_category,
    confirmedAt: row.confirmed_at,
    acknowledgedAt: row.acknowledged_at,
    requestedAt: row.requested_at,
  };
}

const INSERT_SQL = `
  INSERT INTO sale_void_journal
    (void_id, tenant_id, branch_id, terminal_id, sale_id, sale_number, external_id, approval_id,
     approver_user_id, requester_user_id, requester_operator_id, requester_display_name,
     operator_session_id, approval_policy_version, approved_at, business_date, amount_minor,
     cash_minor, currency_code, state, requested_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`;

function insertParams(e: NewVoidEntry): unknown[] {
  return [
    e.voidId,
    ...scopeParams(e.scope),
    e.saleId,
    e.saleNumber,
    e.externalId,
    e.approvalId,
    e.approverUserId,
    e.requesterUserId,
    e.requesterOperatorId,
    e.requesterDisplayName,
    e.operatorSessionId,
    e.policyVersion,
    e.approvedAt,
    e.businessDate,
    e.amountMinor,
    e.cashMinor,
    e.currencyCode,
    e.now,
    e.now,
  ];
}

type InsertHook = (inserted: VoidEntry) => void;

class SqlSaleVoidRepository implements SaleVoidRepository {
  private readonly insertTx: (build: () => NewVoidEntry, within: InsertHook) => void;

  constructor(private readonly db: DatabaseHandle) {
    this.insertTx = db.transaction((build: () => NewVoidEntry, within: InsertHook): void => {
      const entry = build();
      this.prepare(INSERT_SQL).run(...insertParams(entry));
      const inserted = this.read(entry.voidId);
      if (inserted !== null) within(inserted);
    });
  }

  private prepare(sql: string): Stmt {
    return this.db.prepare(sql) as Stmt;
  }

  private one(sql: string, ...params: unknown[]): VoidEntry | null {
    const row = this.prepare(sql).get(...params);
    return row === undefined ? null : toEntry(row as Row);
  }

  private many(sql: string, ...params: unknown[]): VoidEntry[] {
    return (this.prepare(sql).all(...params) as Row[]).map(toEntry);
  }

  /** Run a guarded UPDATE; true when it changed a row. */
  private update(sql: string, ...params: unknown[]): boolean {
    return this.prepare(sql).run(...params).changes > 0;
  }

  insert(entry: NewVoidEntry, within: InsertHook = () => undefined): void {
    this.insertTx(() => entry, within);
  }

  insertFrom(build: () => NewVoidEntry, within: InsertHook = () => undefined): void {
    this.insertTx(build, within);
  }

  read(voidId: string): VoidEntry | null {
    return this.one('SELECT * FROM sale_void_journal WHERE void_id = ?', voidId);
  }

  readByApproval(approvalId: string): VoidEntry | null {
    return this.one('SELECT * FROM sale_void_journal WHERE approval_id = ?', approvalId);
  }

  liveForSale(saleId: string): VoidEntry | null {
    return this.one(
      `SELECT * FROM sale_void_journal WHERE sale_id = ?
        AND state IN ('pending', 'unknown', 'confirmed') LIMIT 1`,
      saleId,
    );
  }

  listRecent(scope: VoidScope, limit: number): VoidEntry[] {
    return this.many(
      `SELECT * FROM sale_void_journal WHERE ${SCOPE_WHERE}
        ORDER BY requested_at DESC, void_id DESC LIMIT ?`,
      ...scopeParams(scope),
      limit,
    );
  }

  listUnresolved(scope: VoidScope): VoidEntry[] {
    return this.many(
      `SELECT * FROM sale_void_journal WHERE ${SCOPE_WHERE} AND ${UNRESOLVED}
        ORDER BY requested_at ASC, void_id ASC`,
      ...scopeParams(scope),
    );
  }

  listUnacknowledgedRefused(scope: VoidScope): VoidEntry[] {
    return this.many(
      `SELECT * FROM sale_void_journal WHERE ${SCOPE_WHERE}
        AND state = 'refused' AND acknowledged_at IS NULL
        ORDER BY requested_at ASC, void_id ASC`,
      ...scopeParams(scope),
    );
  }

  recordAttempt({ voidId, now }: VoidStamp): void {
    this.update(
      `UPDATE sale_void_journal SET attempt_count = attempt_count + 1, last_attempt_at = ?,
         updated_at = ? WHERE void_id = ? AND ${UNRESOLVED}`,
      now,
      now,
      voidId,
    );
  }

  markUnknown({ voidId, now, category }: UnknownInput): boolean {
    return this.update(
      `UPDATE sale_void_journal SET state = 'unknown', last_error_category = ?, updated_at = ?
        WHERE void_id = ? AND ${UNRESOLVED}`,
      category,
      now,
      voidId,
    );
  }

  markConfirmed({ voidId, voidRef, now }: ConfirmVoidInput): boolean {
    return this.update(
      `UPDATE sale_void_journal SET state = 'confirmed', void_ref = ?, confirmed_at = ?,
         last_error_category = NULL, updated_at = ? WHERE void_id = ? AND ${UNRESOLVED}`,
      voidRef,
      now,
      now,
      voidId,
    );
  }

  markRefused({ voidId, reason, now }: RefuseVoidInput): boolean {
    return this.update(
      `UPDATE sale_void_journal SET state = 'refused', refusal_reason = ?, updated_at = ?
        WHERE void_id = ? AND ${UNRESOLVED}`,
      reason,
      now,
      voidId,
    );
  }

  acknowledge({ voidId, now }: VoidStamp): boolean {
    return this.update(
      `UPDATE sale_void_journal SET acknowledged_at = ?, updated_at = ?
        WHERE void_id = ? AND state = 'refused' AND acknowledged_at IS NULL`,
      now,
      now,
      voidId,
    );
  }
}

export function createSaleVoidRepository(db: DatabaseHandle): SaleVoidRepository {
  return new SqlSaleVoidRepository(db);
}
