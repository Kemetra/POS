/**
 * RT-601 (VN-S6 S6-1a, doc 24 §2.3, §3.1 `sync`) — the sync axis of the
 * terminal status signal: a read of the sale queue (sales only, D-6-4).
 *
 * It combines `readSyncStatus`, the oldest pending sale's outbox enqueue time
 * and the drain's live paused reason. It is a read: no sync-engine behaviour
 * changes, and the existing `sales:syncStatus` reader is untouched (A4-9).
 *
 * Counts, ISO timestamps and one closed-set code only — no sale, terminal,
 * tenant or cashier id (P7 / A4-3). `payloadDivergence` stays out: the dead-
 * letter count already includes it.
 */
import type { SaleSyncPausedReason } from '../sales-sync/sale-sync-engine.js';
import type { SaleSyncStateRepo } from '../sales-sync/sale-sync-state-repo.js';

export interface TerminalSyncAggregate {
  /** This terminal's unsent sales. */
  readonly pending: number;
  /** Unsent sales queued under an earlier pairing (RT-221; held, never sent). */
  readonly heldPreviousPairing: number;
  /** Every dead-lettered sale, payload divergences included. */
  readonly deadLetter: number;
  /** Outbox enqueue time of the oldest pending sale (ISO), or null. */
  readonly oldestPendingAt: string | null;
  /** Why the drain cannot send right now (RT-224), or null. */
  readonly paused: SaleSyncPausedReason | null;
  /** Last successful send (ISO), or null. */
  readonly lastSuccessAt: string | null;
}

export interface TerminalSyncAggregateReaderDeps {
  stateRepo: Pick<SaleSyncStateRepo, 'readSyncStatus' | 'readOldestPendingAt'>;
  tenantId: string;
  branchId: string;
  /** The current pairing's terminal_id, read live; null when unpaired. */
  resolveTerminalId: () => string | null | Promise<string | null>;
  /** The engine's live paused reason (`SaleSyncEngine.pausedReason`). */
  pausedReason: () => SaleSyncPausedReason | null | Promise<SaleSyncPausedReason | null>;
}

export function createTerminalSyncAggregateReader(
  deps: TerminalSyncAggregateReaderDeps,
): () => Promise<TerminalSyncAggregate> {
  return async () => {
    const scope = {
      tenantId: deps.tenantId,
      branchId: deps.branchId,
      terminalId: await deps.resolveTerminalId(),
    };
    const counts = deps.stateRepo.readSyncStatus(scope);
    return {
      pending: counts.pending,
      heldPreviousPairing: counts.heldPreviousPairing,
      deadLetter: counts.deadLetter,
      oldestPendingAt: deps.stateRepo.readOldestPendingAt(scope),
      paused: await deps.pausedReason(),
      lastSuccessAt: counts.lastSuccessAt,
    };
  };
}
