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
import { RETURN_KICK_LEASE_MS, withinKickLease } from './returns-drawer.js';

/**
 * The drawer kick record of a payout (0040). `sending` is written before the
 * transport is called; `failed_before_send` (provably never reached the
 * hardware) is the only outcome after which the drawer may be kicked again.
 */
export type KickOutcome = 'sending' | 'opened' | 'failed_before_send' | 'unknown';
export type KickResult = Exclude<KickOutcome, 'sending'>;

/**
 * What `complete` did: completed, or why not (Codex P2: a lost race is told
 * apart, so a kick in flight in another instance is never `already_paid`).
 */
export type CompleteResult =
  | 'completed'
  | 'already_paid'
  | 'kick_in_progress'
  | 'not_started'
  | 'drawer_not_opened';

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
  readonly kickOutcome: KickOutcome | null;
  readonly kickCount: number;
  readonly kickedAt: string | null;
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
   * Record that a kick is about to be sent (counted), BEFORE the transport is
   * called. False unless the payout is unpaid and was never kicked or its last
   * kick provably never left (`failed_before_send`).
   */
  markSending(stamp: { readonly returnId: string; readonly now: string }): boolean;
  /** Resolve the kick in flight (`sending`) to its outcome, once. */
  recordKick(input: { readonly returnId: string; readonly outcome: KickResult }): boolean;
  /**
   * Complete a started, unpaid payout and move the header to `paid_out`. A
   * `drawer` completion needs a drawer that opened; a kick still `sending`
   * within the lease holds it. Else why not. Run inside a transaction.
   */
  complete(input: CompletePayoutInput): CompleteResult;
  /** Write the slip facts of a return's lines (inside the journal insert). */
  recordLineDetails(returnId: string, details: readonly LineDetail[]): void;
  slipLines(returnId: string): SlipLine[];
}

/**
 * Codex P1 lease, in SQL: the kick was sent within the lease of the
 * completion's own time, on either side (reviewer P2: a backward clock jump
 * never extends it). Whole milliseconds; never SQLite's clock. Binds: now,
 * -lease ms, lease ms - 1.
 */
const KICK_HELD = `CAST(ROUND((julianday(?) - julianday(kicked_at)) * 86400000.0) AS INTEGER)
  BETWEEN ? AND ?`;

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
  kick_outcome: KickOutcome | null;
  kick_count: number;
  kicked_at: string | null;
}

interface SlipLineDbRow {
  line_ref: string;
  quantity: number;
  line_name: string | null;
  amount_minor: number | null;
}

/** Why a completion changed nothing, from the row as it stands now. */
function notCompleted(row: PayoutRow | null, now: string): Exclude<CompleteResult, 'completed'> {
  if (row === null) return 'not_started';
  if (row.paidAt !== null) return 'already_paid';
  const sending = row.kickOutcome === 'sending' && row.kickedAt !== null;
  return sending && withinKickLease(row.kickedAt, now) ? 'kick_in_progress' : 'drawer_not_opened';
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
    kickOutcome: row.kick_outcome,
    kickCount: row.kick_count,
    kickedAt: row.kicked_at,
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

  markSending({ returnId, now }: { returnId: string; now: string }): boolean {
    const sql = `UPDATE return_payouts SET kick_outcome = 'sending', kick_count = kick_count + 1,
        kicked_at = ?
      WHERE return_id = ? AND paid_at IS NULL
        AND (kick_outcome IS NULL OR kick_outcome = 'failed_before_send')`;
    return this.prepare(sql).run(now, returnId).changes > 0;
  }

  recordKick({ returnId, outcome }: { returnId: string; outcome: KickResult }): boolean {
    const sql = `UPDATE return_payouts SET kick_outcome = ?
      WHERE return_id = ? AND kick_outcome = 'sending'`;
    return this.prepare(sql).run(outcome, returnId).changes > 0;
  }

  complete(input: CompletePayoutInput): CompleteResult {
    const paid = this.prepare(
      `UPDATE return_payouts SET paid_operator_id = ?, paid_operator_name = ?,
         paid_session_id = ?, paid_at = ?, method = ?
       WHERE return_id = ? AND paid_at IS NULL
         AND (? = 'manual' OR kick_outcome = 'opened')
         AND NOT (kick_outcome IS 'sending' AND ${KICK_HELD})`,
    ).run(
      input.operatorId,
      input.operatorName,
      input.sessionId,
      input.now,
      input.method,
      input.returnId,
      input.method,
      input.now,
      -RETURN_KICK_LEASE_MS,
      RETURN_KICK_LEASE_MS - 1,
    );
    if (paid.changes === 0) return notCompleted(this.read(input.returnId), input.now);
    // A started payout always has a confirmed header (0040), and the header
    // reaches paid_out only with this completed row (0040 trigger). Fail
    // closed anyway: throwing rolls the caller's transaction back rather than
    // leave a paid payout beside a header that did not move.
    const header = this.prepare(
      `UPDATE return_journal SET state = 'paid_out', paid_out_at = ?, updated_at = ?
       WHERE return_id = ? AND state = 'confirmed'`,
    ).run(input.now, input.now, input.returnId);
    if (header.changes === 0) throw new Error('returns-payout: header is not confirmed');
    return 'completed';
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
