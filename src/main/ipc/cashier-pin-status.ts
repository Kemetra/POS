import type { IpcMain } from 'electron';

import { CASHIER_PIN_STATUS_IPC_CHANNELS } from '../../shared/operator/channels.js';
import type { ListCashierPinStatusResponse } from '../../shared/bridge-api.js';

/**
 * RT-424 (RT-251 doc 19 §2) — `operator:list-cashier-pin-status`. Takes no
 * renderer arguments: whatever the renderer sends is ignored, and the scope
 * comes from the pairing main-side. Not on the locked-session allowlist, so
 * the lock guard refuses it while locked. A thrown error never crosses the
 * bridge; it answers `invalid_input` generically.
 */

export interface CashierPinStatusIpcDeps {
  cashierPinStatusHandler: { listCashierPinStatus(): Promise<ListCashierPinStatusResponse> };
}

const REFUSE_INVALID: ListCashierPinStatusResponse = { kind: 'refused', category: 'invalid_input' };

export function registerCashierPinStatusHandler(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: CashierPinStatusIpcDeps,
): void {
  ipcMain.handle(
    CASHIER_PIN_STATUS_IPC_CHANNELS.LIST,
    async (): Promise<ListCashierPinStatusResponse> => {
      try {
        return await deps.cashierPinStatusHandler.listCashierPinStatus();
      } catch {
        return REFUSE_INVALID;
      }
    },
  );
}
