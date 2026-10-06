/**
 * RT-17 slice 4 part 1 — `shiftCashup:*` IPC registration (§A4 bridge
 * security).
 *
 * `registerShiftCashupIpc` is the flag gate: with
 * `POS_PULSE_FEATURE_SHIFT_CASHUP` off (default) it registers nothing. With
 * it on, it composes the service, the manager PIN store and enrolment, and
 * their bridge, registers the seven handlers on the lock-guarded `ipcMain`,
 * and subscribes the manager record refresh to session starts (review round 1
 * P2-1: an online manager / admin sign-in renews that manager's record on
 * this terminal). None of the channels is on the locked-session allowlist, so
 * each is refused while the session is locked; the service re-reads the flag
 * and checks the session on every call.
 *
 * The renderer is untrusted input. Each request is validated here before the
 * bridge runs, and anything outside the closed shape is `invalid_input`:
 *
 *   • `open`: exactly `{ openingFloatMinor }`, a safe integer ≥ 0;
 *   • `payIn` / `payOut`: exactly `{ amountMinor, reasonCode, note? }` — a
 *     safe integer ≥ 1, a reason in the contract's closed set, and an
 *     optional note of 1–200 characters with no control character (an
 *     undefined note is no note);
 *   • `close`: exactly `{ countedCashMinor, approver? }` — a safe integer
 *     ≥ 0 and, optionally, `approver: { managerRef, managerPin }` exactly: an
 *     opaque lower-case UUID handle (from `listEnrolledManagers`, never a
 *     users.id) and a PIN of 6–8 ASCII digits (part 2, owner approval 10943;
 *     review round 1). No approver id, close kind or anything else;
 *   • `status` / `listEnrolledManagers`: no payload (undefined or `{}`);
 *   • `enrollManagerPin`: exactly `{ managerPin, currentPin? }`, each 6–8
 *     ASCII digits (an undefined current PIN is none).
 *
 * No operator, user id, scope, currency, id, time or key can be smuggled in:
 * main derives them all.
 */
import type { IpcMain } from 'electron';

import { SHIFT_CASHUP_IPC_CHANNELS } from '../../shared/shift-cashup/channels.js';
import {
  MANAGER_PIN_PATTERN,
  MANAGER_REF_PATTERN,
  SHIFT_MOVEMENT_REASON_CODES,
  SHIFT_NOTE_MAX_LENGTH,
  type ShiftCashupBridgeAPI,
  type ShiftCloseApprover,
  type ShiftCloseRequest,
  type ShiftManagerPinEnrollRequest,
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
import {
  createManagerOnlineRefresh,
  createManagerPinEnrollment,
  type ManagerOnlineRefreshDeps,
  type ManagerPinEnrollmentDeps,
} from '../operator/manager-pin-enrollment.js';
import { createManagerPinStore } from '../operator/manager-pin-store.js';
import type { OperatorSessionRecord } from '../operator/session-manager.js';
import type { SafeStorageLike } from '../secrets/safe-storage.js';

const INVALID = { kind: 'refused', reason: 'invalid_input' } as const;
const PRINTABLE = /^[^\p{Cc}]+$/u;

const OPEN_KEYS = ['openingFloatMinor'] as const;
const MOVEMENT_KEYS = ['amountMinor', 'reasonCode', 'note'] as const;
const CLOSE_KEYS = ['countedCashMinor', 'approver'] as const;
const APPROVER_KEYS = ['managerRef', 'managerPin'] as const;
const ENROL_KEYS = ['managerPin', 'currentPin'] as const;

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

/** A positive amount and a known reason, with `note` (already read), or null. */
function movementWith(
  value: Record<string, unknown>,
  note: { note?: string },
): ShiftMovementRequest | null {
  const { amountMinor, reasonCode } = value;
  if (!isMinorFrom(amountMinor, 1)) return null;
  return isReasonCode(reasonCode) ? { amountMinor, reasonCode, ...note } : null;
}

/** `{ amountMinor, reasonCode, note? }` exactly, or null. */
export function readMovementRequest(value: unknown): ShiftMovementRequest | null {
  if (!isClosedShape(value, MOVEMENT_KEYS)) return null;
  const note = readNote(value['note']);
  return note === null ? null : movementWith(value, note);
}

function isManagerPin(value: unknown): value is string {
  return typeof value === 'string' && MANAGER_PIN_PATTERN.test(value);
}

function isManagerRef(value: unknown): value is string {
  return typeof value === 'string' && MANAGER_REF_PATTERN.test(value);
}

/** `{ managerRef, managerPin }` exactly, or null. */
function readCloseApprover(value: unknown): ShiftCloseApprover | null {
  if (!isClosedShape(value, APPROVER_KEYS)) return null;
  const { managerRef, managerPin } = value;
  return isManagerRef(managerRef) && isManagerPin(managerPin) ? { managerRef, managerPin } : null;
}

/** `{ approver }` when a valid one was given, `{}` when none, null when invalid. */
function readApprover(value: unknown): { approver?: ShiftCloseApprover } | null {
  if (value === undefined) return {};
  const approver = readCloseApprover(value);
  return approver === null ? null : { approver };
}

/** `{ countedCashMinor, approver? }` exactly, or null. */
export function readCloseRequest(value: unknown): ShiftCloseRequest | null {
  if (!isClosedShape(value, CLOSE_KEYS)) return null;
  const { countedCashMinor } = value;
  const approver = readApprover(value['approver']);
  if (approver === null || !isMinorFrom(countedCashMinor, 0)) return null;
  return { countedCashMinor, ...approver };
}

/** `{ managerPin, currentPin? }` exactly, or null. */
export function readEnrollRequest(value: unknown): ShiftManagerPinEnrollRequest | null {
  if (!isClosedShape(value, ENROL_KEYS)) return null;
  const { managerPin, currentPin } = value;
  if (!isManagerPin(managerPin)) return null;
  if (currentPin === undefined) return { managerPin };
  return isManagerPin(currentPin) ? { managerPin, currentPin } : null;
}

/** `status` and `listEnrolledManagers` accept no payload (undefined or `{}`). */
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
  const { OPEN, PAY_IN, PAY_OUT, CLOSE, STATUS, ENROLL_MANAGER_PIN, LIST_ENROLLED_MANAGERS } =
    SHIFT_CASHUP_IPC_CHANNELS;
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
  ipcMain.handle(
    ENROLL_MANAGER_PIN,
    validated(readEnrollRequest, (req) => bridge.enrollManagerPin(req)),
  );
  ipcMain.handle(LIST_ENROLLED_MANAGERS, (_event, request: unknown) =>
    isEmptyPayload(request) ? bridge.listEnrolledManagers() : INVALID,
  );
}

export interface RegisterShiftCashupIpcDeps
  extends
    Omit<ComposeShiftCashupServiceDeps, 'managerPins'>,
    Pick<ManagerPinEnrollmentDeps, 'getManager'>,
    Pick<ManagerOnlineRefreshDeps, 'currentTerminalId'> {
  /** `POS_PULSE_FEATURE_SHIFT_CASHUP` at boot. */
  enabled: boolean;
  /** The lock-guarded `ipcMain`. */
  ipcMain: IpcMain;
  /** Seals the manager PIN hashes at rest (DPAPI on Windows). */
  safeStorage: SafeStorageLike;
  /** `OperatorSessionManager.onStarted`: called with each new session. */
  onSessionStarted: (listener: (record: OperatorSessionRecord) => void) => void;
  logger: ShiftCashupBridgeLogger;
}

/** The flag gate (see the module header). */
export function registerShiftCashupIpc(deps: RegisterShiftCashupIpcDeps): void {
  if (!deps.enabled) return;
  const managerPins = createManagerPinStore({ db: deps.db, safeStorage: deps.safeStorage });
  const service = composeShiftCashupService({ ...deps, managerPins });
  const enrollment = createManagerPinEnrollment({ ...deps, store: managerPins });
  const bridge = createShiftCashupBridge({ service, enrollment, logger: deps.logger });
  registerShiftCashupHandlers(deps.ipcMain, { bridge });
  deps.onSessionStarted(
    createManagerOnlineRefresh({ store: managerPins, currentTerminalId: deps.currentTerminalId }),
  );
}
