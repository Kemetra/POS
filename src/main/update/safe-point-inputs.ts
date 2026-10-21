import type { DatabaseHandle } from '../db/client.js';
import type { PrintActivity } from './print-activity.js';
import type { SafePointInputs } from './update-types.js';

/**
 * RT-772 slice 2 — the SQLite-backed readers behind the SafePointGate.
 *
 * Each reader is one cheap `SELECT ... LIMIT 1`, run fresh on every call. They
 * are deliberately conservative: when in doubt the answer is "not safe".
 *
 *   open shift   a cash-up open with no close, or a legacy `shifts` row still `open`
 *   open cart    a live sale with something to lose: not cancelled, not parked
 *                (a parked sale is already durably saved, RT-440), not settled,
 *                with at least one active line (same predicate as the lock screen)
 *   payment      any `payment_attempts` row still `started`, or a tender line whose external
 *                request is still due (`applying`, `reversal_pending`) even after its attempt
 *                failed: the deferred reversal resolver is then mid-call
 *   return       a `return_journal` row that is unfinished (`pending`, `unknown`,
 *                or `confirmed` and awaiting its cash payout)
 *   print        the in-memory dispatch counter
 */

type Get = { get(...params: unknown[]): unknown };

const OPEN_SHIFT = `
  SELECT 1 FROM shift_cashup_opens o
   WHERE NOT EXISTS (SELECT 1 FROM shift_cashup_closes c WHERE c.shift_id = o.shift_id)
   LIMIT 1`;

const OPEN_LEGACY_SHIFT = `SELECT 1 FROM shifts WHERE lifecycle_state = 'open' LIMIT 1`;

const OPEN_CART = `
  SELECT 1 FROM carts c
   WHERE c.state <> 'cancelled' AND c.parked_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM payment_attempts a
        WHERE a.envelope_cart_id = c.cart_id AND a.state = 'settled'
     )
     AND EXISTS (
       SELECT 1 FROM cart_lines l WHERE l.cart_id = c.cart_id AND l.removed_at IS NULL
     )
   LIMIT 1`;

const PAYMENT_IN_FLIGHT = `
  SELECT 1 FROM payment_attempts WHERE state = 'started'
  UNION ALL
  SELECT 1 FROM payment_tender_lines WHERE state IN ('applying', 'reversal_pending')
  LIMIT 1`;

const RETURN_IN_FLIGHT = `
  SELECT 1 FROM return_journal WHERE state IN ('pending', 'unknown', 'confirmed') LIMIT 1`;

export function createSafePointInputs(
  db: DatabaseHandle,
  printActivity: Pick<PrintActivity, 'isActive'>,
): SafePointInputs {
  const exists = (sql: string): boolean => (db.prepare(sql) as Get).get() !== undefined;
  return {
    hasOpenShift: () => exists(OPEN_SHIFT) || exists(OPEN_LEGACY_SHIFT),
    hasOpenCart: () => exists(OPEN_CART),
    hasNonTerminalPayment: () => exists(PAYMENT_IN_FLIGHT),
    hasReturnInFlight: () => exists(RETURN_IN_FLIGHT),
    isPrintInProgress: () => printActivity.isActive(),
  };
}
