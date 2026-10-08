/**
 * RT-221 — the sale-sync engine's current-terminal resolver.
 *
 * The outbox drain is scoped to the CURRENT pairing's `terminal_id` (RT-138 L6:
 * never an automatic replay under a new device identity). The value comes from
 * the pairing status — the same source the engine's tenant/branch come from —
 * and is read on every call, so a re-pair is seen without a restart.
 *
 * Only a `paired` status yields a `terminal_id`. Unpaired, invalid (orphaned
 * row, missing token, decrypt failure) and a status read that fails all yield
 * null: nothing is eligible to sync (fail closed).
 */
import type { PairingStatus } from '../../shared/pairing-types.js';

export type CurrentTerminalResolver = () => Promise<string | null>;

export function createCurrentTerminalResolver(
  getStatus: () => Promise<PairingStatus>,
): CurrentTerminalResolver {
  return async () => {
    try {
      const status = await getStatus();
      return status.kind === 'paired' ? status.terminal_id : null;
    } catch {
      return null;
    }
  };
}
