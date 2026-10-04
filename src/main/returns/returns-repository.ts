/**
 * RT-15 S2 — the return journal repository (migration 0039).
 *
 * The journal is written BEFORE a return is sent (AC8). Every state change is a
 * guarded UPDATE that only moves a row out of `pending` / `unknown`, so a
 * second confirmation (a resolver racing the submit, a replayed answer) changes
 * nothing and reports `false` — the caller then emits no second audit event and
 * no second payout (the schema triggers are the backstop).
 *
 * `DatabaseHandle` is injected so tests run on sql.js.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { ReturnState, ReturnsRefusalReason } from '../../shared/returns/types.js';

export interface ReturnScope {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
}

export interface JournalLine {
  readonly lineRef: string;
  readonly quantity: number;
}

export interface NewJournalEntry {
  readonly returnId: string;
  readonly scope: ReturnScope;
  readonly saleId: string;
  readonly saleNumber: string;
  readonly serverSaleRef: string;
  readonly externalId: string;
  readonly operatorId: string;
  readonly operatorSessionId: string;
  readonly currencyCode: string;
  readonly quotedTotalMinor: number;
  readonly requestBodyJson: string;
  readonly lines: readonly JournalLine[];
  readonly now: string;
}

export interface JournalEntry extends Omit<NewJournalEntry, 'now'> {
  readonly state: ReturnState;
  readonly returnRef: string | null;
  readonly returnTotalMinor: number | null;
  readonly refusalReason: ReturnsRefusalReason | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
}

/** One journal row at one instant: the argument of the simple transitions. */
export interface ReturnStamp {
  readonly returnId: string;
  readonly now: string;
}

export interface ConfirmInput {
  readonly returnId: string;
  readonly returnRef: string;
  readonly returnTotalMinor: number;
  readonly now: string;
}

export interface RefuseInput {
  readonly returnId: string;
  readonly reason: ReturnsRefusalReason;
  readonly now: string;
}

export interface ReturnsRepository {
  /**
   * Insert header + lines in one transaction; `within` (e.g. the attempt audit)
   * runs inside it with the new row, so both commit or neither does.
   */
  insert(entry: NewJournalEntry, within?: (inserted: JournalEntry) => void): void;
  read(returnId: string): JournalEntry | null;
  /** This terminal's returns, newest first. */
  listRecent(scope: ReturnScope, limit: number): JournalEntry[];
  /** This terminal's `pending` / `unknown` returns, oldest first (resolver order). */
  listUnresolved(scope: ReturnScope): JournalEntry[];
  /** True when the sale already has a `pending` / `unknown` return. */
  hasUnresolvedForSale(saleId: string): boolean;
  recordAttempt(stamp: ReturnStamp): void;
  /** pending/unknown → unknown. False when the row was already final. */
  markUnknown(stamp: ReturnStamp): boolean;
  /** pending/unknown → confirmed. False when already confirmed or final. */
  markConfirmed(input: ConfirmInput): boolean;
  /** pending/unknown → refused. False when already final. */
  markRefused(input: RefuseInput): boolean;
  /** confirmed → paid_out (S4 drawer). False otherwise. */
  markPaidOut(stamp: ReturnStamp): boolean;
}

interface Stmt {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface HeaderRow {
  return_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  sale_id: string;
  sale_number: string;
  server_sale_ref: string;
  external_id: string;
  operator_id: string;
  operator_session_id: string;
  currency_code: string;
  quoted_total_minor: number;
  request_body_json: string;
  state: ReturnState;
  return_ref: string | null;
  return_total_minor: number | null;
  refusal_reason: ReturnsRefusalReason | null;
  attempt_count: number;
  created_at: string;
  confirmed_at: string | null;
}

const UNRESOLVED = `state IN ('pending', 'unknown')`;
const SCOPE_WHERE = 'tenant_id = ? AND branch_id = ? AND terminal_id = ?';

function scopeParams(scope: ReturnScope): string[] {
  return [scope.tenantId, scope.branchId, scope.terminalId];
}

function toEntry(row: HeaderRow, lines: JournalLine[]): JournalEntry {
  return {
    returnId: row.return_id,
    scope: { tenantId: row.tenant_id, branchId: row.branch_id, terminalId: row.terminal_id },
    saleId: row.sale_id,
    saleNumber: row.sale_number,
    serverSaleRef: row.server_sale_ref,
    externalId: row.external_id,
    operatorId: row.operator_id,
    operatorSessionId: row.operator_session_id,
    currencyCode: row.currency_code,
    quotedTotalMinor: row.quoted_total_minor,
    requestBodyJson: row.request_body_json,
    lines,
    state: row.state,
    returnRef: row.return_ref,
    returnTotalMinor: row.return_total_minor,
    refusalReason: row.refusal_reason,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  };
}

function insertHeader(db: DatabaseHandle, e: NewJournalEntry): void {
  (
    db.prepare(
      `INSERT INTO return_journal
         (return_id, tenant_id, branch_id, terminal_id, sale_id, sale_number, server_sale_ref,
          external_id, operator_id, operator_session_id, currency_code, quoted_total_minor,
          request_body_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ) as Stmt
  ).run(
    e.returnId,
    ...scopeParams(e.scope),
    e.saleId,
    e.saleNumber,
    e.serverSaleRef,
    e.externalId,
    e.operatorId,
    e.operatorSessionId,
    e.currencyCode,
    e.quotedTotalMinor,
    e.requestBodyJson,
    e.now,
    e.now,
  );
}

type InsertHook = (inserted: JournalEntry) => void;

class SqlReturnsRepository implements ReturnsRepository {
  private readonly insertTx: (entry: NewJournalEntry, within: InsertHook) => void;

  constructor(private readonly db: DatabaseHandle) {
    this.insertTx = db.transaction((entry: NewJournalEntry, within: InsertHook): void => {
      insertHeader(db, entry);
      const line = this.prepare(
        'INSERT INTO return_journal_lines (return_id, line_ref, quantity) VALUES (?, ?, ?)',
      );
      for (const l of entry.lines) line.run(entry.returnId, l.lineRef, l.quantity);
      const inserted = this.read(entry.returnId);
      if (inserted !== null) within(inserted);
    });
  }

  private prepare(sql: string): Stmt {
    return this.db.prepare(sql) as Stmt;
  }

  private linesOf(returnId: string): JournalLine[] {
    const rows = this.prepare(
      'SELECT line_ref, quantity FROM return_journal_lines WHERE return_id = ? ORDER BY line_ref',
    ).all(returnId) as { line_ref: string; quantity: number }[];
    return rows.map((r) => ({ lineRef: r.line_ref, quantity: r.quantity }));
  }

  private hydrate(rows: unknown[]): JournalEntry[] {
    return (rows as HeaderRow[]).map((row) => toEntry(row, this.linesOf(row.return_id)));
  }

  /** Run a guarded UPDATE; true when it changed a row. */
  private update(statement: { sql: string; params: unknown[] }): boolean {
    return this.prepare(statement.sql).run(...statement.params).changes > 0;
  }

  insert(entry: NewJournalEntry, within: InsertHook = () => undefined): void {
    this.insertTx(entry, within);
  }

  read(returnId: string): JournalEntry | null {
    const row = this.prepare('SELECT * FROM return_journal WHERE return_id = ?').get(returnId);
    return row === undefined ? null : toEntry(row as HeaderRow, this.linesOf(returnId));
  }

  listRecent(scope: ReturnScope, limit: number): JournalEntry[] {
    const sql = `SELECT * FROM return_journal WHERE ${SCOPE_WHERE}
                 ORDER BY created_at DESC, return_id DESC LIMIT ?`;
    return this.hydrate(this.prepare(sql).all(...scopeParams(scope), limit));
  }

  listUnresolved(scope: ReturnScope): JournalEntry[] {
    const sql = `SELECT * FROM return_journal WHERE ${SCOPE_WHERE} AND ${UNRESOLVED}
                 ORDER BY created_at ASC, return_id ASC`;
    return this.hydrate(this.prepare(sql).all(...scopeParams(scope)));
  }

  hasUnresolvedForSale(saleId: string): boolean {
    const sql = `SELECT 1 FROM return_journal WHERE sale_id = ? AND ${UNRESOLVED} LIMIT 1`;
    return this.prepare(sql).get(saleId) !== undefined;
  }

  recordAttempt({ returnId, now }: ReturnStamp): void {
    this.update({
      sql: `UPDATE return_journal SET attempt_count = attempt_count + 1, last_attempt_at = ?,
         updated_at = ? WHERE return_id = ? AND ${UNRESOLVED}`,
      params: [now, now, returnId],
    });
  }

  markUnknown({ returnId, now }: ReturnStamp): boolean {
    return this.update({
      sql: `UPDATE return_journal SET state = 'unknown', updated_at = ?
       WHERE return_id = ? AND ${UNRESOLVED}`,
      params: [now, returnId],
    });
  }

  markConfirmed(input: ConfirmInput): boolean {
    return this.update({
      sql: `UPDATE return_journal SET state = 'confirmed', return_ref = ?, return_total_minor = ?,
         confirmed_at = ?, updated_at = ? WHERE return_id = ? AND ${UNRESOLVED}`,
      params: [input.returnRef, input.returnTotalMinor, input.now, input.now, input.returnId],
    });
  }

  markRefused(input: RefuseInput): boolean {
    return this.update({
      sql: `UPDATE return_journal SET state = 'refused', refusal_reason = ?, updated_at = ?
       WHERE return_id = ? AND ${UNRESOLVED}`,
      params: [input.reason, input.now, input.returnId],
    });
  }

  markPaidOut({ returnId, now }: ReturnStamp): boolean {
    return this.update({
      sql: `UPDATE return_journal SET state = 'paid_out', paid_out_at = ?, updated_at = ?
       WHERE return_id = ? AND state = 'confirmed'`,
      params: [now, now, returnId],
    });
  }
}

export function createReturnsRepository(db: DatabaseHandle): ReturnsRepository {
  return new SqlReturnsRepository(db);
}
