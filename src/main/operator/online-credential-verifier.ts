import type { RefusalCategory } from '../../shared/audit/event-shape.js';

import type { ClerkExchanger } from './clerk-client.js';

/**
 * RT-117 + RT-358 — the manager/admin online credential check, shared by the
 * lock-screen online unlock (RT-117, owner decision Z3) and the in-place
 * re-auth (`operator:reauthenticate`, RT-247 plan §2.3).
 *
 *   • The exchanged identity must equal the expected operator. Another
 *     person's valid credentials are refused with the SAME generic
 *     `invalid_input` as wrong credentials, so the result never reveals that
 *     another account's credentials were valid.
 *   • One shared limiter mirrors the 004 PIN lockout (5 failures → 5 min); a
 *     network failure never counts.
 *   • One attempt at a time: a second online attempt while one is in flight is
 *     refused `rate_limited` and sends nothing, so concurrent callers cannot
 *     each pass the lockout check before a failure is recorded.
 *
 * The credentials and the returned JWT are never logged.
 */

export interface OnlineCredentialVerifierDeps {
  clerk: ClerkExchanger;
  now?: () => Date;
}

/** `stage` is a closed, value-free label for the caller's log line. */
export type OnlineVerdict =
  | { kind: 'verified'; jwt: string }
  | { kind: 'refused'; category: RefusalCategory; stage: string };

/** Same thresholds as the 004 PIN lockout (`pin-lockout.ts`). */
const MAX_ONLINE_FAILURES = 5;
const ONLINE_LOCKOUT_MS = 5 * 60_000;

interface OnlineFailures {
  operator_id: string;
  count: number;
  locked_until_ms: number | null;
}

function refused(category: RefusalCategory, stage: string): OnlineVerdict {
  return { kind: 'refused', category, stage };
}

export class OnlineCredentialVerifier {
  private inFlight = false;
  private failures: OnlineFailures | null = null;

  constructor(private readonly deps: OnlineCredentialVerifierDeps) {}

  async verify(operator_id: string, identifier: string, password: string): Promise<OnlineVerdict> {
    if (this.isLockedOut(operator_id)) return refused('rate_limited', 'online_lockout');
    if (this.inFlight) return refused('rate_limited', 'concurrent');
    this.inFlight = true;
    try {
      const exchange = await this.deps.clerk.exchange({ identifier, password });
      if (exchange.kind === 'no_connection') return refused('no_connection', 'clerk');
      if (exchange.kind !== 'ok' || exchange.operator_id !== operator_id) {
        this.recordFailure(operator_id);
        return refused('invalid_input', 'identity');
      }
      this.failures = null;
      return { kind: 'verified', jwt: exchange.jwt };
    } finally {
      this.inFlight = false;
    }
  }

  /** True while the operator's online backoff is active; an expired one resets. */
  private isLockedOut(operator_id: string): boolean {
    const f = this.failures;
    if (f?.operator_id !== operator_id || f.locked_until_ms === null) return false;
    if (this.now().getTime() < f.locked_until_ms) return true;
    this.failures = null;
    return false;
  }

  private recordFailure(operator_id: string): void {
    const prior = this.failures?.operator_id === operator_id ? this.failures.count : 0;
    const count = prior + 1;
    this.failures = {
      operator_id,
      count,
      locked_until_ms:
        count >= MAX_ONLINE_FAILURES ? this.now().getTime() + ONLINE_LOCKOUT_MS : null,
    };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
