/**
 * 011-sale-sync-capture-up T051 — `sales:syncStatus` IPC registration (§A4).
 *
 * The sale-sync renderer surface is a SINGLE read-only channel: the renderer can
 * observe sync health (pending / held / dead-letter counts + last-success timestamp) but
 * can NEVER trigger or mutate the drain (no write/trigger handler is exposed —
 * P8 / WR-1). The request body is ignored (`{}`, INP-1); scope comes from the
 * resolved device principal, supplied by the injected `readStatus` reader, never
 * from the renderer.
 *
 * The handler returns ONLY counts + one timestamp — no operator token, PII, card
 * data, or raw error body crosses the bridge (P7).
 */
import type { IpcMain } from 'electron';

import { SALES_SYNC_IPC_CHANNELS } from '../../shared/sales-sync/channels.js';
import type { SaleSyncStatusCounts } from '../sales-sync/sale-sync-state-repo.js';

export interface SalesSyncHandlerDeps {
  /**
   * Reads the tenant-scoped status counts for the resolved device principal.
   * RT-221: may be async — `pending` / `heldPreviousPairing` depend on the live
   * pairing's `terminal_id`.
   */
  readStatus: () => SaleSyncStatusCounts | Promise<SaleSyncStatusCounts>;
}

export function registerSalesSyncHandlers(ipcMain: IpcMain, deps: SalesSyncHandlerDeps): void {
  ipcMain.handle(SALES_SYNC_IPC_CHANNELS.SYNC_STATUS, (): Promise<SaleSyncStatusCounts> => {
    // No write path; the request payload + event are intentionally ignored.
    return Promise.resolve(deps.readStatus());
  });
}
