/**
 * RT-17 slice 4 part 1 — `shiftCashup:*` IPC registration (§A4 bridge
 * security).
 *
 * `registerShiftCashupIpc` is the flag gate: with
 * `POS_PULSE_FEATURE_SHIFT_CASHUP` off (default) it registers nothing. With
 * it on, it composes the service and its bridge and registers the five
 * handlers on the lock-guarded `ipcMain`. None of the channels is on the
 * locked-session allowlist, so each is refused while the session is locked;
 * the service re-reads the flag and checks the session on every call.
 *
 * The renderer is untrusted input. Each request is validated here before the
 * bridge runs, and anything outside the closed shape is `invalid_input`:
 *
 *   • `open`: exactly `{ openingFloatMinor }`, a safe integer ≥ 0;
 *   • `payIn` / `payOut`: exactly `{ amountMinor, reasonCode, note? }` — a
 *     safe integer ≥ 1, a reason in the contract's closed set, and an
 *     optional note of 1–200 characters with no control character (an
 *     undefined note is no note);
 *   • `close`: exactly `{ countedCashMinor }`, a safe integer ≥ 0 — no
 *     approver, close kind or anything else (zero-variance close only until
 *     the owner decision in RT-17 comment 10942);
 *   • `status`: no payload (undefined or `{}`).
 *
 * No operator, user id, scope, currency, id, time or key can be smuggled in:
 * main derives them all.
 */
import type { IpcMain } from 'electron';

import { SHIFT_CASHUP_IPC_CHANNELS } from '../../shared/shift-cashup/channels.js';
import {
  SHIFT_MOVEMENT_REASON_CODES,
  SHIFT_NOTE_MAX_LENGTH,
  type ShiftCashupBridgeAPI,
  type ShiftCloseRequest,
  type ShiftMovementReasonCode,
  type ShiftMovementRequest,
  type ShiftOpenRequest,
} from '../../shared/shift-cashup/types.js';
import {
  composeShiftCashupService,
  type ComposeShiftCashupServiceDeps,
} from '../shift-cashup/compose-shift-cashup.js';
import {
  createShiftCashupBridge,
  type ShiftCashupBridgeLogger,
} from '../shift-cashup/shift-cashup-bridge.js';

const INVALID = { kind: 'refused', reason: 'invalid_input' } as const;
const PRINTABLE = /^[^\p{Cc}]+$/u;

const OPEN_KEYS = ['openingFloatMinor'] as const;
const MOVEMENT_KEYS = ['amountMinor', 'reasonCode', 'note'] as const;
const CLOSE_KEYS = ['countedCashMinor'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  return !Array.isArray(value);
}

/** A plain object whose keys are all in `keys` (closed shape: nothing smuggled in). */
function isClosedShape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((k) => keys.includes(k));
}

/** A safe integer of minor units, at least `min`. */
function isMinorFrom(value: unknown, min: 0 | 1): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min;
}

function isReasonCode(value: unknown): value is ShiftMovementReasonCode {
  return (SHIFT_MOVEMENT_REASON_CODES as readonly unknown[]).includes(value);
}

function isNote(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return value.length <= SHIFT_NOTE_MAX_LENGTH && PRINTABLE.test(value);
}

/** `{ note }` when a valid note was given, `{}` when none, null when invalid. */
function readNote(value: unknown): { note?: string } | null {
  if (value === undefined) return {};
  return isNote(value) ? { note: value } : null;
}

/** `{ openingFloatMinor }` exactly, or null. */
export function readOpenRequest(value: unknown): ShiftOpenRequest | null {
  if (!isClosedShape(value, OPEN_KEYS)) return null;
  const { openingFloatMinor } = value;
  return isMinorFrom(openingFloatMinor, 0) ? { openingFloatMinor } : null;
}

/** `{ amountMinor, reasonCode, note? }` exactly, or null. */
export function readMovementRequest(value: unknown): ShiftMovementRequest | null {
  if (!isClosedShape(value, MOVEMENT_KEYS)) return null;
  const { amountMinor, reasonCode } = value;
  const note = readNote(value['note']);
  if (note === null || !isMinorFrom(amountMinor, 1) || !isReasonCode(reasonCode)) return null;
  return { amountMinor, reasonCode, ...note };
}

/** `{ countedCashMinor }` exactly, or null. */
export function readCloseRequest(value: unknown): ShiftCloseRequest | null {
  if (!isClosedShape(value, CLOSE_KEYS)) return null;
  const { countedCashMinor } = value;
  return isMinorFrom(countedCashMinor, 0) ? { countedCashMinor } : null;
}

/** `status` accepts no payload (undefined or `{}`). */
function isEmptyPayload(value: unknown): boolean {
  return value === undefined || isClosedShape(value, []);
}

/** Validates the request with `read`, then hands it to `run`. */
function validated<R>(read: (value: unknown) => R | null, run: (req: R) => Promise<unknown>) {
  return (_event: unknown, request: unknown): Promise<unknown> | typeof INVALID => {
    const req = read(request);
    return req === null ? INVALID : run(req);
  };
}

export interface ShiftCashupIpcDeps {
  readonly bridge: ShiftCashupBridgeAPI;
}

export function registerShiftCashupHandlers(ipcMain: IpcMain, deps: ShiftCashupIpcDeps): void {
  const { bridge } = deps;
  const { OPEN, PAY_IN, PAY_OUT, CLOSE, STATUS } = SHIFT_CASHUP_IPC_CHANNELS;
  ipcMain.handle(
    OPEN,
    validated(readOpenRequest, (req) => bridge.open(req)),
  );
  ipcMain.handle(
    PAY_IN,
    validated(readMovementRequest, (req) => bridge.payIn(req)),
  );
  ipcMain.handle(
    PAY_OUT,
    validated(readMovementRequest, (req) => bridge.payOut(req)),
  );
  ipcMain.handle(
    CLOSE,
    validated(readCloseRequest, (req) => bridge.close(req)),
  );
  ipcMain.handle(STATUS, (_event, request: unknown) =>
    isEmptyPayload(request) ? bridge.status() : INVALID,
  );
}

export interface RegisterShiftCashupIpcDeps extends ComposeShiftCashupServiceDeps {
  /** `POS_PULSE_FEATURE_SHIFT_CASHUP` at boot. */
  enabled: boolean;
  /** The lock-guarded `ipcMain`. */
  ipcMain: IpcMain;
  logger: ShiftCashupBridgeLogger;
}

/** The flag gate (see the module header). */
export function registerShiftCashupIpc(deps: RegisterShiftCashupIpcDeps): void {
  if (!deps.enabled) return;
  const service = composeShiftCashupService(deps);
  const bridge = createShiftCashupBridge({ service, logger: deps.logger });
  registerShiftCashupHandlers(deps.ipcMain, { bridge });
}
