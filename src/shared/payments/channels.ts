/**
 * F-003 — IPC channel constants for the `payments.*` + `tender.*` +
 * `vouchers.*` bridge (006-payments-tender).
 *
 * The preload (`src/preload/payments.ts`) and the main-side registration
 * (`src/main/ipc/payments.ts`) both import these constants. Channel
 * names are kebab-cased namespaces — same posture as
 * `src/shared/cart/channels.ts` (005).
 *
 * Wave 4 adds `vouchers:validate` under §A4-B clearance (2026-05-25).
 * `payments.forceFail` is still gated and intentionally absent.
 *
 * RT-442 (RT-116 S5): the internal `payments.discardOnSessionEnd` is deleted;
 * no session end reverses tender. It never had a channel.
 */

export const PAYMENTS_IPC_CHANNELS = {
  START: 'payments:start',
  CONFIRM: 'payments:confirm',
  CANCEL: 'payments:cancel',
  SUBSCRIBE: 'payments:subscribe',
  READ: 'payments:read',
  /**
   * Wave 5b-renderer — manager / admin-only. The main-process role gate
   * is the load-bearing security check (Constitution §III); the
   * renderer-side OperatorRouteGuard is secondary UX defence only.
   */
  FORCE_FAIL: 'payments:force-fail',
} as const;

export type PaymentsIpcChannel = (typeof PAYMENTS_IPC_CHANNELS)[keyof typeof PAYMENTS_IPC_CHANNELS];

export const TENDER_IPC_CHANNELS = {
  APPLY: 'tender:apply',
  REVERSE: 'tender:reverse',
  READ: 'tender:read',
} as const;

export type TenderIpcChannel = (typeof TENDER_IPC_CHANNELS)[keyof typeof TENDER_IPC_CHANNELS];

export const VOUCHERS_IPC_CHANNELS = {
  VALIDATE: 'vouchers:validate',
} as const;

export type VouchersIpcChannel = (typeof VOUCHERS_IPC_CHANNELS)[keyof typeof VOUCHERS_IPC_CHANNELS];
