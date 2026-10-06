import { ipcRenderer } from 'electron';

import { SHIFT_CASHUP_IPC_CHANNELS } from '../shared/shift-cashup/channels.js';
import type {
  ShiftCashupBridgeAPI,
  ShiftCloseRequest,
  ShiftCloseResponse,
  ShiftManagerPinEnrollRequest,
  ShiftManagerPinEnrollResponse,
  ShiftMovementRequest,
  ShiftMovementResponse,
  ShiftOpenRequest,
  ShiftOpenResponse,
  ShiftStatusResponse,
} from '../shared/shift-cashup/types.js';

/**
 * RT-17 slice 4 part 1 — `shiftCashup.*` preload bridge.
 *
 * Thin wire-up: each member is one `ipcRenderer.invoke` on a typed channel.
 * The main process validates every payload, checks the feature flag and the
 * operator session, and owns the ids, times, attribution and the cash-up.
 * The handlers exist only with `POS_PULSE_FEATURE_SHIFT_CASHUP` on (the
 * renderer reads the flag from `app.config` before offering the flow).
 * Nothing that reveals the expected cash comes back. Part 2: the close may
 * carry a manager PIN, and a manager enrols theirs; a PIN only goes in.
 */
export const shiftCashup: ShiftCashupBridgeAPI = {
  open: (req: ShiftOpenRequest) =>
    ipcRenderer.invoke(SHIFT_CASHUP_IPC_CHANNELS.OPEN, req) as Promise<ShiftOpenResponse>,
  payIn: (req: ShiftMovementRequest) =>
    ipcRenderer.invoke(SHIFT_CASHUP_IPC_CHANNELS.PAY_IN, req) as Promise<ShiftMovementResponse>,
  payOut: (req: ShiftMovementRequest) =>
    ipcRenderer.invoke(SHIFT_CASHUP_IPC_CHANNELS.PAY_OUT, req) as Promise<ShiftMovementResponse>,
  close: (req: ShiftCloseRequest) =>
    ipcRenderer.invoke(SHIFT_CASHUP_IPC_CHANNELS.CLOSE, req) as Promise<ShiftCloseResponse>,
  status: () =>
    ipcRenderer.invoke(SHIFT_CASHUP_IPC_CHANNELS.STATUS) as Promise<ShiftStatusResponse>,
  enrollManagerPin: (req: ShiftManagerPinEnrollRequest) =>
    ipcRenderer.invoke(
      SHIFT_CASHUP_IPC_CHANNELS.ENROLL_MANAGER_PIN,
      req,
    ) as Promise<ShiftManagerPinEnrollResponse>,
};
