/**
 * RT-15 S2 — `returns:*` IPC channel constants.
 *
 * Single source of truth for the preload bridge and the main-process handlers.
 * None of these channels is on the locked-session allowlist
 * (`src/main/ipc/session-lock-guard.ts`), so every one is refused while the
 * operator session is locked (default deny).
 */

export const RETURNS_IPC_CHANNELS = {
  LOOKUP: 'returns:lookup',
  QUOTE: 'returns:quote',
  SUBMIT: 'returns:submit',
  RESOLVE: 'returns:resolve',
  LIST: 'returns:list',
  // RT-15 S4
  PAYOUT: 'returns:payout',
  REPRINT_SLIP: 'returns:reprintSlip',
} as const;

export type ReturnsIpcChannel = (typeof RETURNS_IPC_CHANNELS)[keyof typeof RETURNS_IPC_CHANNELS];
