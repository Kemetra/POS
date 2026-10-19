/**
 * RT-196 S1 — the last cause of an unknown return, read from the local audit.
 *
 * `return_journal` stores no cause (migration 0039, left untouched): each send
 * that leaves a row unknown writes a `sale.return.attempt_unknown` event, and
 * the newest one per return is its last cause. One batched query serves the
 * rows `returns.list` shows. A value outside the closed set reads as null
 * (fail closed): the renderer never shows a cause main did not name.
 */
import { RETURN_UNKNOWN_CAUSES, type ReturnUnknownCause } from '../../shared/returns/types.js';
import type { DatabaseHandle } from '../db/client.js';

export interface ReturnCauseReader {
  /** The newest recorded cause per return id; ids without one are absent. */
  lastCauses(returnIds: readonly string[]): Map<string, ReturnUnknownCause>;
}

interface CauseRow {
  return_id: string;
  cause: string | null;
}

const KNOWN: ReadonlySet<string> = new Set(RETURN_UNKNOWN_CAUSES);

function isCause(value: string | null): value is ReturnUnknownCause {
  return value !== null && KNOWN.has(value);
}

interface Stmt {
  all(...params: unknown[]): unknown[];
}

export function createReturnCauseReader(db: DatabaseHandle): ReturnCauseReader {
  return {
    lastCauses(returnIds) {
      const causes = new Map<string, ReturnUnknownCause>();
      if (returnIds.length === 0) return causes;
      const marks = returnIds.map(() => '?').join(', ');
      const statement = db.prepare(
        `SELECT json_extract(payload, '$.return_id') AS return_id,
                json_extract(payload, '$.cause') AS cause
           FROM audit_events
          WHERE action_category = 'sale.return.attempt_unknown'
            AND json_extract(payload, '$.return_id') IN (${marks})
          ORDER BY rowid ASC`,
      ) as Stmt;
      // Oldest first: a later row overwrites an earlier one for the same return.
      for (const row of statement.all(...returnIds) as CauseRow[]) {
        if (isCause(row.cause)) causes.set(row.return_id, row.cause);
        else causes.delete(row.return_id);
      }
      return causes;
    },
  };
}
