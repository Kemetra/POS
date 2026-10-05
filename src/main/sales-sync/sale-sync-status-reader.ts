/**
 * The `sales:syncStatus` reader: the repo's counts for the current terminal plus,
 * RT-224, the drain's live paused reason.
 *
 * `paused` is additive. The existing fields keep their meaning (RT-221: `pending`
 * is the current terminal's unsent sales, `heldPreviousPairing` an earlier
 * pairing's). It is 'no_operator_credential' while the current session holds no
 * sale credential, else null. Counts, one timestamp and one closed-set code only —
 * no token, PII or raw error (P7).
 */
import type { SaleSyncPausedReason } from './sale-sync-engine.js';
import type { SaleSyncStateRepo, SaleSyncStatusCounts } from './sale-sync-state-repo.js';

export interface SaleSyncStatusSnapshot extends SaleSyncStatusCounts {
  /** RT-224: why the drain cannot send right now; null when it can. */
  paused: SaleSyncPausedReason | null;
}

export interface SaleSyncStatusReaderDeps {
  stateRepo: Pick<SaleSyncStateRepo, 'readSyncStatus'>;
  tenantId: string;
  branchId: string;
  /** RT-221: the current pairing's terminal_id, read live; null when unpaired. */
  resolveTerminalId: () => string | null | Promise<string | null>;
  /** RT-224: the engine's live paused reason (`SaleSyncEngine.pausedReason`). */
  pausedReason: () => SaleSyncPausedReason | null;
}

export function createSaleSyncStatusReader(
  deps: SaleSyncStatusReaderDeps,
): () => Promise<SaleSyncStatusSnapshot> {
  return async () => {
    const counts = deps.stateRepo.readSyncStatus({
      tenantId: deps.tenantId,
      branchId: deps.branchId,
      terminalId: await deps.resolveTerminalId(),
    });
    return { ...counts, paused: deps.pausedReason() };
  };
}
