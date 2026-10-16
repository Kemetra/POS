import { ipcRenderer } from 'electron';

import {
  SALE_HISTORY_IPC_CHANNELS,
  type SaleHistoryBridgeAPI,
  type SaleHistoryListResponse,
  type SaleHistoryReadResponse,
  type SaleHistoryReprintResponse,
  type SaleHistoryZoneStatusResponse,
} from '../shared/sale-history/types.js';

/**
 * RT-542 — `saleHistory.*` preload bridge. Thin wire-up: main validates every
 * payload, runs the RT-546 role gate, picks the Backend-Core credential and
 * enforces OD-534-1/2; the renderer names no scope, operator or credential.
 */
export const saleHistory: SaleHistoryBridgeAPI = {
  list: (req) =>
    ipcRenderer.invoke(SALE_HISTORY_IPC_CHANNELS.LIST, req) as Promise<SaleHistoryListResponse>,
  read: (req) =>
    ipcRenderer.invoke(SALE_HISTORY_IPC_CHANNELS.READ, req) as Promise<SaleHistoryReadResponse>,
  reprint: (req) =>
    ipcRenderer.invoke(
      SALE_HISTORY_IPC_CHANNELS.REPRINT,
      req,
    ) as Promise<SaleHistoryReprintResponse>,
  // RT-553 — main decides whether the store zone differs from the fixed one.
  zoneStatus: (req) =>
    ipcRenderer.invoke(
      SALE_HISTORY_IPC_CHANNELS.ZONE_STATUS,
      req,
    ) as Promise<SaleHistoryZoneStatusResponse>,
};
