/**
 * RT-17 slice 4 — `shiftCashup:*` IPC channel constants.
 *
 * The single source of truth for the preload bridge and the main-process
 * handlers. The handlers are registered only with
 * `POS_PULSE_FEATURE_SHIFT_CASHUP` on (default off). None of these channels is
 * on the locked-session allowlist (`src/main/ipc/session-lock-guard.ts`), so
 * every one is refused while the operator session is locked (default deny).
 */

export const SHIFT_CASHUP_IPC_CHANNELS = {
  OPEN: 'shiftCashup:open',
  PAY_IN: 'shiftCashup:payIn',
  PAY_OUT: 'shiftCashup:payOut',
  CLOSE: 'shiftCashup:close',
  STATUS: 'shiftCashup:status',
  // RT-17 slice 4 part 2: a signed-in manager sets their local PIN.
  ENROLL_MANAGER_PIN: 'shiftCashup:enrollManagerPin',
} as const;

export type ShiftCashupIpcChannel =
  (typeof SHIFT_CASHUP_IPC_CHANNELS)[keyof typeof SHIFT_CASHUP_IPC_CHANNELS];
