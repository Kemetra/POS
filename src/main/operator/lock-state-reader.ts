import type { LockStateSummary, LockStateView } from '../../shared/bridge-api.js';
import type { DatabaseHandle } from '../db/client.js';

import type { SessionManager } from './session-manager.js';

/**
 * RT-117 (RT-116 §7.2) — `operator.getLockState()`.
 *
 * The only read served while the session is LOCKED. It tells the lock screen
 * which unlock form to show (role) and summarizes the preserved sale as
 * TOTALS ONLY — line count, cart total, applied tender and whether live
 * tender exists. No line items, no product names, no credentials.
 *
 * A cart whose sale already SETTLED stays `frozen_handed_off` (005 has no
 * completed state), so it is excluded: a finished sale is never presented as
 * an open, preserved one. An empty cart has nothing to preserve.
 *
 * "Live tender" uses the same predicate as `bindAttemptHasLiveTender`
 * (`applying | applied | reversal_pending`, RT-116 M7).
 */

export interface LockStateReaderDeps {
  db: DatabaseHandle;
  sessionManager: SessionManager;
  /** The pairing row's real terminal_id, or null when unpaired. */
  resolveTerminalId: () => string | null;
}

type Get<T> = { get(...params: unknown[]): T | undefined };

export function createLockStateReader(deps: LockStateReaderDeps): () => LockStateView {
  const { db, sessionManager, resolveTerminalId } = deps;

  const cartStmt = (): Get<{ cart_id: string; cart_subtotal_minor: number }> =>
    db.prepare(
      `SELECT c.cart_id, c.cart_subtotal_minor FROM carts c
        WHERE c.operator_session_id = ? AND c.state <> 'cancelled'
          AND NOT EXISTS (
            SELECT 1 FROM payment_attempts a
             WHERE a.envelope_cart_id = c.cart_id AND a.state = 'settled'
          )
        ORDER BY c.created_at DESC LIMIT 1`,
    ) as Get<{ cart_id: string; cart_subtotal_minor: number }>;
  const lineCountStmt = (): Get<{ n: number }> =>
    db.prepare(
      `SELECT COUNT(*) AS n FROM cart_lines WHERE cart_id = ? AND removed_at IS NULL`,
    ) as Get<{ n: number }>;
  const tenderStmt = (): Get<{ applied: number | null; live: number | null }> =>
    db.prepare(
      `SELECT
         SUM(CASE WHEN l.state = 'applied' THEN l.amount_applied_minor ELSE 0 END) AS applied,
         SUM(CASE WHEN l.state IN ('applying', 'applied', 'reversal_pending') THEN 1 ELSE 0 END) AS live
         FROM payment_attempts a
         JOIN payment_tender_lines l ON l.payment_attempt_id = a.payment_attempt_id
        WHERE a.terminal_id = ? AND a.state = 'started' AND a.operator_session_id = ?`,
    ) as Get<{ applied: number | null; live: number | null }>;

  function summarize(session_id: string): LockStateSummary | null {
    const cart = cartStmt().get(session_id);
    if (cart === undefined) return null;
    const lines = lineCountStmt().get(cart.cart_id)?.n ?? 0;
    if (lines === 0) return null; // nothing to preserve
    const terminal_id = resolveTerminalId();
    const tender = terminal_id === null ? undefined : tenderStmt().get(terminal_id, session_id);
    return {
      line_count: lines,
      total_minor: cart.cart_subtotal_minor,
      tender_applied_minor: tender?.applied ?? 0,
      has_live_tender: (tender?.live ?? 0) > 0,
    };
  }

  return function getLockState(): LockStateView {
    const session = sessionManager.getCurrent();
    if (session === null) {
      return {
        state: 'signed_out',
        locked_at: null,
        role: null,
        display_name: null,
        summary: null,
      };
    }
    return {
      state: session.lock_state,
      locked_at: session.locked_at,
      role: session.role,
      display_name: session.display_name,
      summary: summarize(session.id),
    };
  };
}
