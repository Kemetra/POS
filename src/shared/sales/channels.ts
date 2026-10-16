/**
 * T103 — 008-sale-finalization-and-receipts Slice 1c.2 IPC channels.
 *
 * Single source of truth for the `sales.*` IPC channel constants used by
 * both the preload bridge and the main-process handlers. Mirrors
 * `src/shared/payments/channels.ts` (006 S3).
 *
 * Drift between this file and the handler-side / preload-side channel
 * names surfaces as a "no handler for channel" error in DevTools at
 * runtime — the manual smoke catches it.
 */

export const SALES_IPC_CHANNELS = {
  READ: 'sales:read',
  FIND_BY_NUMBER: 'sales:findByNumber',
  SUBSCRIBE: 'sales:subscribe',
  UNSUBSCRIBE: 'sales:unsubscribe',
  /** RT-541: this device's sales over a range of store business days. */
  LIST: 'sales:list',
} as const;

export type SalesIpcChannel = (typeof SALES_IPC_CHANNELS)[keyof typeof SALES_IPC_CHANNELS];
