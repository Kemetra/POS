import { ipcRenderer } from 'electron';

import type {
  SalesBridgeAPI,
  SalesReadRequest,
  SalesReadResponse,
  SalesFindByNumberRequest,
  SalesFindByNumberResponse,
  SalesSubscribeRequest,
  SalesSubscribeResponse,
  SalesUnsubscribeRequest,
  SalesUnsubscribeResponse,
  SalesListRequest,
  SalesListResponse,
} from '../shared/bridge-api.js';
import { SALES_IPC_CHANNELS } from '../shared/sales/channels.js';

/**
 * T103 — 008-sale-finalization-and-receipts Slice 1c.2 preload bridge.
 *
 * Thin contextBridge surface — every handler delegates to
 * `ipcRenderer.invoke` with a typed channel constant. Main-process
 * `requireOperatorSession` + tenant-isolation gating is the load-bearing
 * security boundary; renderer-side type checks are secondary UX defence
 * only.
 *
 * Security (Constitution §VII / contracts/bridge-api.md §A4 cleared 2026-05-26):
 *   • The `sales.*` namespace is READ-ONLY. No idempotency_key on any
 *     handler.
 *   • `sales.subscribe` + `sales.unsubscribe` are stubs in S1c.2 —
 *     subscribe returns `refused: 'not_implemented'`, unsubscribe returns
 *     `kind: 'ok'` (no-op). The push-subscription primitive
 *     (webContents.send + token registry) lands in a follow-up task.
 *   • Main-only fields (envelope_handoff_action_id, payment_attempt_id,
 *     envelope_cart_id, tenant_tax_registration_id) are stripped at the
 *     bridge handler (§A4 #8 — no raw envelope leak); the renderer
 *     never sees them.
 */
export const sales: SalesBridgeAPI = {
  read: (req: SalesReadRequest) =>
    ipcRenderer.invoke(SALES_IPC_CHANNELS.READ, req) as Promise<SalesReadResponse>,
  findByNumber: (req: SalesFindByNumberRequest) =>
    ipcRenderer.invoke(
      SALES_IPC_CHANNELS.FIND_BY_NUMBER,
      req,
    ) as Promise<SalesFindByNumberResponse>,
  subscribe: (req: SalesSubscribeRequest) =>
    ipcRenderer.invoke(SALES_IPC_CHANNELS.SUBSCRIBE, req) as Promise<SalesSubscribeResponse>,
  unsubscribe: (req: SalesUnsubscribeRequest) =>
    ipcRenderer.invoke(SALES_IPC_CHANNELS.UNSUBSCRIBE, req) as Promise<SalesUnsubscribeResponse>,
  // RT-541: read-only; main validates the range and applies the role gate.
  list: (req: SalesListRequest) =>
    ipcRenderer.invoke(SALES_IPC_CHANNELS.LIST, req) as Promise<SalesListResponse>,
};
