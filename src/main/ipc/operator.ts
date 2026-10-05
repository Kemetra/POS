import { randomUUID } from 'node:crypto';

import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import type {
  CancelTakeoverRequest,
  CancelTakeoverResponse,
  CashierSignInRequest,
  ConfirmTakeoverRequest,
  ConfirmTakeoverResponse,
  EmitAuditEventRequest,
  EmitAuditEventResponse,
  ForceCloseShiftRequest,
  ForceCloseShiftResponse,
  ListBranchRosterResponse,
  ListStuckShiftsResponse,
  ManagerAdminSignInRequest,
  OperatorSessionBridgeView,
  ProvisionCashierPinRequest,
  ProvisionCashierPinResponse,
  ResetCashierPinRequest,
  ResetCashierPinResponse,
  SignInResponse,
  SignOutResponse,
  UnlockCashierRequest,
  UnlockCashierResponse,
} from '../../shared/bridge-api.js';
import { OPERATOR_IPC_CHANNELS } from '../../shared/operator/channels.js';
import type { CashierSignInHandler, SignInHandler } from '../operator/sign-in-handler.js';
import type { SignOutHandler } from '../operator/sign-out-handler.js';
import type { RosterHandler } from '../operator/roster-handler.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { InactivityMonitor } from '../operator/inactivity-monitor.js';
import type { PairingStore } from '../pairing/store.js';
import {
  OperatorRefusalError,
  type OperatorRefusal,
  type ActionCategory,
} from '../../shared/audit/event-shape.js';
import type { AuditEmitter } from '../audit/audit-emitter.js';
import type { TakeoverHandler } from '../operator/takeover-handler.js';
import type { PinManagementHandler } from '../operator/pin-management.js';
import type { ForcedCloseHandler } from '../operator/forced-close-handler.js';
import type { StuckShiftsHandler } from '../operator/stuck-shifts-handler.js';
import { FORCED_CLOSE_REASONS } from '../../shared/audit/payload-schemas.js';

/**
 * 004-operator-session — `operator:*` IPC handlers (S1 wave 1 + T048).
 *
 * Mirrors the pattern from `src/main/ipc/pairing.ts`. Boundary input
 * validation refuses generically (PR-2 / NFR-003) — we never echo the
 * rejected payload into the thrown error message (Constitution VII).
 */

export interface OperatorHandlerDeps {
  signInHandler: SignInHandler;
  /** S4 / T075 — cashier PIN sign-in handler. */
  cashierSignInHandler: CashierSignInHandler;
  signOutHandler: SignOutHandler;
  /** T070b — branch roster handler. */
  rosterHandler: RosterHandler;
  sessionManager: SessionManager;
  inactivityMonitor: InactivityMonitor;
  /** T048 — audit-event emission. */
  auditEmitter: AuditEmitter;
  /** T048 — source of originating_terminal_id (trusted enrichment). */
  pairingStore: PairingStore;
  /** T070 / T071 — takeover confirm and cancel handler. */
  takeoverHandler: TakeoverHandler;
  /** T072 / T073 — PIN reset and unlock handler. */
  pinManagementHandler: PinManagementHandler;
  /** T089 — forced-close of a stuck cashier shift. */
  forcedCloseHandler: ForcedCloseHandler;
  /** T090 — list stuck cashier shifts for manager/admin. */
  stuckShiftsHandler: StuckShiftsHandler;
}

function refuseInvalid(): OperatorRefusal {
  return { kind: 'refused', category: 'invalid_input' };
}

/**
 * True when every named field on the untrusted payload is a non-empty
 * string. Shared shape check for the PIN / takeover / shift-admin requests.
 */
function hasNonEmptyStringFields(v: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((f) => {
    const raw = v[f];
    return typeof raw === 'string' && raw.length > 0;
  });
}

function asManagerAdminRequest(value: unknown): ManagerAdminSignInRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['kind'] !== 'manager_admin') return null;
  if (typeof v['identifier'] !== 'string' || typeof v['password'] !== 'string') return null;
  return {
    kind: 'manager_admin',
    identifier: v['identifier'],
    password: v['password'],
  };
}

function asCashierRequest(value: unknown): CashierSignInRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['kind'] !== 'cashier') return null;
  if (!hasNonEmptyStringFields(v, ['cashier_clerk_user_id', 'pin'])) return null;
  // display_name is required but may be empty.
  if (typeof v['display_name'] !== 'string') return null;
  return {
    kind: 'cashier',
    cashier_clerk_user_id: v['cashier_clerk_user_id'] as string,
    pin: v['pin'] as string,
    display_name: v['display_name'],
  };
}

/**
 * RT-117 §A4 L1 — categories only main may emit. The lock audit records a
 * main-side state change; a renderer must not be able to forge one. RT-113
 * P1.2: so does the offline grant invalidation. RT-215: likewise the
 * device-revoked pairing events (system-attributed).
 */
const MAIN_ONLY_AUDIT_CATEGORIES: ReadonlySet<string> = new Set([
  'operator.session.locked',
  'operator.session.unlocked',
  'operator.offline_grant.invalidated',
  'pairing.device_revoked',
  'pairing.device_revoked_cleared',
]);

function asEmitAuditEventRequest(value: unknown): EmitAuditEventRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['event_id'] !== 'string') return null;
  if (typeof v['action_category'] !== 'string') return null;
  if (typeof v['payload'] !== 'object' || v['payload'] === null || Array.isArray(v['payload'])) {
    return null;
  }
  const req: EmitAuditEventRequest = {
    event_id: v['event_id'],
    action_category: v['action_category'],
    payload: v['payload'] as Record<string, unknown>,
  };
  if (typeof v['shift_id'] === 'string') req.shift_id = v['shift_id'];
  if (typeof v['approving_supervisor_id'] === 'string') {
    req.approving_supervisor_id = v['approving_supervisor_id'];
  }
  return req;
}

function asConfirmTakeoverRequest(value: unknown): ConfirmTakeoverRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!hasNonEmptyStringFields(v, ['pending_takeover_id'])) return null;
  return { pending_takeover_id: v['pending_takeover_id'] as string };
}

function asCancelTakeoverRequest(value: unknown): CancelTakeoverRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['pending_takeover_id'] !== 'string') return null;
  return { pending_takeover_id: v['pending_takeover_id'] };
}

function asResetCashierPinRequest(value: unknown): ResetCashierPinRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!hasNonEmptyStringFields(v, ['event_id', 'target_cashier_id', 'new_pin'])) return null;
  return {
    event_id: v['event_id'] as string,
    target_cashier_id: v['target_cashier_id'] as string,
    new_pin: v['new_pin'] as string,
  };
}

function asProvisionCashierPinRequest(value: unknown): ProvisionCashierPinRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!hasNonEmptyStringFields(v, ['event_id', 'target_user_id', 'initial_pin'])) return null;
  return {
    event_id: v['event_id'] as string,
    target_user_id: v['target_user_id'] as string,
    initial_pin: v['initial_pin'] as string,
  };
}

function asUnlockCashierRequest(value: unknown): UnlockCashierRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!hasNonEmptyStringFields(v, ['event_id', 'target_cashier_id'])) return null;
  return {
    event_id: v['event_id'] as string,
    target_cashier_id: v['target_cashier_id'] as string,
  };
}

function asForceCloseShiftRequest(value: unknown): ForceCloseShiftRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!hasNonEmptyStringFields(v, ['event_id', 'shift_id'])) return null;
  if (
    typeof v['reason'] !== 'string' ||
    !(FORCED_CLOSE_REASONS as readonly string[]).includes(v['reason'])
  )
    return null;
  const req: ForceCloseShiftRequest = {
    event_id: v['event_id'] as string,
    shift_id: v['shift_id'] as string,
    reason: v['reason'] as ForceCloseShiftRequest['reason'],
  };
  if (typeof v['annotation'] === 'string') req.annotation = v['annotation'];
  return req;
}

// ---------------------------------------------------------------------------
// Per-concern registration blocks. Split from one monolithic register
// function; registration order is not significant (distinct channels).
// ---------------------------------------------------------------------------

/** Trusted enrichment: terminal_id comes from pairing state ('' when unpaired). */
async function resolveOriginatingTerminalId(pairingStore: PairingStore): Promise<string> {
  const pairingStatus = await pairingStore.getStatus();
  return pairingStatus.kind === 'paired' ? pairingStatus.terminal_id : '';
}

function registerSignInHandler(ipcMain: IpcMain, deps: OperatorHandlerDeps): void {
  const { signInHandler, cashierSignInHandler } = deps;

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.SIGN_IN,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<SignInResponse> => {
      try {
        const cashierReq = asCashierRequest(request);
        if (cashierReq !== null) {
          return await cashierSignInHandler.signIn(cashierReq);
        }
        const managerAdminReq = asManagerAdminRequest(request);
        if (managerAdminReq !== null) {
          return await signInHandler.signIn(managerAdminReq);
        }
        return refuseInvalid();
      } catch (err) {
        // Generic refusal on any unexpected throw. The error MUST NOT
        // surface its message via the bridge (Constitution VII). We
        // never re-throw the underlying error.
        if (err instanceof OperatorRefusalError) {
          return { kind: 'refused', category: err.category };
        }
        return refuseInvalid();
      }
    },
  );
}

function registerSessionHandlers(ipcMain: IpcMain, deps: OperatorHandlerDeps): void {
  const { signOutHandler, sessionManager, inactivityMonitor, cashierSignInHandler, pairingStore } =
    deps;

  ipcMain.handle(OPERATOR_IPC_CHANNELS.SIGN_OUT, async (): Promise<SignOutResponse> => {
    return signOutHandler.signOut();
  });

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.GET_CURRENT_SESSION,
    (): OperatorSessionBridgeView | null => {
      return sessionManager.getCurrentBridgeView();
    },
  );

  ipcMain.handle(OPERATOR_IPC_CHANNELS.REPORT_ACTIVITY, (): void => {
    inactivityMonitor.reportActivity();
  });

  ipcMain.handle(OPERATOR_IPC_CHANNELS.DISMISS_SHIFT_CLOSED_NOTICE, async (): Promise<void> => {
    try {
      const session = sessionManager.getCurrent();
      if (session === null) return;
      const pairingStatus = await pairingStore.getStatus();
      if (pairingStatus.kind !== 'paired') return;
      await cashierSignInHandler.dismissForcedCloseNotice(
        pairingStatus.tenant_id,
        pairingStatus.branch_id,
        pairingStatus.terminal_id,
        session.operator_id,
      );
    } catch {
      return;
    }
  });
}

function registerAuditHandlers(ipcMain: IpcMain, deps: OperatorHandlerDeps): void {
  const { sessionManager, pairingStore, auditEmitter } = deps;

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.EMIT_AUDIT_EVENT,
    async (
      _event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<EmitAuditEventResponse | OperatorRefusal> => {
      // Session gate: acting_operator_id comes from main-process session only.
      const session = sessionManager.getCurrent();
      if (session === null) {
        return { kind: 'refused', category: 'not_signed_in' };
      }

      const req = asEmitAuditEventRequest(request);
      if (req === null || MAIN_ONLY_AUDIT_CATEGORIES.has(req.action_category)) {
        return refuseInvalid();
      }

      const originating_terminal_id = await resolveOriginatingTerminalId(pairingStore);

      try {
        auditEmitter.emit({
          event_id: req.event_id,
          tenant_id: session.tenant_id,
          branch_id: session.branch_id,
          originating_terminal_id,
          acting_operator_id: session.operator_id,
          session_id: session.id,
          shift_id: req.shift_id ?? null,
          action_category: req.action_category as ActionCategory,
          created_at: new Date().toISOString(),
          approving_supervisor_id: req.approving_supervisor_id ?? null,
          payload: req.payload,
        });
        return { kind: 'emitted', event_id: req.event_id };
      } catch {
        // Generic refusal — error message MUST NOT cross the bridge (PR-2 / NFR-003).
        return refuseInvalid();
      }
    },
  );
}

function registerAuditSmokeHandler(ipcMain: IpcMain, deps: OperatorHandlerDeps): void {
  const { sessionManager, pairingStore, auditEmitter } = deps;

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.EMIT_AUDIT_EVENT_SMOKE,
    async (): Promise<EmitAuditEventResponse | OperatorRefusal> => {
      // Production guard: this path is for S3 quickstart smoke only.
      if (process.env['NODE_ENV'] === 'production') {
        return refuseInvalid();
      }

      const session = sessionManager.getCurrent();
      if (session === null) {
        return { kind: 'refused', category: 'not_signed_in' };
      }

      // Manager-tier gate: cashier cannot call this debug path.
      if (session.role === 'cashier') {
        return { kind: 'refused', category: 'role_mismatch' };
      }

      const originating_terminal_id = await resolveOriginatingTerminalId(pairingStore);

      const event_id = randomUUID();
      try {
        auditEmitter.emit({
          event_id,
          tenant_id: session.tenant_id,
          branch_id: session.branch_id,
          originating_terminal_id,
          acting_operator_id: session.operator_id,
          session_id: session.id,
          shift_id: null,
          action_category: 'shift.open',
          created_at: new Date().toISOString(),
          approving_supervisor_id: null,
          payload: { smoke: true },
        });
        return { kind: 'emitted', event_id };
      } catch {
        return refuseInvalid();
      }
    },
  );
}

function registerRosterHandler(ipcMain: IpcMain, deps: OperatorHandlerDeps): void {
  const { pairingStore, rosterHandler } = deps;

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.LIST_BRANCH_ROSTER,
    async (): Promise<ListBranchRosterResponse> => {
      // Pre-sign-in roster: sourced from pairing state, not an operator session.
      // The /sign-in route fetches the roster before any operator has signed in.
      // RT-113 P2: the device-authenticated roster takes the store from the
      // paired device itself, so only the paired check remains here.
      const pairingStatus = await pairingStore.getStatus();
      if (pairingStatus.kind !== 'paired') {
        return refuseInvalid();
      }
      return rosterHandler.listRoster();
    },
  );
}

function registerTakeoverHandlers(ipcMain: IpcMain, deps: OperatorHandlerDeps): void {
  const { takeoverHandler } = deps;

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.TAKEOVER_CONFIRM,
    async (
      _event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<ConfirmTakeoverResponse | OperatorRefusal> => {
      const req = asConfirmTakeoverRequest(request);
      if (req === null) return refuseInvalid();
      try {
        return await takeoverHandler.confirmTakeover(req);
      } catch {
        return refuseInvalid();
      }
    },
  );

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.TAKEOVER_CANCEL,
    async (_event: IpcMainInvokeEvent, request: unknown): Promise<CancelTakeoverResponse> => {
      const req = asCancelTakeoverRequest(request);
      if (req === null) return { kind: 'cancelled' };
      return takeoverHandler.cancelTakeover(req);
    },
  );
}

function registerPinManagementHandlers(ipcMain: IpcMain, deps: OperatorHandlerDeps): void {
  const { pinManagementHandler } = deps;

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.RESET_CASHIER_PIN,
    async (
      _event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<ResetCashierPinResponse | OperatorRefusal> => {
      const req = asResetCashierPinRequest(request);
      if (req === null) return refuseInvalid();
      try {
        return await pinManagementHandler.resetCashierPin(req);
      } catch {
        return refuseInvalid();
      }
    },
  );

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.PROVISION_CASHIER_PIN,
    async (
      _event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<ProvisionCashierPinResponse | OperatorRefusal> => {
      const req = asProvisionCashierPinRequest(request);
      if (req === null) return refuseInvalid();
      try {
        return await pinManagementHandler.provisionCashierPin(req);
      } catch {
        return refuseInvalid();
      }
    },
  );

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER,
    async (
      _event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<UnlockCashierResponse | OperatorRefusal> => {
      const req = asUnlockCashierRequest(request);
      if (req === null) return refuseInvalid();
      try {
        return await pinManagementHandler.unlockCashier(req);
      } catch {
        return refuseInvalid();
      }
    },
  );
}

function registerShiftAdminHandlers(ipcMain: IpcMain, deps: OperatorHandlerDeps): void {
  const { forcedCloseHandler, stuckShiftsHandler } = deps;

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.FORCE_CLOSE_SHIFT,
    async (
      _event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<ForceCloseShiftResponse | OperatorRefusal> => {
      const req = asForceCloseShiftRequest(request);
      if (req === null) return refuseInvalid();
      try {
        return await forcedCloseHandler.forceCloseShift(req);
      } catch {
        return refuseInvalid();
      }
    },
  );

  ipcMain.handle(
    OPERATOR_IPC_CHANNELS.LIST_STUCK_SHIFTS,
    async (): Promise<ListStuckShiftsResponse> => {
      try {
        return await stuckShiftsHandler.listStuckShifts();
      } catch {
        return refuseInvalid();
      }
    },
  );
}

export function registerOperatorHandlers(ipcMain: IpcMain, deps: OperatorHandlerDeps): void {
  registerSignInHandler(ipcMain, deps);
  registerSessionHandlers(ipcMain, deps);
  registerAuditHandlers(ipcMain, deps);
  registerAuditSmokeHandler(ipcMain, deps);
  registerRosterHandler(ipcMain, deps);
  registerTakeoverHandlers(ipcMain, deps);
  registerPinManagementHandlers(ipcMain, deps);
  registerShiftAdminHandlers(ipcMain, deps);
}
