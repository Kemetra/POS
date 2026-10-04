/**
 * RT-15 S4 — the drawer kick of a return payout.
 *
 * Uses the sale drawer's own hardware port (`DrawerKickTransport`, AD-8: the
 * kick is its own command). The port promises to always resolve; this wrapper
 * does not rely on that: a throw is `os_error`, an answer outside the
 * contract is `os_error` (never "opened"), and no answer within the deadline
 * is `timeout`. A late answer after the deadline is ignored: the payout has
 * already been told the drawer did not open, so nothing is recorded as paid.
 */
import type { DrawerKickTransport } from '../drawer/drawer-kick-transport.js';
import type { PayoutKickState } from '../../shared/returns/payout-rules.js';
import { RETURN_DRAWER_FAILURES, type ReturnDrawerFailure } from '../../shared/returns/types.js';

/** How long the payout waits for the drawer to answer. */
export const RETURN_DRAWER_TIMEOUT_MS = 5_000;

/**
 * Codex P1 (35e0d03): how long a kick still `sending` holds its payout, across
 * app instances sharing the database (2 x the drawer timeout: an instance
 * that is alive records its kick's outcome well within it). Must match the
 * 10 s of 0040's `trg_return_payouts_kick_lease`.
 */
export const RETURN_KICK_LEASE_MS = 2 * RETURN_DRAWER_TIMEOUT_MS;

/**
 * Whether a kick sent at `kickedAt` still holds its payout at `now`: within
 * the lease on EITHER side (reviewer P2: a clock that jumped backwards bounds
 * the lease, never extends it). Whole milliseconds, as 0040's trigger and the
 * repository's guarded UPDATE measure it.
 */
export function withinKickLease(kickedAt: string, now: string): boolean {
  const elapsed = Date.parse(now) - Date.parse(kickedAt);
  return elapsed >= -RETURN_KICK_LEASE_MS && elapsed < RETURN_KICK_LEASE_MS;
}

/** A payout row's kick record, as the payout rule needs it. */
export interface KickRecord {
  readonly kickOutcome: 'sending' | 'opened' | 'failed_before_send' | 'unknown' | null;
  readonly kickedAt: string | null;
}

/**
 * The kick as the payout rule sees it at `now`: `in_flight` while still
 * `sending` within the lease; `unknown` once its lease ran out (its process
 * died). Without a clock (`now` null) a sending kick is in flight
 * (conservative: nothing completes it).
 */
export function kickStateOf(record: KickRecord, now: string | null): PayoutKickState {
  if (record.kickOutcome === null) return 'none';
  if (record.kickOutcome !== 'sending') return record.kickOutcome;
  const held = now === null || record.kickedAt === null || withinKickLease(record.kickedAt, now);
  return held ? 'in_flight' : 'unknown';
}

export type ReturnDrawerOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ReturnDrawerFailure };

const OS_ERROR: ReturnDrawerOutcome = { ok: false, reason: 'os_error' };
const TIMEOUT: ReturnDrawerOutcome = { ok: false, reason: 'timeout' };

function isFailure(value: unknown): value is ReturnDrawerFailure {
  return (RETURN_DRAWER_FAILURES as readonly unknown[]).includes(value);
}

/** The transport's answer as a closed outcome; anything unexpected is `os_error`. */
function closed(answer: unknown): ReturnDrawerOutcome {
  if (typeof answer !== 'object' || answer === null) return OS_ERROR;
  const { ok, failure_reason: reason } = answer as { ok?: unknown; failure_reason?: unknown };
  if (ok === true) return { ok: true };
  return ok === false && isFailure(reason) ? { ok: false, reason } : OS_ERROR;
}

async function ask(transport: DrawerKickTransport): Promise<ReturnDrawerOutcome> {
  try {
    return closed(await transport.kick());
  } catch {
    return OS_ERROR;
  }
}

export function kickReturnDrawer(transport: DrawerKickTransport): Promise<ReturnDrawerOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReturnDrawerOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMEOUT);
    }, RETURN_DRAWER_TIMEOUT_MS);
  });
  return Promise.race([ask(transport), deadline]).finally(() => {
    clearTimeout(timer);
  });
}
