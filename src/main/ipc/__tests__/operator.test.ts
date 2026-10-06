import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerOperatorHandlers } from '../operator.js';
import { OPERATOR_IPC_CHANNELS } from '../../../shared/operator/channels.js';
import type {
  BranchRosterCashier,
  ListBranchRosterResponse,
  OperatorSessionBridgeView,
  SignInResponse,
  SignOutResponse,
} from '../../../shared/bridge-api.js';
import { OperatorRefusalError } from '../../../shared/audit/event-shape.js';
import type { CashierSignInHandler, SignInHandler } from '../../operator/sign-in-handler.js';
import type { SignOutHandler } from '../../operator/sign-out-handler.js';
import type { RosterHandler } from '../../operator/roster-handler.js';
import type { SessionManager } from '../../operator/session-manager.js';
import type { InactivityMonitor } from '../../operator/inactivity-monitor.js';
import type { AuditEmitter } from '../../audit/audit-emitter.js';
import type { PairingStore } from '../../pairing/store.js';
import type { TakeoverHandler } from '../../operator/takeover-handler.js';
import type { PinManagementHandler } from '../../operator/pin-management.js';
import type { ForcedCloseHandler } from '../../operator/forced-close-handler.js';
import type { StuckShiftsHandler } from '../../operator/stuck-shifts-handler.js';

/**
 * 004-operator-session — IPC `operator:*` handler tests.
 *
 * Mirrors the 002 `pairing:*` IPC test pattern: handlers + state are
 * INJECTED, the channel names come from the canonical
 * OPERATOR_IPC_CHANNELS constant, and the test exercises BOUNDARY
 * input validation (renderers cannot exercise the inner handlers
 * with malformed payloads).
 */

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

interface RegisteredHandlers {
  signIn: IpcHandler;
  signOut: IpcHandler;
  getCurrentSession: IpcHandler;
  reportActivity: IpcHandler;
  dismissShiftClosedNotice: IpcHandler;
}

function makeIpcMain(): {
  ipcMain: IpcMain;
  handlers: Map<string, IpcHandler>;
  handle: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, IpcHandler>();
  const handle = vi.fn((channel: string, fn: IpcHandler) => {
    handlers.set(channel, fn);
  });
  const ipcMain = { handle } as unknown as IpcMain;
  return { ipcMain, handlers, handle };
}

function fakeSignInHandler(result: SignInResponse | (() => SignInResponse)): SignInHandler {
  const signIn = vi.fn(() => {
    if (typeof result === 'function') {
      return Promise.resolve().then(() => result());
    }
    return Promise.resolve(result);
  });
  return { signIn } as unknown as SignInHandler;
}

function fakeSignOutHandler(result: SignOutResponse): SignOutHandler {
  const signOut = vi.fn(() => Promise.resolve(result));
  return { signOut } as unknown as SignOutHandler;
}

function fakeSessionManager(view: OperatorSessionBridgeView | null): SessionManager {
  const getCurrentBridgeView = vi.fn(() => view);
  return { getCurrentBridgeView } as unknown as SessionManager;
}

function fakeInactivityMonitor(): {
  monitor: InactivityMonitor;
  reportActivity: ReturnType<typeof vi.fn>;
} {
  const reportActivity = vi.fn();
  const monitor = { reportActivity } as unknown as InactivityMonitor;
  return { monitor, reportActivity };
}

function fakeAuditEmitter(): AuditEmitter {
  return { emit: vi.fn() } as unknown as AuditEmitter;
}

function fakeRosterHandler(): RosterHandler {
  return {
    listRoster: vi.fn(() => Promise.resolve({ kind: 'roster' as const, cashiers: [] })),
  } as unknown as RosterHandler;
}

function fakePairingStore(): PairingStore {
  const store: PairingStore = {
    getStatus: vi.fn(() => Promise.resolve({ kind: 'unpaired' as const })),
    getCurrentTerminalId: vi.fn(() => null),
    persist: vi.fn(),
    clear: vi.fn(),
  };
  return store;
}

function fakeCashierSignInHandler(): CashierSignInHandler {
  return {
    signIn: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    dismissForcedCloseNotice: vi.fn(() => Promise.resolve()),
  } as unknown as CashierSignInHandler;
}

function fakeTakeoverHandler(): TakeoverHandler {
  return {
    confirmTakeover: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    cancelTakeover: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
  } as unknown as TakeoverHandler;
}

function fakePinManagementHandler(): PinManagementHandler {
  return {
    resetCashierPin: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    provisionCashierPin: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    unlockCashier: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
  } as unknown as PinManagementHandler;
}

function fakeForcedCloseHandler(): ForcedCloseHandler {
  return {
    forceCloseShift: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
  } as unknown as ForcedCloseHandler;
}

function fakeStuckShiftsHandler(): StuckShiftsHandler {
  return {
    listStuckShifts: vi.fn(() => Promise.resolve({ kind: 'stuck_shifts' as const, shifts: [] })),
  } as unknown as StuckShiftsHandler;
}

function register(opts: {
  signIn?: SignInResponse | (() => SignInResponse) | (() => never);
  signOut?: SignOutResponse;
  view?: OperatorSessionBridgeView | null;
}): {
  handlers: RegisteredHandlers;
  reportActivity: ReturnType<typeof vi.fn>;
} {
  const { ipcMain, handlers } = makeIpcMain();
  const sessionManager = fakeSessionManager(opts.view ?? null);
  const inactivity = fakeInactivityMonitor();
  registerOperatorHandlers(ipcMain, {
    signInHandler: fakeSignInHandler(opts.signIn ?? { kind: 'refused', category: 'invalid_input' }),
    cashierSignInHandler: fakeCashierSignInHandler(),
    signOutHandler: fakeSignOutHandler(opts.signOut ?? { kind: 'signed_out' }),
    rosterHandler: fakeRosterHandler(),
    sessionManager,
    inactivityMonitor: inactivity.monitor,
    auditEmitter: fakeAuditEmitter(),
    pairingStore: fakePairingStore(),
    takeoverHandler: fakeTakeoverHandler(),
    pinManagementHandler: fakePinManagementHandler(),
    forcedCloseHandler: fakeForcedCloseHandler(),
    stuckShiftsHandler: fakeStuckShiftsHandler(),
  });
  const get = (channel: string): IpcHandler => {
    const fn = handlers.get(channel);
    if (fn === undefined) throw new Error(`channel ${channel} not registered`);
    return fn;
  };
  return {
    handlers: {
      signIn: get(OPERATOR_IPC_CHANNELS.SIGN_IN),
      signOut: get(OPERATOR_IPC_CHANNELS.SIGN_OUT),
      getCurrentSession: get(OPERATOR_IPC_CHANNELS.GET_CURRENT_SESSION),
      reportActivity: get(OPERATOR_IPC_CHANNELS.REPORT_ACTIVITY),
      dismissShiftClosedNotice: get(OPERATOR_IPC_CHANNELS.DISMISS_SHIFT_CLOSED_NOTICE),
    },
    reportActivity: inactivity.reportActivity,
  };
}

const SAMPLE_VIEW: OperatorSessionBridgeView = {
  id: 'sess-1',
  operator_id: 'op-1',
  display_name: 'Manager',
  role: 'manager',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-06T00:00:00.000Z',
};

const FAKE_EVENT = {} as IpcMainInvokeEvent;

describe('registerOperatorHandlers — channel registration', () => {
  it('registers every approved operator:* channel exactly once', () => {
    const { ipcMain, handle } = makeIpcMain();
    registerOperatorHandlers(ipcMain, {
      signInHandler: fakeSignInHandler({ kind: 'refused', category: 'invalid_input' }),
      cashierSignInHandler: fakeCashierSignInHandler(),
      signOutHandler: fakeSignOutHandler({ kind: 'signed_out' }),
      rosterHandler: fakeRosterHandler(),
      sessionManager: fakeSessionManager(null),
      inactivityMonitor: fakeInactivityMonitor().monitor,
      auditEmitter: fakeAuditEmitter(),
      pairingStore: fakePairingStore(),
      takeoverHandler: fakeTakeoverHandler(),
      pinManagementHandler: fakePinManagementHandler(),
      forcedCloseHandler: fakeForcedCloseHandler(),
      stuckShiftsHandler: fakeStuckShiftsHandler(),
    });
    const registered = handle.mock.calls.map((c) => c[0] as string);
    expect(registered.sort()).toEqual(Object.values(OPERATOR_IPC_CHANNELS).sort());
    // Each channel registered exactly once.
    for (const channel of registered) {
      expect(registered.filter((c) => c === channel)).toHaveLength(1);
    }
  });
});

describe('operator:sign-in boundary input validation', () => {
  it('refuses generically when the payload is not an object', async () => {
    const { handlers } = register({});
    for (const bad of [null, undefined, 'string', 42, true]) {
      const res = await handlers.signIn(FAKE_EVENT, bad);
      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    }
  });

  it('refuses generically when kind is wrong or missing', async () => {
    const { handlers } = register({});
    for (const bad of [
      {},
      { kind: 'cashier', cashier_id: 'op', pin: '1234' },
      { kind: 'manager_admin' },
      { kind: 'manager_admin', identifier: 42, password: 'p' },
      { kind: 'manager_admin', identifier: 'i', password: null },
    ]) {
      const res = await handlers.signIn(FAKE_EVENT, bad);
      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    }
  });

  it('forwards a well-formed manager_admin request to the inner handler', async () => {
    const { handlers } = register({
      signIn: { kind: 'signed_in', session: SAMPLE_VIEW },
    });
    const res = await handlers.signIn(FAKE_EVENT, {
      kind: 'manager_admin',
      identifier: 'manager@x.test',
      password: 'p',
    });
    expect(res).toEqual({ kind: 'signed_in', session: SAMPLE_VIEW });
  });

  it('maps OperatorRefusalError thrown from inner handler to a typed refusal', async () => {
    const { handlers } = register({
      signIn: () => {
        throw new OperatorRefusalError('role_mismatch');
      },
    });
    const res = await handlers.signIn(FAKE_EVENT, {
      kind: 'manager_admin',
      identifier: 'i',
      password: 'p',
    });
    expect(res).toEqual({ kind: 'refused', category: 'role_mismatch' });
  });

  it('maps any other thrown error to a generic refusal (no message echo)', async () => {
    const { handlers } = register({
      signIn: () => {
        throw new Error('SHOULD-NOT-CROSS-BRIDGE');
      },
    });
    const res = await handlers.signIn(FAKE_EVENT, {
      kind: 'manager_admin',
      identifier: 'i',
      password: 'p',
    });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    // Defence in depth: the thrown message MUST NOT appear in the result.
    expect(JSON.stringify(res)).not.toContain('SHOULD-NOT-CROSS-BRIDGE');
  });
});

describe('operator:sign-out', () => {
  it('forwards to the sign-out handler', async () => {
    const { handlers } = register({ signOut: { kind: 'signed_out' } });
    const res = await handlers.signOut(FAKE_EVENT);
    expect(res).toEqual({ kind: 'signed_out' });
  });
});

describe('operator:get-current-session', () => {
  it('returns null when no session is active', async () => {
    const { handlers } = register({ view: null });
    expect(await handlers.getCurrentSession(FAKE_EVENT)).toBeNull();
  });

  it('returns the bridge view when a session is active', async () => {
    const { handlers } = register({ view: SAMPLE_VIEW });
    expect(await handlers.getCurrentSession(FAKE_EVENT)).toEqual(SAMPLE_VIEW);
  });
});

describe('operator:_report-activity', () => {
  it('forwards to the inactivity monitor', async () => {
    const { handlers, reportActivity } = register({});
    await handlers.reportActivity(FAKE_EVENT);
    expect(reportActivity).toHaveBeenCalledTimes(1);
  });
});

describe('operator:dismiss-shift-closed-notice', () => {
  function registerDismiss(opts: {
    session: { operator_id: string } | null;
    paired: boolean;
    reject?: boolean;
  }): { dismiss: ReturnType<typeof vi.fn>; invoke: () => Promise<unknown> } {
    const { ipcMain, handlers } = makeIpcMain();
    const dismiss = vi.fn(() =>
      opts.reject ? Promise.reject(new Error('SECRET-STORE-DETAIL')) : Promise.resolve(),
    );
    registerOperatorHandlers(ipcMain, {
      signInHandler: fakeSignInHandler({ kind: 'refused', category: 'invalid_input' }),
      cashierSignInHandler: {
        signIn: vi.fn(),
        dismissForcedCloseNotice: dismiss,
      } as unknown as CashierSignInHandler,
      signOutHandler: fakeSignOutHandler({ kind: 'signed_out' }),
      rosterHandler: fakeRosterHandler(),
      sessionManager: {
        getCurrent: vi.fn(() => opts.session),
        getCurrentBridgeView: vi.fn(() => null),
      } as unknown as SessionManager,
      inactivityMonitor: fakeInactivityMonitor().monitor,
      auditEmitter: fakeAuditEmitter(),
      pairingStore: {
        getStatus: vi.fn(() =>
          Promise.resolve(
            opts.paired
              ? {
                  kind: 'paired' as const,
                  tenant_id: 'tenant-1',
                  branch_id: 'branch-1',
                  terminal_id: 'terminal-1',
                  terminal_label: 'Counter 1',
                  paired_at: 1735689600,
                }
              : { kind: 'unpaired' as const },
          ),
        ),
        getCurrentTerminalId: vi.fn(() => (opts.paired ? 'terminal-1' : null)),
        persist: vi.fn(),
        clear: vi.fn(),
      },
      takeoverHandler: fakeTakeoverHandler(),
      pinManagementHandler: fakePinManagementHandler(),
      forcedCloseHandler: fakeForcedCloseHandler(),
      stuckShiftsHandler: fakeStuckShiftsHandler(),
    });
    const handler = getHandler(handlers, OPERATOR_IPC_CHANNELS.DISMISS_SHIFT_CLOSED_NOTICE);
    return { dismiss, invoke: () => Promise.resolve(handler(FAKE_EVENT)) };
  }

  it('derives tenant, branch, terminal, and cashier from main-side state', async () => {
    const { dismiss, invoke } = registerDismiss({
      session: { operator_id: 'cashier-1' },
      paired: true,
    });
    await invoke();
    expect(dismiss).toHaveBeenCalledWith('tenant-1', 'branch-1', 'terminal-1', 'cashier-1');
  });

  it('is a no-op without a session or paired terminal', async () => {
    const noSession = registerDismiss({ session: null, paired: true });
    await noSession.invoke();
    expect(noSession.dismiss).not.toHaveBeenCalled();

    const unpaired = registerDismiss({ session: { operator_id: 'cashier-1' }, paired: false });
    await unpaired.invoke();
    expect(unpaired.dismiss).not.toHaveBeenCalled();
  });

  it('swallows inner failures so raw errors do not reach the renderer', async () => {
    const { invoke } = registerDismiss({
      session: { operator_id: 'cashier-1' },
      paired: true,
      reject: true,
    });
    await expect(invoke()).resolves.toBeUndefined();
  });
});

// ─── Takeover confirm / cancel IPC boundary tests ──────────────────────────

function makeTakeoverHandler(opts: { confirmResult?: object; shouldThrow?: boolean }): {
  handler: TakeoverHandler;
  confirmFn: ReturnType<typeof vi.fn>;
} {
  const confirmFn = vi.fn(() => {
    if (opts.shouldThrow) throw new Error('unexpected inner error');
    return Promise.resolve(
      opts.confirmResult ?? { kind: 'refused' as const, category: 'invalid_input' as const },
    );
  });
  const handler = {
    confirmTakeover: confirmFn,
    cancelTakeover: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
  } as unknown as TakeoverHandler;
  return { handler, confirmFn };
}

function getHandler(handlers: Map<string, IpcHandler>, channel: string): IpcHandler {
  const fn = handlers.get(channel);
  if (fn === undefined) throw new Error(`channel ${channel} not registered`);
  return fn;
}

function registerWithTakeover(takeoverHandler: TakeoverHandler): Map<string, IpcHandler> {
  const { ipcMain, handlers } = makeIpcMain();
  registerOperatorHandlers(ipcMain, {
    signInHandler: fakeSignInHandler({ kind: 'refused', category: 'invalid_input' }),
    cashierSignInHandler: fakeCashierSignInHandler(),
    signOutHandler: fakeSignOutHandler({ kind: 'signed_out' }),
    rosterHandler: fakeRosterHandler(),
    sessionManager: fakeSessionManager(null),
    inactivityMonitor: fakeInactivityMonitor().monitor,
    auditEmitter: fakeAuditEmitter(),
    pairingStore: fakePairingStore(),
    takeoverHandler,
    pinManagementHandler: fakePinManagementHandler(),
    forcedCloseHandler: fakeForcedCloseHandler(),
    stuckShiftsHandler: fakeStuckShiftsHandler(),
  });
  return handlers;
}

describe('operator:takeover-confirm — boundary input validation', () => {
  it('refuses invalid_input when request is not an object', async () => {
    const { handler } = makeTakeoverHandler({});
    const handlers = registerWithTakeover(handler);
    const confirmChannel = getHandler(handlers, OPERATOR_IPC_CHANNELS.TAKEOVER_CONFIRM);
    for (const bad of [null, undefined, 'string', 42, true]) {
      const res = await confirmChannel(FAKE_EVENT, bad);
      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    }
  });

  it('refuses invalid_input when pending_takeover_id is missing or empty', async () => {
    const { handler } = makeTakeoverHandler({});
    const handlers = registerWithTakeover(handler);
    const confirmChannel = getHandler(handlers, OPERATOR_IPC_CHANNELS.TAKEOVER_CONFIRM);
    for (const bad of [{}, { pending_takeover_id: '' }, { pending_takeover_id: 42 }]) {
      const res = await confirmChannel(FAKE_EVENT, bad);
      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    }
  });

  it('forwards a well-formed request to takeoverHandler.confirmTakeover', async () => {
    const successResult = {
      kind: 'signed_in' as const,
      session: SAMPLE_VIEW,
    };
    const { handler, confirmFn } = makeTakeoverHandler({ confirmResult: successResult });
    const handlers = registerWithTakeover(handler);
    const confirmChannel = getHandler(handlers, OPERATOR_IPC_CHANNELS.TAKEOVER_CONFIRM);
    const res = await confirmChannel(FAKE_EVENT, { pending_takeover_id: 'tok-uuid-001' });
    expect(res).toEqual(successResult);
    expect(confirmFn).toHaveBeenCalledWith({ pending_takeover_id: 'tok-uuid-001' });
  });

  it('maps unexpected inner throws to a generic invalid_input refusal', async () => {
    const { handler } = makeTakeoverHandler({ shouldThrow: true });
    const handlers = registerWithTakeover(handler);
    const confirmChannel = getHandler(handlers, OPERATOR_IPC_CHANNELS.TAKEOVER_CONFIRM);
    const res = await confirmChannel(FAKE_EVENT, { pending_takeover_id: 'tok-uuid-002' });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
  });
});

// ─── Pre-sign-in roster (T070b contract fix) ──────────────────────────────────

function makePairedPairingStore(
  branch_id = 'branch-roster-1',
  cashiers?: BranchRosterCashier[],
): {
  pairingStore: PairingStore;
  rosterHandler: RosterHandler;
} {
  const pairingStore: PairingStore = {
    getStatus: vi.fn(() =>
      Promise.resolve({
        kind: 'paired' as const,
        tenant_id: 'tenant-1',
        branch_id,
        terminal_id: 'term-1',
        terminal_label: 'Counter',
        paired_at: 1735689600,
      }),
    ),
    getCurrentTerminalId: vi.fn(() => 'term-1'),
    persist: vi.fn(),
    clear: vi.fn(),
  };
  const resolvedCashiers: BranchRosterCashier[] = cashiers ?? [
    { id: 'cashier-1', display_name: 'Alice', role: 'cashier' as const },
  ];
  const rosterHandler: RosterHandler = {
    listRoster: vi.fn(() =>
      Promise.resolve({ kind: 'roster' as const, cashiers: resolvedCashiers }),
    ),
  } as unknown as RosterHandler;
  return { pairingStore, rosterHandler };
}

function registerWithPairingStore(
  pairingStore: PairingStore,
  rosterHandler?: RosterHandler,
): Map<string, IpcHandler> {
  const { ipcMain, handlers } = makeIpcMain();
  registerOperatorHandlers(ipcMain, {
    signInHandler: fakeSignInHandler({ kind: 'refused', category: 'invalid_input' }),
    cashierSignInHandler: fakeCashierSignInHandler(),
    signOutHandler: fakeSignOutHandler({ kind: 'signed_out' }),
    rosterHandler:
      rosterHandler ??
      ({
        listRoster: vi.fn(() => Promise.resolve({ kind: 'roster', cashiers: [] })),
      } as unknown as RosterHandler),
    sessionManager: fakeSessionManager(null),
    inactivityMonitor: fakeInactivityMonitor().monitor,
    auditEmitter: fakeAuditEmitter(),
    pairingStore,
    takeoverHandler: fakeTakeoverHandler(),
    pinManagementHandler: fakePinManagementHandler(),
    forcedCloseHandler: fakeForcedCloseHandler(),
    stuckShiftsHandler: fakeStuckShiftsHandler(),
  });
  return handlers;
}

describe('operator:list-branch-roster — pre-sign-in access', () => {
  it('returns roster when terminal is paired and no operator session exists', async () => {
    const { pairingStore, rosterHandler } = makePairedPairingStore('branch-1');
    const handlers = registerWithPairingStore(pairingStore, rosterHandler);
    const rosterChannel = getHandler(handlers, OPERATOR_IPC_CHANNELS.LIST_BRANCH_ROSTER);
    const res = (await rosterChannel(FAKE_EVENT)) as ListBranchRosterResponse;
    expect(res.kind).toBe('roster');
  });

  it('calls rosterHandler when paired (no session); the device decides the store (RT-113 P2)', async () => {
    const { pairingStore, rosterHandler } = makePairedPairingStore('branch-999');
    const handlers = registerWithPairingStore(pairingStore, rosterHandler);
    const rosterChannel = getHandler(handlers, OPERATOR_IPC_CHANNELS.LIST_BRANCH_ROSTER);
    await rosterChannel(FAKE_EVENT);
    // The device-authenticated roster takes the store from the device row, so
    // no branch parameter is passed (10763 D11).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(rosterHandler.listRoster).toHaveBeenCalledWith();
  });

  it('refuses with invalid_input when terminal is unpaired', async () => {
    const unpaired: PairingStore = {
      getStatus: vi.fn(() => Promise.resolve({ kind: 'unpaired' as const })),
      getCurrentTerminalId: vi.fn(() => null),
      persist: vi.fn(),
      clear: vi.fn(),
    };
    const handlers = registerWithPairingStore(unpaired);
    const rosterChannel = getHandler(handlers, OPERATOR_IPC_CHANNELS.LIST_BRANCH_ROSTER);
    const res = await rosterChannel(FAKE_EVENT);
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('response roster contains only minimum-disclosure fields (no email/phone/PIN fields)', async () => {
    const cashiersFromBackend: BranchRosterCashier[] = [
      { id: 'c-1', display_name: 'Bob', role: 'cashier' as const },
    ];
    const { pairingStore, rosterHandler } = makePairedPairingStore('branch-1', cashiersFromBackend);
    const handlers = registerWithPairingStore(pairingStore, rosterHandler);
    const rosterChannel = getHandler(handlers, OPERATOR_IPC_CHANNELS.LIST_BRANCH_ROSTER);
    const res = (await rosterChannel(FAKE_EVENT)) as ListBranchRosterResponse;
    const serialised = JSON.stringify(res);
    expect(serialised).not.toContain('email');
    expect(serialised).not.toContain('phone');
    expect(serialised).not.toContain('pin');
    expect(serialised).not.toContain('password');
  });
});

describe('operator:takeover-cancel — boundary behaviour', () => {
  it('returns cancelled when request is not an object (lenient — always cancels)', async () => {
    const { handler } = makeTakeoverHandler({});
    const handlers = registerWithTakeover(handler);
    const cancelChannel = getHandler(handlers, OPERATOR_IPC_CHANNELS.TAKEOVER_CANCEL);
    for (const bad of [null, undefined, 'string', 42]) {
      const res = await cancelChannel(FAKE_EVENT, bad);
      expect(res).toEqual({ kind: 'cancelled' });
    }
  });

  it('forwards a well-formed cancel request to takeoverHandler.cancelTakeover', async () => {
    const { handler } = makeTakeoverHandler({});
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const cancelFn = handler.cancelTakeover as ReturnType<typeof vi.fn>;
    const handlers = registerWithTakeover(handler);
    const cancelChannel = getHandler(handlers, OPERATOR_IPC_CHANNELS.TAKEOVER_CANCEL);
    const res = await cancelChannel(FAKE_EVENT, { pending_takeover_id: 'tok-uuid-003' });
    expect(res).toEqual({ kind: 'cancelled' });
    expect(cancelFn).toHaveBeenCalledWith({ pending_takeover_id: 'tok-uuid-003' });
  });
});

// ─── 019 — operator:provision-cashier-pin boundary validation + delegation ───

/**
 * Registers the operator handlers with an injected pinManagementHandler so the
 * PROVISION_CASHIER_PIN channel's validator + delegation + catch branches are
 * exercised at the IPC boundary (the handler's own logic is unit-tested in
 * pin-management.provision.test.ts; here we cover the IPC-layer guard).
 */
function registerWithPinManagement(
  pinManagementHandler: PinManagementHandler,
): Map<string, IpcHandler> {
  const { ipcMain, handlers } = makeIpcMain();
  registerOperatorHandlers(ipcMain, {
    signInHandler: fakeSignInHandler({ kind: 'refused', category: 'invalid_input' }),
    cashierSignInHandler: fakeCashierSignInHandler(),
    signOutHandler: fakeSignOutHandler({ kind: 'signed_out' }),
    rosterHandler: fakeRosterHandler(),
    sessionManager: fakeSessionManager(null),
    inactivityMonitor: fakeInactivityMonitor().monitor,
    auditEmitter: fakeAuditEmitter(),
    pairingStore: fakePairingStore(),
    takeoverHandler: fakeTakeoverHandler(),
    pinManagementHandler,
    forcedCloseHandler: fakeForcedCloseHandler(),
    stuckShiftsHandler: fakeStuckShiftsHandler(),
  });
  return handlers;
}

const VALID_PROVISION_REQUEST = {
  event_id: 'evt-uuid-019',
  target_cashier_id: 'roster-operator-id-1',
  initial_pin: '4729',
};

describe('operator:provision-cashier-pin — boundary input validation + delegation', () => {
  it('refuses invalid_input (and never calls the handler) when the payload is not an object', async () => {
    const inner = fakePinManagementHandler();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const provisionFn = inner.provisionCashierPin as ReturnType<typeof vi.fn>;
    const handlers = registerWithPinManagement(inner);
    const channel = getHandler(handlers, OPERATOR_IPC_CHANNELS.PROVISION_CASHIER_PIN);

    for (const bad of [null, undefined, 'string', 42, true]) {
      const res = await channel(FAKE_EVENT, bad);
      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    }
    expect(provisionFn).not.toHaveBeenCalled();
  });

  it('refuses invalid_input when a required field is missing, empty, or the wrong type', async () => {
    const inner = fakePinManagementHandler();
    const handlers = registerWithPinManagement(inner);
    const channel = getHandler(handlers, OPERATOR_IPC_CHANNELS.PROVISION_CASHIER_PIN);

    for (const bad of [
      {},
      { ...VALID_PROVISION_REQUEST, event_id: '' },
      { ...VALID_PROVISION_REQUEST, event_id: 42 },
      { ...VALID_PROVISION_REQUEST, target_cashier_id: '' },
      { ...VALID_PROVISION_REQUEST, target_cashier_id: null },
      { ...VALID_PROVISION_REQUEST, initial_pin: '' },
      { ...VALID_PROVISION_REQUEST, initial_pin: 1234 },
    ]) {
      const res = await channel(FAKE_EVENT, bad);
      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    }
  });

  it('forwards a well-formed request to pinManagementHandler.provisionCashierPin', async () => {
    const inner = {
      resetCashierPin: vi.fn(),
      provisionCashierPin: vi.fn(() =>
        Promise.resolve({ kind: 'pin_provisioned' as const, audit_event_id: 'evt-uuid-019' }),
      ),
      unlockCashier: vi.fn(),
    } as unknown as PinManagementHandler;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const provisionFn = inner.provisionCashierPin as ReturnType<typeof vi.fn>;
    const handlers = registerWithPinManagement(inner);
    const channel = getHandler(handlers, OPERATOR_IPC_CHANNELS.PROVISION_CASHIER_PIN);

    const res = await channel(FAKE_EVENT, VALID_PROVISION_REQUEST);

    expect(res).toEqual({ kind: 'pin_provisioned', audit_event_id: 'evt-uuid-019' });
    expect(provisionFn).toHaveBeenCalledWith(VALID_PROVISION_REQUEST);
  });

  it('refuses generically (no error message crosses the bridge) when the inner handler throws', async () => {
    const inner = {
      resetCashierPin: vi.fn(),
      provisionCashierPin: vi.fn(() => Promise.reject(new Error('db is on fire — must not leak'))),
      unlockCashier: vi.fn(),
    } as unknown as PinManagementHandler;
    const handlers = registerWithPinManagement(inner);
    const channel = getHandler(handlers, OPERATOR_IPC_CHANNELS.PROVISION_CASHIER_PIN);

    const res = await channel(FAKE_EVENT, VALID_PROVISION_REQUEST);

    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    // The thrown error message MUST NOT cross the bridge (Constitution VII / PR-2).
    expect(JSON.stringify(res)).not.toContain('fire');
  });
});
