import { ipcRenderer } from 'electron';

import { RETURNS_IPC_CHANNELS } from '../shared/returns/channels.js';
import type {
  ReturnsBridgeAPI,
  ReturnsListResponse,
  ReturnsLookupRequest,
  ReturnsLookupResponse,
  ReturnsQuoteRequest,
  ReturnsQuoteResponse,
  ReturnsResolveResponse,
  ReturnsSubmitRequest,
  ReturnsSubmitResponse,
} from '../shared/returns/types.js';

/**
 * RT-15 S2 — `returns.*` preload bridge.
 *
 * Thin wire-up: each member is one `ipcRenderer.invoke` on a typed channel.
 * The main process validates every payload, checks the feature gate, the
 * session and the manager/admin role, and owns the saleRef, the money, the
 * journal and the Idempotency-Key. Nothing secret comes back.
 */
export const returns: ReturnsBridgeAPI = {
  lookup: (req: ReturnsLookupRequest) =>
    ipcRenderer.invoke(RETURNS_IPC_CHANNELS.LOOKUP, req) as Promise<ReturnsLookupResponse>,
  quote: (req: ReturnsQuoteRequest) =>
    ipcRenderer.invoke(RETURNS_IPC_CHANNELS.QUOTE, req) as Promise<ReturnsQuoteResponse>,
  submit: (req: ReturnsSubmitRequest) =>
    ipcRenderer.invoke(RETURNS_IPC_CHANNELS.SUBMIT, req) as Promise<ReturnsSubmitResponse>,
  resolve: () =>
    ipcRenderer.invoke(RETURNS_IPC_CHANNELS.RESOLVE) as Promise<ReturnsResolveResponse>,
  list: () => ipcRenderer.invoke(RETURNS_IPC_CHANNELS.LIST) as Promise<ReturnsListResponse>,
};
