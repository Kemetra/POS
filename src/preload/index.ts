import { contextBridge, ipcRenderer } from 'electron';
import { cart } from './cart.js';
import { payments, tender, vouchers } from './payments.js';
import { sales } from './sales.js';
import { receipts } from './receipts.js';
import { catalogue } from './catalogue.js';
import { salesSync } from './sales-sync.js';
import { returns } from './returns.js';
import type {
  CancelTakeoverRequest,
  CancelTakeoverResponse,
  ConfirmTakeoverRequest,
  ConfirmTakeoverResponse,
  EmitAuditEventRequest,
  EmitAuditEventResponse,
  ForceCloseShiftRequest,
  ForceCloseShiftResponse,
  ListBranchRosterResponse,
  ListStuckShiftsResponse,
  OperatorBridgeAPI,
  OperatorSessionBridgeView,
  PairingBridgeAPI,
  PreloadBridgeAPI,
  ProvisionCashierPinRequest,
  ProvisionCashierPinResponse,
  ResetCashierPinRequest,
  ResetCashierPinResponse,
  SignInRequest,
  SignInResponse,
  SignOutResponse,
  UnlockCashierRequest,
  UnlockCashierResponse,
  UnlockSessionRequest,
  UnlockSessionResponse,
  LockStateView,
} from '../shared/bridge-api';
import { subscribeSessionState } from './session-state.js';
import { subscribePairingStatus } from './pairing-status.js';
import type { OperatorRefusal } from '../shared/audit/event-shape';
import type { LogRecord } from '../shared/log-record';
import type { AppConfig } from '../shared/app-config';
import {
  PAIRING_IPC_CHANNELS,
  type PairingStatus,
  type PairingSubmitResult,
} from '../shared/pairing-types';
import { OPERATOR_IPC_CHANNELS, SESSION_LOCK_IPC_CHANNELS } from '../shared/operator/channels';

/**
 * T033 + T061 + T067 — preload bridge wired to ipcRenderer.invoke.
 *
 * Channel names mirror the constants in
 * `src/main/ipc/{ping,app-version,log,app-config}.ts`. Drift between
 * this file and the handler-side channel names surfaces as an
 * unhandled-promise / "no handler for channel" error in DevTools,
 * caught by the manual smoke gate.
 *
 * 002-terminal-pairing US1 (T014): `pairing.getStatus()` wired to
 * `ipcRenderer.invoke(PAIRING_IPC_CHANNELS.GET_STATUS)`.
 * 002-terminal-pairing US2 (T026): `pairing.submit()` wired to
 * `ipcRenderer.invoke(PAIRING_IPC_CHANNELS.SUBMIT, code)`. The
 * placeholder rejection from PR #16 is gone; the main-side handler
 * (T025) validates the argument shape and forwards the result of the
 * `PairingService.submit` orchestrator (PR #17). The result is a
 * typed `PairingSubmitResult` whose success branch omits
 * `device_token` by design — the renderer never sees the token.
 */
const pairing: PairingBridgeAPI = {
  getStatus: () => ipcRenderer.invoke(PAIRING_IPC_CHANNELS.GET_STATUS) as Promise<PairingStatus>,
  submit: (pairing_code: string) =>
    ipcRenderer.invoke(PAIRING_IPC_CHANNELS.SUBMIT, pairing_code) as Promise<PairingSubmitResult>,
  // RT-215 — the pairing-status push (validated `{ kind, reason? }` only).
  onStatusChanged: (cb) => subscribePairingStatus(ipcRenderer, cb),
};

/**
 * 004-operator-session T014/T029 + F-01 — `operator.*` namespace exposed
 * by preload. S1 wires sign-in (manager/admin only), sign-out, and
 * getCurrentSession. F-01 (s1-review) wires `_reportActivity` so the
 * renderer can report genuine user input to the inactivity monitor
 * (T028b / FR-009).
 *
 * The bridge handler validates input shapes; the preload layer is a
 * thin wire-up matching the established 002 pattern.
 */
const operator: OperatorBridgeAPI = {
  signIn: (req: SignInRequest) =>
    ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.SIGN_IN, req) as Promise<SignInResponse>,
  signOut: () => ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.SIGN_OUT) as Promise<SignOutResponse>,
  getCurrentSession: () =>
    ipcRenderer.invoke(
      OPERATOR_IPC_CHANNELS.GET_CURRENT_SESSION,
    ) as Promise<OperatorSessionBridgeView | null>,
  _reportActivity: () => void ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.REPORT_ACTIVITY),
  // RT-117 — inactivity lock: unlock, lock-screen read, and the state push.
  unlockSession: (req: UnlockSessionRequest) =>
    ipcRenderer.invoke(
      SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION,
      req,
    ) as Promise<UnlockSessionResponse>,
  getLockState: () =>
    ipcRenderer.invoke(SESSION_LOCK_IPC_CHANNELS.GET_LOCK_STATE) as Promise<LockStateView>,
  onSessionStateChanged: (cb) => subscribeSessionState(ipcRenderer, cb),
  emitAuditEvent: (req: EmitAuditEventRequest) =>
    ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.EMIT_AUDIT_EVENT, req) as Promise<
      EmitAuditEventResponse | OperatorRefusal
    >,
  _emitAuditEventSmoke: () =>
    ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.EMIT_AUDIT_EVENT_SMOKE) as Promise<
      EmitAuditEventResponse | OperatorRefusal
    >,
  listBranchRoster: () =>
    ipcRenderer.invoke(
      OPERATOR_IPC_CHANNELS.LIST_BRANCH_ROSTER,
    ) as Promise<ListBranchRosterResponse>,
  confirmTakeover: (req: ConfirmTakeoverRequest) =>
    ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.TAKEOVER_CONFIRM, req) as Promise<
      ConfirmTakeoverResponse | import('../shared/audit/event-shape').OperatorRefusal
    >,
  cancelTakeover: (req: CancelTakeoverRequest) =>
    ipcRenderer.invoke(
      OPERATOR_IPC_CHANNELS.TAKEOVER_CANCEL,
      req,
    ) as Promise<CancelTakeoverResponse>,
  resetCashierPin: (req: ResetCashierPinRequest) =>
    ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.RESET_CASHIER_PIN, req) as Promise<
      ResetCashierPinResponse | import('../shared/audit/event-shape').OperatorRefusal
    >,
  provisionCashierPin: (req: ProvisionCashierPinRequest) =>
    ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.PROVISION_CASHIER_PIN, req) as Promise<
      ProvisionCashierPinResponse | import('../shared/audit/event-shape').OperatorRefusal
    >,
  unlockCashier: (req: UnlockCashierRequest) =>
    ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER, req) as Promise<
      UnlockCashierResponse | import('../shared/audit/event-shape').OperatorRefusal
    >,
  forceCloseShift: (req: ForceCloseShiftRequest) =>
    ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.FORCE_CLOSE_SHIFT, req) as Promise<
      ForceCloseShiftResponse | import('../shared/audit/event-shape').OperatorRefusal
    >,
  listStuckShifts: () =>
    ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.LIST_STUCK_SHIFTS) as Promise<ListStuckShiftsResponse>,
  dismissShiftClosedNotice: () =>
    ipcRenderer.invoke(OPERATOR_IPC_CHANNELS.DISMISS_SHIFT_CLOSED_NOTICE) as Promise<void>,
};

const api: PreloadBridgeAPI = {
  ping: () => ipcRenderer.invoke('app:ping') as Promise<'pong'>,
  appVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
  log: (record: LogRecord) => ipcRenderer.invoke('app:log', record) as Promise<void>,
  appConfig: () => ipcRenderer.invoke('app:config') as Promise<AppConfig>,
  pairing,
  operator,
  cart,
  // 006-payments-tender — payments.* + tender.* (Slice 3 / T142) +
  // vouchers.* (Wave 4 / §A4-B authorisation 2026-05-25).
  // payments.discardOnSessionEnd is internal; payments.forceFail is
  // still gated and intentionally NOT exposed.
  payments,
  tender,
  vouchers,
  // 008-sale-finalization-and-receipts Slice 1c.2 — read-only sales.*
  // namespace. subscribe + unsubscribe are stubs (push primitive deferred).
  sales,
  // 008 Slice 2 — receipts.* namespace; receipts.preview only in S2.
  receipts,
  // 009 Slice S1 — read-only catalogue.* namespace (session-gated skeleton;
  // handlers return catalogue_unavailable until the read model lands in S2).
  catalogue,
  // 011-sale-sync-capture-up — read-only salesSync.* namespace (single
  // sales:syncStatus channel; the renderer can never trigger the drain — §A4).
  salesSync,
  // RT-15 S2 — returns.* (lookup / quote / submit / resolve / list). Gated in
  // main on the feature flag, session and manager/admin role.
  returns,
};

contextBridge.exposeInMainWorld('api', api);
