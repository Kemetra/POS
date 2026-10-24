/**
 * The `sales:syncStatus` reader: the repo's counts for the current terminal plus,
 * RT-224, the drain's live paused reason.
 *
 * `paused` is additive. The existing fields keep their meaning (RT-221: `pending`
 * is the current terminal's unsent sales, `heldPreviousPairing` an earlier
 * pairing's). It is 'no_operator_credential' while the drain holds neither an
 * operator envelope nor a device credential (RT-224 step 2), else null. RT-856
 * adds `held`: the pending sales held from sync while discount capture is off,
 * with the closed-set reason `discount_capture_unavailable`. Counts, one
 * timestamp and closed-set codes only — no token, PII or raw error (P7).
 */
import type { SaleSyncPausedReason } from './sale-sync-engine.js';
import type {
  DrainScope,
  SaleSyncStateRepo,
  SaleSyncStatusCounts,
} from './sale-sync-state-repo.js';
import type { SaleSyncHold } from './discount-hold.js';

export interface SaleSyncStatusSnapshot extends SaleSyncStatusCounts {
  /** RT-224: why the drain cannot send right now; null when it can. */
  paused: SaleSyncPausedReason | null;
  /**
   * RT-856: the pending sales the drain holds, with the named reason; null when
   * none is held. A subset of `pending`, which keeps counting them.
   */
  held: SaleSyncHold | null;
}

export interface SaleSyncStatusReaderDeps {
  stateRepo: Pick<SaleSyncStateRepo, 'readSyncStatus' | 'countDiscountHeld'>;
  tenantId: string;
  branchId: string;
  /** RT-221: the current pairing's terminal_id, read live; null when unpaired. */
  resolveTerminalId: () => string | null | Promise<string | null>;
  /** RT-224: the engine's live paused reason (`SaleSyncEngine.pausedReason`). */
  pausedReason: () => SaleSyncPausedReason | null | Promise<SaleSyncPausedReason | null>;
  /** RT-856: the engine's discount-capture switch; off by default (held). */
  discountCaptureSupported?: boolean;
}

export function createSaleSyncStatusReader(
  deps: SaleSyncStatusReaderDeps,
): () => Promise<SaleSyncStatusSnapshot> {
  return async () => {
    const scope = {
      tenantId: deps.tenantId,
      branchId: deps.branchId,
      terminalId: await deps.resolveTerminalId(),
    };
    const counts = deps.stateRepo.readSyncStatus(scope);
    return { ...counts, paused: await deps.pausedReason(), held: heldFor(scope) };
  };

  function heldFor(scope: DrainScope): SaleSyncHold | null {
    if (deps.discountCaptureSupported === true) return null;
    const count = deps.stateRepo.countDiscountHeld(scope);
    return count === 0 ? null : { reason: 'discount_capture_unavailable', count };
  }
}
