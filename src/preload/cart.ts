import { ipcRenderer } from 'electron';

import type { CartBridgeAPI } from '../shared/bridge-api.js';
import { CART_IPC_CHANNELS } from '../shared/cart/channels.js';
import type {
  CartCreateRequest,
  CartLinesAddRequest,
  CartLinesUpdateRequest,
  CartLinesRemoveRequest,
  CartLinesSetNoteRequest,
  CartDiscountPlaceholdersAddRequest,
  CartDiscountPlaceholdersRemoveRequest,
  CartVoidRequest,
  CartCancelPostHandoffRequest,
  CartHandoffRequest,
  CartSubscribeRequest,
  CartSnapshotRequest,
} from '../shared/cart/bridge-types.js';

/**
 * 005-sales-cart Phase 2 — preload cart stub.
 *
 * All handlers delegate to ipcRenderer.invoke with typed channel constants.
 * Main-process handlers return refused/not_implemented until S1 wires the
 * real logic. The renderer-side type-checks are enforced by the CartBridgeAPI
 * interface; main-process role-gating is the load-bearing security boundary.
 *
 * Security: no Clerk JWT, device_token, PINs, PIN hashes, or secrets
 * cross this bridge in either direction. Sensitive cart payload fields
 * are not logged here.
 */
export const cart: CartBridgeAPI = {
  create: (req: CartCreateRequest) => ipcRenderer.invoke(CART_IPC_CHANNELS.CREATE, req),

  lines: {
    add: (req: CartLinesAddRequest) => ipcRenderer.invoke(CART_IPC_CHANNELS.LINES_ADD, req),
    update: (req: CartLinesUpdateRequest) =>
      ipcRenderer.invoke(CART_IPC_CHANNELS.LINES_UPDATE, req),
    remove: (req: CartLinesRemoveRequest) =>
      ipcRenderer.invoke(CART_IPC_CHANNELS.LINES_REMOVE, req),
    setNote: (req: CartLinesSetNoteRequest) =>
      ipcRenderer.invoke(CART_IPC_CHANNELS.LINES_SET_NOTE, req),
  },

  discountPlaceholders: {
    add: (req: CartDiscountPlaceholdersAddRequest) =>
      ipcRenderer.invoke(CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_ADD, req),
    remove: (req: CartDiscountPlaceholdersRemoveRequest) =>
      ipcRenderer.invoke(CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_REMOVE, req),
  },

  void: (req: CartVoidRequest) => ipcRenderer.invoke(CART_IPC_CHANNELS.VOID, req),

  cancelPostHandoff: (req: CartCancelPostHandoffRequest) =>
    ipcRenderer.invoke(CART_IPC_CHANNELS.CANCEL_POST_HANDOFF, req),

  handoff: (req: CartHandoffRequest) => ipcRenderer.invoke(CART_IPC_CHANNELS.HANDOFF, req),

  subscribe: (req: CartSubscribeRequest) => ipcRenderer.invoke(CART_IPC_CHANNELS.SUBSCRIBE, req),

  snapshot: (req: CartSnapshotRequest) => ipcRenderer.invoke(CART_IPC_CHANNELS.SNAPSHOT, req),
};
