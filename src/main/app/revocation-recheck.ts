import type { Logger } from 'pino';

import type { PairingRecheckResult } from '../../shared/pairing-types.js';
import type { DeviceAuthOutcome } from '../pairing/device-auth-detector.js';
import type { DeviceRevocationStore, RevokedTerminalScope } from '../pairing/store.js';

/**
 * RT-215 10897-A (owner approval 10906) — the user-initiated "Check again"
 * on `/pairing` while the terminal is `invalid / device_revoked`.
 *
 * A confirmed revocation can be a false positive (a tenant suspended for a
 * while, a misbehaving load-balancer node). One press makes ONE roster call
 * (`GET /api/pos/v1/cashier-admissions/roster`) with the sealed device token —
 * the single deliberate exception to "a revoked token is never sent", made
 * only on that explicit operator action (never automatic, never on a timer,
 * never at boot):
 *
 *  - 2xx: the store clears the revocation (durably, then in memory), the flow
 *    resets the detector, audits `pairing.device_revoked_cleared`
 *    `{ source: 'recheck' }` and pushes `paired`; then what the revocation
 *    unbound is re-bound as at boot (the offline grant scope, the paired-only
 *    workers when they never started);
 *  - 401: the terminal stays revoked (`still_revoked`);
 *  - anything else: it stays revoked (`unreachable`).
 *
 * The probe runs on an UNOBSERVED client: its answer is never a 2×401
 * detector count, so a 401 here re-runs neither the confirmation flow nor the
 * grant invalidations. Single-flight: concurrent presses share one call.
 *
 * Logs carry the outcome (or the failed step) only — never a token or a URL.
 */

export interface RevocationRecheckDeps {
  /**
   * The roster call (`createRosterConfirmationProbe` over an UNOBSERVED
   * admission client whose token comes from `createRevocationRecheckTokenRead`).
   */
  probe: () => Promise<DeviceAuthOutcome>;
  store: Pick<
    DeviceRevocationStore,
    'isDeviceRevoked' | 'getStoredPairingEpoch' | 'clearDeviceRevoked'
  >;
  /** The revocation is cleared: `DeviceRevocationFlow.onRecheckCleared`. */
  onCleared: (scope: RevokedTerminalScope) => void;
  /** Re-bind the offline grant scope and the paired-only workers, as at boot. */
  rebindPaired: () => Promise<void>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

const CLEARED: PairingRecheckResult = { outcome: 'cleared' };
const STILL_REVOKED: PairingRecheckResult = { outcome: 'still_revoked' };
const UNREACHABLE: PairingRecheckResult = { outcome: 'unreachable' };

export function createRevocationRecheck(
  deps: RevocationRecheckDeps,
): () => Promise<PairingRecheckResult> {
  const { logger } = deps;
  let inFlight: Promise<PairingRecheckResult> | null = null;

  function stepFailed(step: 'clear' | 'flow' | 'rebind'): void {
    // The error itself is not logged: it could carry a path or row data.
    logger.error({ event: 'pairing.device_revoked.recheck.step_failed', step }, 'step failed');
  }

  async function probe(): Promise<DeviceAuthOutcome> {
    try {
      return await deps.probe();
    } catch {
      return 'other';
    }
  }

  /** The revocation that was probed is still the current one (no re-pair landed meanwhile). */
  function sameRevocation(epoch: number | null): boolean {
    return deps.store.isDeviceRevoked() && deps.store.getStoredPairingEpoch() === epoch;
  }

  /** Clear durably; null when nothing was cleared (a failure is logged; still revoked). */
  function clear(): RevokedTerminalScope | null {
    try {
      return deps.store.clearDeviceRevoked();
    } catch {
      stepFailed('clear');
      return null;
    }
  }

  async function recover(scope: RevokedTerminalScope): Promise<void> {
    try {
      deps.onCleared(scope);
    } catch {
      stepFailed('flow');
    }
    try {
      await deps.rebindPaired();
    } catch {
      stepFailed('rebind');
    }
  }

  function settle(result: PairingRecheckResult): PairingRecheckResult {
    const level = result.outcome === 'cleared' ? 'info' : 'warn';
    logger[level](
      { event: 'pairing.device_revoked.recheck', outcome: result.outcome },
      'device revocation rechecked',
    );
    return result;
  }

  async function run(): Promise<PairingRecheckResult> {
    if (!deps.store.isDeviceRevoked()) return settle(UNREACHABLE);
    const epoch = deps.store.getStoredPairingEpoch();
    const outcome = await probe();
    if (outcome === 'unauthorized') return settle(STILL_REVOKED);
    if (outcome !== 'ok' || !sameRevocation(epoch)) return settle(UNREACHABLE);
    const scope = clear();
    if (scope === null) return settle(UNREACHABLE);
    await recover(scope);
    return settle(CLEARED);
  }

  return () => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
