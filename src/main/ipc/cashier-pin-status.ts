import type { IpcMain } from 'electron';

import { OPERATOR_IPC_CHANNELS } from '../../shared/operator/channels.js';
import type { ListCashierPinStatusResponse } from '../../shared/bridge-api.js';

/**
 * RT-424 (D-M1, doc 19 §2) — `operator:list-cashier-pin-status`. Its own
 * registrar, like `reauth.ts`. The renderer passes nothing: scope and role come
 * from main, so any argument is ignored. Not on the locked-session allowlist,
 * so the lock guard refuses it while locked. A thrown error never crosses the
 * bridge; the answer is the handler's fixed-enum response only.
 */

export interface CashierPinStatusIpcDeps {
  cashierPinStatusHandler: { listCashierPinStatus(): Promise<ListCashierPinStatusResponse> };
}

export function registerCashierPinStatusHandler(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: CashierPinStatusIpcDeps,
): void {
  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.LIST_CASHIER_PIN_STATUS,
    async (): Promise<ListCashierPinStatusResponse> => {
      try {
        return await deps.cashierPinStatusHandler.listCashierPinStatus();
      } catch {
        return { kind: 'refused', category: 'invalid_input' };
      }
    },
  );
}
