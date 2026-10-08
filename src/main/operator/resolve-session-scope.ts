/**
 * #380 (F-007) — session-scope resolver shared by the payments + sales session
 * adapters (composition root, index.ts).
 *
 * The bug: those adapters stamped `terminal_id = session.branch_id`, collapsing
 * every terminal at a branch into one payment scope — so one stuck `started`
 * attempt bricked the whole branch. The fix sources the REAL terminal_id from
 * the pairing store (`getCurrentTerminalId()`); this function is the single seam
 * that builds the adapter return value, extracted so it is unit-testable (the
 * inline index.ts closures were not) and so payments + sales share one
 * implementation.
 *
 * Returns null — i.e. "no transactable session" — when there is no operator
 * session OR the terminal is unpaired (`terminalId === null`). Callers already
 * treat a null session as "no operator session"; carts.terminal_id /
 * payment_attempts.terminal_id are NOT NULL, so an unpaired terminal must not
 * proceed.
 *
 * Returns the payments-shaped scope (a structural superset of the sales scope),
 * so the sales adapter can use the same function and pick its subset by type.
 */

import type { OperatorSessionRecord } from './session-manager.js';
import type { OperatorSessionForPayments } from '../payments/require-operator-session.js';

export function resolveSessionScope(
  session: OperatorSessionRecord | null,
  terminalId: string | null,
): OperatorSessionForPayments | null {
  if (session === null) return null;
  if (terminalId === null) return null; // unpaired — cannot transact
  return {
    role: session.role,
    operator_id: session.operator_id,
    operator_session_id: session.id,
    tenant_id: session.tenant_id,
    branch_id: session.branch_id,
    terminal_id: terminalId,
    display_name: session.display_name,
    // RT-224 step 2: only an admitted cashier session has one (main-only).
    ...(session.user_id === undefined ? {} : { user_id: session.user_id }),
  };
}
