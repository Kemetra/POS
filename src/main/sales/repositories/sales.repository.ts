/**
 * T081 — `sales` repository.
 *
 * Owns SQL access for the `sales` table (008-sale-finalization-and-receipts
 * Slice 1c). Wraps the production `DatabaseHandle` interface so tests can
 * inject a sql.js adapter. Surface is intentionally narrow per tasks.md
 * T081: insert / readById / findByNumber (tenant-scoped) /
 * findByHandoffActionId (AD-2 idempotency anchor).
 *
 * No `update`, no `delete`: `sales` is append-only at the SQL layer
 * (migration 0021 triggers). The repository surface enforces this at the
 * type level by omitting those methods.
 *
 * Tenant-isolation invariant: every read path that takes a sale_number
 * (renderer-facing identifier) is scoped to (tenant_id, branch_id,
 * terminal_id) per Constitution §P17 and §A4 checklist item 6.
 * RT-541 `listByFinalizedRange` is scoped the same way, and optionally to one
 * selling operator (the RT-546 own-sales filter).
 * `readById` and `findByHandoffActionId` are main-process-only paths
 * (AD-2 listener, finalize transaction) and do not require external
 * scoping — the calling transaction is the security boundary.
 */

import type { DatabaseHandle } from '../../db/client.js';

// ── Narrow better-sqlite3 surfaces (no native binding required at test time) ──

interface PrepareRun {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}

// ── Persisted row shape (mirrors migrations/0020_create_sales.sql) ──────────

export interface SaleRow {
  sale_id: string;
  sale_number: string;
  receipt_number: string;
  envelope_handoff_action_id: string;
  payment_attempt_id: string;
  envelope_cart_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  terminal_label: string;
  selling_operator_id: string;
  selling_operator_display_name: string;
  selling_operator_session_id: string;
  subtotal_minor: number;
  total_tax_minor: number;
  total_change_due_minor: number;
  tender_lines_summary_json: string;
  settled_at: string;
  finalized_at: string;
  tenant_tax_registration_id: string;
  branch_name: string;
  branch_address: string;
  local_calendar_day: string;
  /**
   * JSON-serialised snapshot of the cart's item lines (the
   * `PaymentIntentEnvelope.lines` array — `LineSnapshot[]`) captured at
   * finalize time. Read back at reprint time so the slip body is
   * byte-stable regardless of later catalogue/cart drift (FR-015 / FR-016).
   * Defaults to '[]' at the SQL layer (migration 0028) for pre-T028a rows.
   */
  lines_json: string;
}

export type InsertSaleRowInput = SaleRow;

export interface TenantScope {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
}

/** RT-541: the keyset position after which the next page starts. */
export interface SaleListCursor {
  finalized_at: string;
  sale_id: string;
}

/** RT-541: one range read, newest first. Bounds use `Date#toISOString` format. */
export interface SaleListQuery {
  scope: TenantScope;
  /** Only this operator's sales (a cashier), or null for the whole scope. */
  selling_operator_id: string | null;
  start_inclusive: string;
  end_exclusive: string;
  /** Rows strictly after this position in the order, or null for page one. */
  after: SaleListCursor | null;
  limit: number;
}

/** RT-541: the columns a history list row needs; no lines, no main-only fields. */
export type SaleListRow = Pick<
  SaleRow,
  | 'sale_id'
  | 'sale_number'
  | 'terminal_label'
  | 'selling_operator_display_name'
  | 'subtotal_minor'
  | 'total_tax_minor'
  | 'finalized_at'
>;

const SALES_LIST_SELECT = `SELECT sale_id, sale_number, terminal_label, selling_operator_display_name,
       subtotal_minor, total_tax_minor, finalized_at
  FROM sales
 WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?
   AND (? IS NULL OR selling_operator_id = ?)
   AND finalized_at >= ? AND finalized_at < ?`;
const SALES_LIST_ORDER = `ORDER BY finalized_at DESC, sale_id DESC LIMIT ?`;

/**
 * RT-541: the first page of a range read. Exported so tests can check the
 * query plan uses `idx_sales_tenant_branch_finalized_at` (migration 0055).
 */
export const SALES_LIST_SQL = `${SALES_LIST_SELECT}
 ${SALES_LIST_ORDER}`;

/**
 * RT-541: a later page. `finalized_at <= ?` keeps the index range tight, so a
 * deep page does not re-read the rows of earlier pages.
 */
export const SALES_LIST_AFTER_SQL = `${SALES_LIST_SELECT}
   AND finalized_at <= ? AND (finalized_at < ? OR sale_id < ?)
 ${SALES_LIST_ORDER}`;

export interface SalesRepository {
  insert(row: InsertSaleRowInput): void;
  readById(sale_id: string): SaleRow | null;
  findByNumber(sale_number: string, scope: TenantScope): SaleRow | null;
  /**
   * AD-2 idempotency anchor (FR-001 / SC-009). Returns the existing sale row
   * if one was already created for this envelope handoff, else null. The
   * finalize transaction (T091) calls this BEFORE allocating a sale_number;
   * a non-null return short-circuits the entire finalize and returns the
   * existing sale_id to the caller.
   */
  findByHandoffActionId(envelope_handoff_action_id: string): SaleRow | null;
  /**
   * RT-541: the sales finalized in `[start_inclusive, end_exclusive)` within
   * the scope, ordered `finalized_at DESC, sale_id DESC`, at most `limit`.
   */
  listByFinalizedRange(query: SaleListQuery): SaleListRow[];
}

export function bindSalesRepository(db: DatabaseHandle): SalesRepository {
  const insertStmt = db.prepare(
    `INSERT INTO sales (
       sale_id, sale_number, receipt_number, envelope_handoff_action_id, payment_attempt_id,
       envelope_cart_id, tenant_id, branch_id, terminal_id, terminal_label,
       selling_operator_id, selling_operator_display_name, selling_operator_session_id,
       subtotal_minor, total_tax_minor, total_change_due_minor, tender_lines_summary_json,
       settled_at, finalized_at, tenant_tax_registration_id, branch_name, branch_address,
       local_calendar_day, lines_json
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?
     )`,
  ) as PrepareRun;

  const readByIdStmt = db.prepare(`SELECT * FROM sales WHERE sale_id = ?`) as PrepareGet<SaleRow>;

  const findByNumberStmt = db.prepare(
    `SELECT * FROM sales
      WHERE sale_number = ?
        AND tenant_id = ?
        AND branch_id = ?
        AND terminal_id = ?`,
  ) as PrepareGet<SaleRow>;

  const findByHandoffStmt = db.prepare(
    `SELECT * FROM sales WHERE envelope_handoff_action_id = ?`,
  ) as PrepareGet<SaleRow>;

  const listStmt = db.prepare(SALES_LIST_SQL) as PrepareAll<SaleListRow>;
  const listAfterStmt = db.prepare(SALES_LIST_AFTER_SQL) as PrepareAll<SaleListRow>;

  return {
    insert(row: InsertSaleRowInput): void {
      insertStmt.run(
        row.sale_id,
        row.sale_number,
        row.receipt_number,
        row.envelope_handoff_action_id,
        row.payment_attempt_id,
        row.envelope_cart_id,
        row.tenant_id,
        row.branch_id,
        row.terminal_id,
        row.terminal_label,
        row.selling_operator_id,
        row.selling_operator_display_name,
        row.selling_operator_session_id,
        row.subtotal_minor,
        row.total_tax_minor,
        row.total_change_due_minor,
        row.tender_lines_summary_json,
        row.settled_at,
        row.finalized_at,
        row.tenant_tax_registration_id,
        row.branch_name,
        row.branch_address,
        row.local_calendar_day,
        row.lines_json,
      );
    },

    readById(sale_id: string): SaleRow | null {
      const row = readByIdStmt.get(sale_id);
      return row ?? null;
    },

    findByNumber(sale_number: string, scope: TenantScope): SaleRow | null {
      const row = findByNumberStmt.get(
        sale_number,
        scope.tenant_id,
        scope.branch_id,
        scope.terminal_id,
      );
      return row ?? null;
    },

    findByHandoffActionId(envelope_handoff_action_id: string): SaleRow | null {
      const row = findByHandoffStmt.get(envelope_handoff_action_id);
      return row ?? null;
    },

    listByFinalizedRange(query: SaleListQuery): SaleListRow[] {
      const { scope, selling_operator_id: operator, after } = query;
      const head = [
        scope.tenant_id,
        scope.branch_id,
        scope.terminal_id,
        operator,
        operator,
        query.start_inclusive,
        query.end_exclusive,
      ];
      if (after === null) return listStmt.all(...head, query.limit);
      return listAfterStmt.all(
        ...head,
        after.finalized_at,
        after.finalized_at,
        after.sale_id,
        query.limit,
      );
    },
  };
}
