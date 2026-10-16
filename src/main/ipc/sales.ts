/**
 * T094c — 008-sale-finalization-and-receipts Slice 1c.3 IPC channel
 * registration for the read-only `sales.*` namespace.
 *
 * Mirrors `src/main/ipc/payments.ts`. A thin wire-up: each
 * SALES_IPC_CHANNELS entry delegates to the matching `sales.*` bridge
 * handler. There is no business logic here — session gating, tenant
 * isolation, forbidden-field scanning, and not-found handling all live in
 * `createSalesBridge` (sales-bridge.ts) and are tested there.
 *
 * Shape validation is deliberately minimal. Unlike 006's payments surface
 * (which carries an `invalid_input` refusal vocabulary), the `sales.*`
 * refusal enum has no generic-invalid value — and the bridge handlers
 * already degrade gracefully on a malformed payload (forbidden-field guard
 * + null-tolerant repo reads collapse to `sale_not_found`). So the IPC
 * layer only guards against a non-object payload (which cannot carry the
 * required id/number field) and maps it to the same terminal refusal the
 * bridge would produce, without invoking the handler.
 *
 * RT-541 `sales.list` takes a range, so its vocabulary has `invalid_request`:
 * anything but a plain object refuses with it here, and the bridge validates
 * every field (`sales-list.ts`).
 */

import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { SALES_IPC_CHANNELS } from '../../shared/sales/channels.js';
import type { SalesBridge } from '../sales/sales-bridge.js';
import type {
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
} from '../../shared/bridge-api.js';

export interface SalesIpcDeps {
  salesBridge: SalesBridge;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return isObject(v) && !Array.isArray(v);
}

export function registerSalesHandlers(ipcMain: IpcMain, deps: SalesIpcDeps): void {
  const { salesBridge } = deps;

  ipcMain.handle(
    SALES_IPC_CHANNELS.READ,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<SalesReadResponse> => {
      if (!isObject(request)) return { kind: 'refused', reason: 'sale_not_found' };
      return salesBridge.read(request as unknown as SalesReadRequest);
    },
  );

  ipcMain.handle(
    SALES_IPC_CHANNELS.FIND_BY_NUMBER,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<SalesFindByNumberResponse> => {
      if (!isObject(request)) return { kind: 'refused', reason: 'sale_not_found' };
      return salesBridge.findByNumber(request as unknown as SalesFindByNumberRequest);
    },
  );

  ipcMain.handle(
    SALES_IPC_CHANNELS.SUBSCRIBE,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<SalesSubscribeResponse> => {
      // subscribe is a stub returning not_implemented; a malformed request
      // maps to the same terminal refusal without invoking the handler.
      if (!isObject(request)) return { kind: 'refused', reason: 'not_implemented' };
      return salesBridge.subscribe(request as unknown as SalesSubscribeRequest);
    },
  );

  ipcMain.handle(
    SALES_IPC_CHANNELS.UNSUBSCRIBE,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<SalesUnsubscribeResponse> => {
      // unsubscribe is an idempotent no-op stub; a malformed request is the
      // same no-op ok the bridge would return.
      if (!isObject(request)) return { kind: 'ok' };
      return salesBridge.unsubscribe(request as unknown as SalesUnsubscribeRequest);
    },
  );

  ipcMain.handle(
    SALES_IPC_CHANNELS.LIST,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<SalesListResponse> => {
      if (!isPlainObject(request)) return { kind: 'refused', reason: 'invalid_request' };
      return salesBridge.list(request as unknown as SalesListRequest);
    },
  );
}
