/**
 * RT-15 S4 — the payout repository (migration 0040).
 *
 * A payout is started (claimed) before the drawer opens and completed once
 * after it did (or after the operator attested a manual payout). `complete`
 * moves the payout row AND the journal header (`confirmed -> paid_out`)
 * together; the caller runs it in one transaction with the `paid_out` audit,
 * so the two never disagree. The schema triggers are the backstop.
 *
 * `DatabaseHandle` is injected so tests run on sql.js.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { ReturnPayoutMethod } from '../../shared/returns/types.js';

export interface PayoutRow {
  readonly returnId: string;
  readonly startedOperatorId: string;
  readonly startedSessionId: string;
  readonly startedAt: string;
  readonly paidOperatorId: string | null;
  readonly paidOperatorName: string | null;
  readonly paidSessionId: string | null;
  readonly paidAt: string | null;
  readonly method: ReturnPayoutMethod | null;
}

export interface StartPayoutInput {
  readonly returnId: string;
  readonly operatorId: string;
  readonly sessionId: string;
  readonly now: string;
}

export interface CompletePayoutInput {
  readonly returnId: string;
  readonly operatorId: string;
  /** The operator's display name, for the slip; null when unknown. */
  readonly operatorName: string | null;
  readonly sessionId: string;
  readonly method: ReturnPayoutMethod;
  readonly now: string;
}

/** The slip facts of one returned line (0040), journaled with the quote. */
export interface LineDetail {
  readonly lineRef: string;
  /** Null when the server line had no printable name. */
  readonly lineName: string | null;
  readonly amountMinor: number;
}

/** One line as the slip prints it; name and amount are null before 0040. */
export interface SlipLine {
  readonly lineRef: string;
  readonly quantity: number;
  readonly lineName: string | null;
  readonly amountMinor: number | null;
}

export interface ReturnPayoutsRepository {
  read(returnId: string): PayoutRow | null;
  /** The payouts of `returnIds`, keyed by return id (absent when none was started). */
  readMany(returnIds: readonly string[]): Map<string, PayoutRow>;
  /** Start (claim) the payout; false when one was already started. */
  start(input: StartPayoutInput): boolean;
  /**
   * Complete a started, unpaid payout and move the header to `paid_out`.
   * False when there is no started unpaid payout. Run inside a transaction.
   */
  complete(input: CompletePayoutInput): boolean;
  /** Write the slip facts of a return's lines (inside the journal insert). */
  recordLineDetails(returnId: string, details: readonly LineDetail[]): void;
  slipLines(returnId: string): SlipLine[];
}

interface Stmt {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface PayoutDbRow {
  return_id: string;
  started_operator_id: string;
  started_session_id: string;
  started_at: string;
  paid_operator_id: string | null;
  paid_operator_name: string | null;
  paid_session_id: string | null;
  paid_at: string | null;
  method: ReturnPayoutMethod | null;
}

interface SlipLineDbRow {
  line_ref: string;
  quantity: number;
  line_name: string | null;
  amount_minor: number | null;
}

function toPayout(row: PayoutDbRow): PayoutRow {
  return {
    returnId: row.return_id,
    startedOperatorId: row.started_operator_id,
    startedSessionId: row.started_session_id,
    startedAt: row.started_at,
    paidOperatorId: row.paid_operator_id,
    paidOperatorName: row.paid_operator_name,
    paidSessionId: row.paid_session_id,
    paidAt: row.paid_at,
    method: row.method,
  };
}

class SqlReturnPayoutsRepository implements ReturnPayoutsRepository {
  constructor(private readonly db: DatabaseHandle) {}

  private prepare(sql: string): Stmt {
    return this.db.prepare(sql) as Stmt;
  }

  read(returnId: string): PayoutRow | null {
    const row = this.prepare('SELECT * FROM return_payouts WHERE return_id = ?').get(returnId);
    return row === undefined ? null : toPayout(row as PayoutDbRow);
  }

  readMany(returnIds: readonly string[]): Map<string, PayoutRow> {
    if (returnIds.length === 0) return new Map();
    const marks = returnIds.map(() => '?').join(', ');
    const rows = this.prepare(`SELECT * FROM return_payouts WHERE return_id IN (${marks})`).all(
      ...returnIds,
    ) as PayoutDbRow[];
    return new Map(rows.map((row) => [row.return_id, toPayout(row)]));
  }

  start(input: StartPayoutInput): boolean {
    const sql = `INSERT OR IGNORE INTO return_payouts
      (return_id, started_operator_id, started_session_id, started_at) VALUES (?, ?, ?, ?)`;
    const params = [input.returnId, input.operatorId, input.sessionId, input.now];
    return this.prepare(sql).run(...params).changes > 0;
  }

  complete(input: CompletePayoutInput): boolean {
    const paid = this.prepare(
      `UPDATE return_payouts SET paid_operator_id = ?, paid_operator_name = ?,
         paid_session_id = ?, paid_at = ?, method = ?
       WHERE return_id = ? AND paid_at IS NULL`,
    ).run(
      input.operatorId,
      input.operatorName,
      input.sessionId,
      input.now,
      input.method,
      input.returnId,
    );
    if (paid.changes === 0) return false;
    const header = this.prepare(
      `UPDATE return_journal SET state = 'paid_out', paid_out_at = ?, updated_at = ?
       WHERE return_id = ? AND state = 'confirmed'`,
    ).run(input.now, input.now, input.returnId);
    // A started payout always has a confirmed header (0040 trigger); throwing
    // rolls the caller's transaction back rather than leave the two apart.
    if (header.changes === 0) throw new Error('returns-payout: header is not confirmed');
    return true;
  }

  recordLineDetails(returnId: string, details: readonly LineDetail[]): void {
    const insert = this.prepare(
      `INSERT INTO return_journal_line_details (return_id, line_ref, line_name, amount_minor)
       VALUES (?, ?, ?, ?)`,
    );
    for (const d of details) insert.run(returnId, d.lineRef, d.lineName, d.amountMinor);
  }

  slipLines(returnId: string): SlipLine[] {
    const rows = this.prepare(
      `SELECT l.line_ref, l.quantity, d.line_name, d.amount_minor
         FROM return_journal_lines l
         LEFT JOIN return_journal_line_details d
           ON d.return_id = l.return_id AND d.line_ref = l.line_ref
        WHERE l.return_id = ? ORDER BY l.rowid`,
    ).all(returnId) as SlipLineDbRow[];
    return rows.map((r) => ({
      lineRef: r.line_ref,
      quantity: r.quantity,
      lineName: r.line_name,
      amountMinor: r.amount_minor,
    }));
  }
}

export function createReturnPayoutsRepository(db: DatabaseHandle): ReturnPayoutsRepository {
  return new SqlReturnPayoutsRepository(db);
}
