import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { CART_IPC_CHANNELS } from '../../shared/cart/channels.js';
import type {
  CartCreateRequest,
  CartCreateResponse,
  CartDiscountPlaceholdersAddRequest,
  CartDiscountPlaceholdersAddResponse,
  CartDiscountPlaceholdersRemoveRequest,
  CartDiscountPlaceholdersRemoveResponse,
  CartHandoffRequest,
  CartHandoffResponse,
  CartLinesAddRequest,
  CartLinesAddResponse,
  CartLinesRemoveRequest,
  CartLinesRemoveResponse,
  CartLinesSetNoteRequest,
  CartLinesSetNoteResponse,
  CartLinesUpdateRequest,
  CartLinesUpdateResponse,
  CartSnapshotRequest,
  CartSnapshotResponse,
  CartSubscribeRequest,
  CartSubscribeResponse,
  CartVoidRequest,
  CartVoidResponse,
} from '../../shared/cart/bridge-types.js';
import type { CartRefusal } from '../../shared/cart/refusal.js';
import type { CartBridgeHandlers } from '../cart/cart-bridge.js';

/**
 * 005-sales-cart S1 / T029 — `cart:*` IPC channel registration.
 *
 * Mirrors the operator IPC pattern. Every handler runs through
 * `CartBridgeHandlers`, which is responsible for the role gate
 * (`requireOperatorSession` is the FIRST instruction of every handler).
 * This file is the thin wire-up; no business logic lives here.
 *
 * Input shape validation refuses generically: malformed payloads
 * collapse to `{ kind: 'refused', reason: 'no_session' }` — we do NOT
 * leak the field that failed validation (Constitution VII / PR-2).
 */

export interface CartHandlerDeps {
  handlers: CartBridgeHandlers;
}

function refuseInvalid(): CartRefusal {
  return { kind: 'refused', reason: 'no_session' };
}

function asCreateReq(value: unknown): CartCreateRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['idempotency_key'] !== 'string') return null;
  return { idempotency_key: v['idempotency_key'] };
}

function asLinesAddReq(value: unknown): CartLinesAddRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['cart_id'] !== 'string' ||
    typeof v['item_ref'] !== 'string' ||
    typeof v['quantity'] !== 'number' ||
    typeof v['idempotency_key'] !== 'string'
  ) {
    return null;
  }
  return {
    cart_id: v['cart_id'],
    item_ref: v['item_ref'],
    quantity: v['quantity'],
    idempotency_key: v['idempotency_key'],
  };
}

function asLinesUpdateReq(value: unknown): CartLinesUpdateRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['cart_id'] !== 'string' ||
    typeof v['line_id'] !== 'string' ||
    (v['op'] !== 'increment' && v['op'] !== 'decrement' && v['op'] !== 'set') ||
    typeof v['version'] !== 'number' ||
    typeof v['idempotency_key'] !== 'string'
  ) {
    return null;
  }
  const req: CartLinesUpdateRequest = {
    cart_id: v['cart_id'],
    line_id: v['line_id'],
    op: v['op'],
    version: v['version'],
    idempotency_key: v['idempotency_key'],
  };
  if (typeof v['delta'] === 'number') (req as { delta?: number }).delta = v['delta'];
  if (typeof v['absolute'] === 'number') (req as { absolute?: number }).absolute = v['absolute'];
  return req;
}

function asLinesRemoveReq(value: unknown): CartLinesRemoveRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['cart_id'] !== 'string' ||
    typeof v['line_id'] !== 'string' ||
    typeof v['version'] !== 'number' ||
    typeof v['idempotency_key'] !== 'string'
  ) {
    return null;
  }
  return {
    cart_id: v['cart_id'],
    line_id: v['line_id'],
    version: v['version'],
    idempotency_key: v['idempotency_key'],
  };
}

function asLinesSetNoteReq(value: unknown): CartLinesSetNoteRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['cart_id'] !== 'string' ||
    typeof v['line_id'] !== 'string' ||
    (typeof v['note'] !== 'string' && v['note'] !== null) ||
    typeof v['version'] !== 'number' ||
    typeof v['idempotency_key'] !== 'string'
  ) {
    return null;
  }
  return {
    cart_id: v['cart_id'],
    line_id: v['line_id'],
    note: v['note'],
    version: v['version'],
    idempotency_key: v['idempotency_key'],
  };
}

function asDiscountAddReq(value: unknown): CartDiscountPlaceholdersAddRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['cart_id'] !== 'string' ||
    typeof v['line_id'] !== 'string' ||
    typeof v['placeholder_kind'] !== 'string' ||
    typeof v['idempotency_key'] !== 'string'
  ) {
    return null;
  }
  const req: CartDiscountPlaceholdersAddRequest = {
    cart_id: v['cart_id'],
    line_id: v['line_id'],
    placeholder_kind: v['placeholder_kind'],
    idempotency_key: v['idempotency_key'],
  };
  if (typeof v['attribution_operator_id'] === 'string') {
    (req as { attribution_operator_id?: string }).attribution_operator_id =
      v['attribution_operator_id'];
  }
  return req;
}

function asDiscountRemoveReq(value: unknown): CartDiscountPlaceholdersRemoveRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['cart_id'] !== 'string' ||
    typeof v['placeholder_id'] !== 'string' ||
    typeof v['idempotency_key'] !== 'string'
  ) {
    return null;
  }
  const req: CartDiscountPlaceholdersRemoveRequest = {
    cart_id: v['cart_id'],
    placeholder_id: v['placeholder_id'],
    idempotency_key: v['idempotency_key'],
  };
  if (typeof v['attribution_operator_id'] === 'string') {
    (req as { attribution_operator_id?: string }).attribution_operator_id =
      v['attribution_operator_id'];
  }
  return req;
}

function asVoidReq(value: unknown): CartVoidRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['cart_id'] !== 'string' || typeof v['idempotency_key'] !== 'string') return null;
  const req: CartVoidRequest = {
    cart_id: v['cart_id'],
    idempotency_key: v['idempotency_key'],
  };
  if (typeof v['attribution_operator_id'] === 'string') {
    (req as { attribution_operator_id?: string }).attribution_operator_id =
      v['attribution_operator_id'];
  }
  return req;
}

function asHandoffReq(value: unknown): CartHandoffRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['cart_id'] !== 'string' ||
    !Array.isArray(v['per_line_versions']) ||
    typeof v['idempotency_key'] !== 'string'
  ) {
    return null;
  }
  const versions: { line_id: string; version: number }[] = [];
  for (const entry of v['per_line_versions']) {
    if (typeof entry !== 'object' || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e['line_id'] !== 'string' || typeof e['version'] !== 'number') return null;
    versions.push({ line_id: e['line_id'], version: e['version'] });
  }
  return {
    cart_id: v['cart_id'],
    per_line_versions: versions,
    idempotency_key: v['idempotency_key'],
  };
}

function asSubscribeReq(value: unknown): CartSubscribeRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['cart_id'] !== 'string') return null;
  return { cart_id: v['cart_id'] };
}

/**
 * V5 active cart read. Builds a FRESH object holding only `cart_id`, so any
 * renderer-supplied identity (tenant/branch/operator/session) is dropped here
 * and scope comes solely from the trusted main-process session.
 */
function asSnapshotReq(value: unknown): CartSnapshotRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['cart_id'] !== 'string' || v['cart_id'] === '') return null;
  return { cart_id: v['cart_id'] };
}

export function registerCartHandlers(ipcMain: IpcMain, deps: CartHandlerDeps): void {
  const { handlers } = deps;

  ipcMain.handle(
    CART_IPC_CHANNELS.CREATE,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CartCreateResponse> => {
      const req = asCreateReq(request);
      if (req === null) return refuseInvalid();
      return handlers.create(req);
    },
  );

  ipcMain.handle(
    CART_IPC_CHANNELS.LINES_ADD,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CartLinesAddResponse> => {
      const req = asLinesAddReq(request);
      if (req === null) return refuseInvalid();
      return handlers.linesAdd(req);
    },
  );

  ipcMain.handle(
    CART_IPC_CHANNELS.LINES_UPDATE,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CartLinesUpdateResponse> => {
      const req = asLinesUpdateReq(request);
      if (req === null) return refuseInvalid();
      return handlers.linesUpdate(req);
    },
  );

  ipcMain.handle(
    CART_IPC_CHANNELS.LINES_REMOVE,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CartLinesRemoveResponse> => {
      const req = asLinesRemoveReq(request);
      if (req === null) return refuseInvalid();
      return handlers.linesRemove(req);
    },
  );

  ipcMain.handle(
    CART_IPC_CHANNELS.LINES_SET_NOTE,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CartLinesSetNoteResponse> => {
      const req = asLinesSetNoteReq(request);
      if (req === null) return refuseInvalid();
      return handlers.linesSetNote(req);
    },
  );

  ipcMain.handle(
    CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_ADD,
    async (
      _event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<CartDiscountPlaceholdersAddResponse> => {
      const req = asDiscountAddReq(request);
      if (req === null) return refuseInvalid();
      return handlers.discountPlaceholdersAdd(req);
    },
  );

  ipcMain.handle(
    CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_REMOVE,
    async (
      _event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<CartDiscountPlaceholdersRemoveResponse> => {
      const req = asDiscountRemoveReq(request);
      if (req === null) return refuseInvalid();
      return handlers.discountPlaceholdersRemove(req);
    },
  );

  ipcMain.handle(
    CART_IPC_CHANNELS.VOID,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CartVoidResponse> => {
      const req = asVoidReq(request);
      if (req === null) return refuseInvalid();
      return handlers.void(req);
    },
  );

  ipcMain.handle(
    CART_IPC_CHANNELS.HANDOFF,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CartHandoffResponse> => {
      const req = asHandoffReq(request);
      if (req === null) return refuseInvalid();
      return handlers.handoff(req);
    },
  );

  ipcMain.handle(
    CART_IPC_CHANNELS.SUBSCRIBE,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CartSubscribeResponse> => {
      const req = asSubscribeReq(request);
      if (req === null) return refuseInvalid();
      return handlers.subscribe(req);
    },
  );

  ipcMain.handle(
    CART_IPC_CHANNELS.SNAPSHOT,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CartSnapshotResponse> => {
      const req = asSnapshotReq(request);
      if (req === null) return refuseInvalid();
      return handlers.snapshot(req);
    },
  );
}
