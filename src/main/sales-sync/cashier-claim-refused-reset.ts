/**
 * RT-225 step 3 — the support-only reset of `cashier_claim_refused` dead-letters.
 *
 * Before RT-225 a cashier sale finalized late (boot recovery stamps
 * `finalized_at` at boot) was sent with only `occurredAt`, fell outside the
 * cashier's admission window and was refused (device-path 403). The engine
 * dead-lettered it as `cashier_claim_refused`, permanently. The sale itself is
 * intact (`sales` and the outbox are append-only), so it can be re-sent — now
 * with `admissionCheckAt` where it applies.
 *
 * Surface (Jira RT-225 plan 10915, owner decision 10916): support sets
 * `POS_PULSE_SUPPORT_RESET_CASHIER_CLAIM_REFUSED=1` and restarts the till. On
 * start, before the drain's first tick, the CURRENT terminal's
 * `cashier_claim_refused` dead-letters go back to `pending`; the drain re-sends
 * them. Exactly `1` requests it; anything else (unset included) does nothing.
 * Each reset is one re-send per sale: a sale refused again is dead-lettered
 * again. Support removes the variable afterwards; left set, the reset repeats on
 * every start (one more re-send per still-refused sale per start, never a loop).
 *
 * Never throws into the boot path. Log lines carry a count only — no sale ids,
 * user ids, tokens or PII (P7).
 */
import type { DrainScope, SaleSyncStateRepo } from './sale-sync-state-repo.js';

export const CASHIER_CLAIM_REFUSED_RESET_ENV = 'POS_PULSE_SUPPORT_RESET_CASHIER_CLAIM_REFUSED';
export const CASHIER_CLAIM_REFUSED_RESET_LOG = 'sale_sync:cashier_claim_refused_reset';
export const CASHIER_CLAIM_REFUSED_RESET_FAILED_LOG =
  'sale_sync:cashier_claim_refused_reset_failed';

/** Whether the support variable requests the reset: exactly `1` (trimmed). */
export function isCashierClaimRefusedResetRequested(raw: string | undefined): boolean {
  return raw?.trim() === '1';
}

export interface CashierClaimRefusedResetDeps {
  requested: boolean;
  stateRepo: Pick<SaleSyncStateRepo, 'resetCashierClaimRefused'>;
  /** The drain's scope: tenant, branch and the CURRENT pairing's terminal. */
  scope: DrainScope;
  /** ISO-8601 UTC. */
  now: string;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

/** Run the reset when requested; returns how many sales were re-queued. */
export function resetCashierClaimRefusedOnStart(deps: CashierClaimRefusedResetDeps): number {
  if (!deps.requested) return 0;
  let count: number;
  try {
    count = deps.stateRepo.resetCashierClaimRefused(deps.scope, deps.now);
  } catch {
    deps.logger.warn({}, CASHIER_CLAIM_REFUSED_RESET_FAILED_LOG);
    return 0;
  }
  deps.logger.info({ count }, CASHIER_CLAIM_REFUSED_RESET_LOG);
  return count;
}
