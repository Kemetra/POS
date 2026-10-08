/**
 * #380 (F-007 part b) — orphan-attempt sweep.
 *
 * A stuck `started` payment attempt for a terminal blocks every future sale on
 * it: `payments.start` calls `findStartedByTerminal` and refuses
 * `attempt_already_started_on_terminal`. Before #380's F-007 fix, terminal_id
 * collapsed to branch_id, so ONE stuck attempt bricked every terminal at the
 * branch. With the real terminal_id (F-007 part a) the blast radius is one
 * terminal — but that terminal is still bricked until the orphan clears.
 *
 * This sweeper discards a stuck attempt via the existing
 * `discardOnSessionEnd` machinery (LIFO-reverse applied tender lines, fail the
 * attempt with `operator_session_terminated`, emit audit). It is fired:
 *   • on session-END (clean sign-out / timeout) — the normal path; and
 *   • on session-START / sign-in — recovers the CRASH case, where the prior
 *     session's `end()` never ran so its orphan was never discarded.
 *
 * RT-117 (RT-115 D3 / RT-116 §9): an attempt holding LIVE tender is never
 * discarded — reversing it would record cash as returned (or a card as voided)
 * while the money is still in the drawer / on the card. Only a zero-funds
 * orphan is discarded (it has no tender lines to reverse).
 *
 * It is keyed on the REAL terminal_id (resolved by the same accessor the F-007
 * part-a flip uses), so an orphan on a DIFFERENT terminal is left untouched.
 *
 * Fire-and-forget by construction: the session lifecycle hooks (`create`/`end`)
 * are synchronous and the discard handler is async, so the caller invokes this
 * without awaiting. Failures are logged here (the SessionManager hook wrappers
 * swallow subscriber errors), never thrown.
 */

import type { PaymentAttemptsRepository } from './repositories/payment-attempts.repository.js';
import type {
  DiscardOnSessionEndInput,
  DiscardOnSessionEndOutcome,
} from './handlers/payments-discard-on-session-end.js';

export interface StuckAttemptSweeperDeps {
  /** Reads the (at most one) `started` attempt for a terminal. */
  attemptsRepo: Pick<PaymentAttemptsRepository, 'findStartedByTerminal'>;
  /** The existing discard handler (LIFO-reverse + fail + audit). */
  discard: (input: DiscardOnSessionEndInput) => Promise<DiscardOnSessionEndOutcome>;
  /**
   * Resolves the pairing row's REAL terminal_id, or null when unpaired
   * (production: `pairingStore.getCurrentTerminalId`). The session record
   * carries branch_id, not terminal_id, so the sweep resolves it the same way
   * the payment/sales/cart adapters do.
   */
  resolveTerminalId: () => string | null;
  /**
   * RT-117 (RT-116 §9, S1 interim) — does the attempt hold LIVE tender
   * (`applying | applied | reversal_pending`)? Such an attempt is never
   * auto-reversed by a session start/end: the money stays recorded and is
   * resolved explicitly. Required, so a dropped wiring cannot reopen the path.
   */
  attemptHasLiveTender: (payment_attempt_id: string) => boolean;
  /** Structured error sink — failures here must not surface to the operator. */
  logError: (err: unknown, context: { terminal_id: string; payment_attempt_id: string }) => void;
}

export type StuckAttemptSweeper = () => Promise<void>;

export function createStuckAttemptSweeper(deps: StuckAttemptSweeperDeps): StuckAttemptSweeper {
  const { attemptsRepo, discard, resolveTerminalId, attemptHasLiveTender, logError } = deps;

  return async function sweepStuckAttempt(): Promise<void> {
    const terminal_id = resolveTerminalId();
    if (terminal_id === null) return; // unpaired — nothing to sweep

    const stuck = attemptsRepo.findStartedByTerminal(terminal_id);
    if (stuck === undefined) return; // no orphan on THIS terminal

    // RT-117 — never auto-reverse money. A live-tender attempt is left as is
    // (fail-closed: an unreadable check counts as live).
    let live: boolean;
    try {
      live = attemptHasLiveTender(stuck.payment_attempt_id);
    } catch (err) {
      logError(err, { terminal_id, payment_attempt_id: stuck.payment_attempt_id });
      return;
    }
    if (live) return;

    try {
      await discard({ payment_attempt_id: stuck.payment_attempt_id });
    } catch (err) {
      // The discard handler is idempotent and rarely fails; if it does, log
      // and move on — a failed sweep must never break sign-in or sign-out.
      logError(err, { terminal_id, payment_attempt_id: stuck.payment_attempt_id });
    }
  };
}
