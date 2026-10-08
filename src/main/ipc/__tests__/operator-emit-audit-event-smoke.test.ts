import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerOperatorHandlers } from '../operator.js';
import { OPERATOR_IPC_CHANNELS } from '../../../shared/operator/channels.js';
import type { EmitAuditEventResponse } from '../../../shared/bridge-api.js';
import type { OperatorRefusal } from '../../../shared/audit/event-shape.js';
import { AuditEmitter } from '../../audit/audit-emitter.js';
import type { AuditEventsStore } from '../../audit/audit-emitter.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { CashierSignInHandler, SignInHandler } from '../../operator/sign-in-handler.js';
import type { SignOutHandler } from '../../operator/sign-out-handler.js';
import type { RosterHandler } from '../../operator/roster-handler.js';
import type { SessionManager } from '../../operator/session-manager.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import type { InactivityMonitor } from '../../operator/inactivity-monitor.js';
import type { PairingStore } from '../../pairing/store.js';
import type { TakeoverHandler } from '../../operator/takeover-handler.js';
import type { PinManagementHandler } from '../../operator/pin-management.js';
import type { ForcedCloseHandler } from '../../operator/forced-close-handler.js';
import type { StuckShiftsHandler } from '../../operator/stuck-shifts-handler.js';

/**
 * T051 — `operator:_emit-audit-event-smoke` IPC handler tests.
 *
 * Verifies: production guard, session gate, role gate (manager/admin
 * pass; cashier refused), trusted enrichment from session + pairing,
 * hardcoded action_category / payload, and security invariants (no
 * sensitive values in the response).
 *
 * TDD-first per Constitution VI; implementation follows in operator.ts.
 */

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const FAKE_EVENT = {} as IpcMainInvokeEvent;

// ─── Minimal fakes ──────────────────────────────────────────────────

function fakeSignInHandler(): SignInHandler {
  return { signIn: vi.fn() } as unknown as SignInHandler;
}

function fakeCashierSignInHandler(): CashierSignInHandler {
  return {
    signIn: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
  } as unknown as CashierSignInHandler;
}

function fakeSignOutHandler(): SignOutHandler {
  return { signOut: vi.fn() } as unknown as SignOutHandler;
}

function fakeInactivityMonitor(): InactivityMonitor {
  return { reportActivity: vi.fn() } as unknown as InactivityMonitor;
}

function fakeRosterHandler(): RosterHandler {
  return {
    listRoster: vi.fn(() => Promise.resolve({ kind: 'roster' as const, cashiers: [] })),
  } as unknown as RosterHandler;
}

function fakeStore(): AuditEventsStore & { inserted: AuditEvent[] } {
  const inserted: AuditEvent[] = [];
  return { insertIgnore: (e) => inserted.push(e), inserted };
}

function makeSession(role: 'manager' | 'admin' | 'cashier'): OperatorSessionRecord {
  return {
    id: 'sess-t051',
    operator_id: 'op-t051',
    display_name: 'T051 Op',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    backend_session_id: 'be-sess-t051',
    started_at: '2026-05-07T00:00:00.000Z',
    last_activity_at: '2026-05-07T00:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
  };
}

function fakeSessionManager(session: OperatorSessionRecord | null): SessionManager {
  return {
    getCurrent: vi.fn(() => session),
    getCurrentBridgeView: vi.fn(() => null),
  } as unknown as SessionManager;
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

function fakePairingStore(terminal_id = 'term-1'): PairingStore {
  return {
    getStatus: vi.fn(() =>
      Promise.resolve({
        kind: 'paired' as const,
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        terminal_id,
        terminal_label: 'Counter',
        paired_at: 1735689600,
      }),
    ),
    getCurrentTerminalId: vi.fn(() => terminal_id),
    persist: vi.fn(),
    clear: vi.fn(),
  };
}

function makeIpcMain(): {
  ipcMain: IpcMain;
  handlers: Map<string, IpcHandler>;
} {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    }),
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

type FakeStore = ReturnType<typeof fakeStore>;

function setup(opts: {
  session?: OperatorSessionRecord | null;
  terminalId?: string;
  store?: FakeStore;
}): {
  smokeHandler: IpcHandler;
  store: FakeStore;
} {
  const store = opts.store ?? fakeStore();
  const emitter = new AuditEmitter(store);
  const { ipcMain, handlers } = makeIpcMain();
  registerOperatorHandlers(ipcMain, {
    signInHandler: fakeSignInHandler(),
    cashierSignInHandler: fakeCashierSignInHandler(),
    signOutHandler: fakeSignOutHandler(),
    rosterHandler: fakeRosterHandler(),
    sessionManager: fakeSessionManager(opts.session ?? null),
    inactivityMonitor: fakeInactivityMonitor(),
    auditEmitter: emitter,
    pairingStore: fakePairingStore(opts.terminalId ?? 'term-1'),
    takeoverHandler: fakeTakeoverHandler(),
    pinManagementHandler: fakePinManagementHandler(),
    forcedCloseHandler: fakeForcedCloseHandler(),
    stuckShiftsHandler: fakeStuckShiftsHandler(),
  });
  const smokeHandler = handlers.get(OPERATOR_IPC_CHANNELS.EMIT_AUDIT_EVENT_SMOKE);
  if (!smokeHandler) throw new Error('smoke handler not registered');
  return { smokeHandler, store };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Channel registration ────────────────────────────────────────────

describe('operator:_emit-audit-event-smoke — channel registration', () => {
  it('registers the smoke channel when handlers are wired', () => {
    const { ipcMain, handlers } = makeIpcMain();
    const store = fakeStore();
    registerOperatorHandlers(ipcMain, {
      signInHandler: fakeSignInHandler(),
      cashierSignInHandler: fakeCashierSignInHandler(),
      signOutHandler: fakeSignOutHandler(),
      rosterHandler: fakeRosterHandler(),
      sessionManager: fakeSessionManager(null),
      inactivityMonitor: fakeInactivityMonitor(),
      auditEmitter: new AuditEmitter(store),
      pairingStore: fakePairingStore(),
      takeoverHandler: fakeTakeoverHandler(),
      pinManagementHandler: fakePinManagementHandler(),
      forcedCloseHandler: fakeForcedCloseHandler(),
      stuckShiftsHandler: fakeStuckShiftsHandler(),
    });
    expect(handlers.has(OPERATOR_IPC_CHANNELS.EMIT_AUDIT_EVENT_SMOKE)).toBe(true);
  });
});

// ─── Production guard ────────────────────────────────────────────────

describe('operator:_emit-audit-event-smoke — production guard', () => {
  it('returns invalid_input refusal in production env', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { smokeHandler } = setup({ session: makeSession('manager') });
    const res = await smokeHandler(FAKE_EVENT);
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('does NOT call AuditEmitter in production env', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const store = fakeStore();
    const { smokeHandler } = setup({ session: makeSession('manager'), store });
    await smokeHandler(FAKE_EVENT);
    expect(store.inserted).toHaveLength(0);
  });
});

// ─── Session gate ────────────────────────────────────────────────────

describe('operator:_emit-audit-event-smoke — session gate', () => {
  it('returns not_signed_in when no session exists', async () => {
    const { smokeHandler } = setup({ session: null });
    const res = await smokeHandler(FAKE_EVENT);
    expect(res).toEqual({ kind: 'refused', category: 'not_signed_in' });
  });
});

// ─── Role gate ───────────────────────────────────────────────────────

describe('operator:_emit-audit-event-smoke — role gate', () => {
  it('refuses cashier role with role_mismatch', async () => {
    const { smokeHandler } = setup({ session: makeSession('cashier') });
    const res = await smokeHandler(FAKE_EVENT);
    expect(res).toEqual({ kind: 'refused', category: 'role_mismatch' });
  });

  it('does NOT call AuditEmitter for cashier role', async () => {
    const store = fakeStore();
    const { smokeHandler } = setup({ session: makeSession('cashier'), store });
    await smokeHandler(FAKE_EVENT);
    expect(store.inserted).toHaveLength(0);
  });
});

// ─── Success path — manager ──────────────────────────────────────────

describe('operator:_emit-audit-event-smoke — success (manager)', () => {
  it('returns emitted response with a UUID event_id', async () => {
    const { smokeHandler } = setup({ session: makeSession('manager') });
    const res = (await smokeHandler(FAKE_EVENT)) as EmitAuditEventResponse;
    expect(res.kind).toBe('emitted');
    expect(typeof res.event_id).toBe('string');
    expect(res.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('calls AuditEmitter exactly once with hardcoded category and payload', async () => {
    const store = fakeStore();
    const { smokeHandler } = setup({ session: makeSession('manager'), store });
    await smokeHandler(FAKE_EVENT);
    const inserted = store.inserted;
    expect(inserted).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const evt = inserted[0]!;
    expect(evt.action_category).toBe('shift.open');
    expect(evt.payload).toEqual({ smoke: true });
  });

  it('enriches trusted fields from session (manager)', async () => {
    const session = makeSession('manager');
    const store = fakeStore();
    const { smokeHandler } = setup({ session, store, terminalId: 'term-99' });
    await smokeHandler(FAKE_EVENT);
    const inserted = store.inserted;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const evt = inserted[0]!;
    expect(evt.acting_operator_id).toBe(session.operator_id);
    expect(evt.session_id).toBe(session.id);
    expect(evt.tenant_id).toBe(session.tenant_id);
    expect(evt.branch_id).toBe(session.branch_id);
    expect(evt.originating_terminal_id).toBe('term-99');
    expect(evt.shift_id).toBeNull();
    expect(evt.approving_supervisor_id).toBeNull();
  });

  it('event_id in response matches event_id in store', async () => {
    const store = fakeStore();
    const { smokeHandler } = setup({ session: makeSession('manager'), store });
    const res = (await smokeHandler(FAKE_EVENT)) as EmitAuditEventResponse;
    const inserted = store.inserted;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(res.event_id).toBe(inserted[0]!.event_id);
  });
});

// ─── Success path — admin ────────────────────────────────────────────

describe('operator:_emit-audit-event-smoke — success (admin)', () => {
  it('returns emitted response for admin role', async () => {
    const { smokeHandler } = setup({ session: makeSession('admin') });
    const res = (await smokeHandler(FAKE_EVENT)) as EmitAuditEventResponse;
    expect(res.kind).toBe('emitted');
  });

  it('enriches trusted fields from session (admin)', async () => {
    const session = makeSession('admin');
    const store = fakeStore();
    const { smokeHandler } = setup({ session, store });
    await smokeHandler(FAKE_EVENT);
    const inserted = store.inserted;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(inserted[0]!.acting_operator_id).toBe(session.operator_id);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(inserted[0]!.session_id).toBe(session.id);
  });
});

// ─── Security invariants ─────────────────────────────────────────────

describe('operator:_emit-audit-event-smoke — security invariants', () => {
  it('response contains no clerk_jwt, device_token, or backend_session_id', async () => {
    const { smokeHandler } = setup({ session: makeSession('manager') });
    const res = await smokeHandler(FAKE_EVENT);
    const serialised = JSON.stringify(res);
    expect(serialised).not.toContain('clerk_jwt');
    expect(serialised).not.toContain('device_token');
    expect(serialised).not.toContain('backend_session_id');
  });

  it('payload { smoke: true } contains no forbidden keys', async () => {
    const store = fakeStore();
    const { smokeHandler } = setup({ session: makeSession('manager'), store });
    await expect(smokeHandler(FAKE_EVENT)).resolves.toMatchObject({ kind: 'emitted' });
    const inserted = store.inserted;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const payloadStr = JSON.stringify(inserted[0]!.payload);
    for (const forbidden of ['pin', 'password', 'clerk_jwt', 'device_token', 'pairing_code']) {
      expect(payloadStr).not.toContain(forbidden);
    }
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────

describe('operator:_emit-audit-event-smoke — idempotency', () => {
  it('two calls produce two emitted responses (each generates a unique event_id)', async () => {
    const { smokeHandler } = setup({ session: makeSession('manager') });
    const r1 = (await smokeHandler(FAKE_EVENT)) as EmitAuditEventResponse;
    const r2 = (await smokeHandler(FAKE_EVENT)) as EmitAuditEventResponse;
    expect(r1.kind).toBe('emitted');
    expect(r2.kind).toBe('emitted');
    expect(r1.event_id).not.toBe(r2.event_id);
  });
});

// ─── Unpaired terminal ───────────────────────────────────────────────

describe('operator:_emit-audit-event-smoke — unpaired terminal', () => {
  it('uses empty string for originating_terminal_id when unpaired', async () => {
    const session = makeSession('manager');
    const store = fakeStore();
    const { ipcMain, handlers } = makeIpcMain();
    const pairingStore: PairingStore = {
      getStatus: vi.fn(() => Promise.resolve({ kind: 'unpaired' as const })),
      getCurrentTerminalId: vi.fn(() => null),
      persist: vi.fn(),
      clear: vi.fn(),
    };
    registerOperatorHandlers(ipcMain, {
      signInHandler: fakeSignInHandler(),
      cashierSignInHandler: fakeCashierSignInHandler(),
      signOutHandler: fakeSignOutHandler(),
      rosterHandler: fakeRosterHandler(),
      sessionManager: fakeSessionManager(session),
      inactivityMonitor: fakeInactivityMonitor(),
      auditEmitter: new AuditEmitter(store),
      pairingStore,
      takeoverHandler: fakeTakeoverHandler(),
      pinManagementHandler: fakePinManagementHandler(),
      forcedCloseHandler: fakeForcedCloseHandler(),
      stuckShiftsHandler: fakeStuckShiftsHandler(),
    });
    const handler = handlers.get(OPERATOR_IPC_CHANNELS.EMIT_AUDIT_EVENT_SMOKE);
    if (!handler) throw new Error('handler not registered');
    await handler(FAKE_EVENT);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(store.inserted[0]!.originating_terminal_id).toBe('');
  });
});

// ─── Response shape ──────────────────────────────────────────────────

describe('operator:_emit-audit-event-smoke — response shape on failure', () => {
  it('returns a typed OperatorRefusal (not a thrown error) on any failure path', async () => {
    const { smokeHandler } = setup({ session: null });
    const res = (await smokeHandler(FAKE_EVENT)) as OperatorRefusal;
    expect(res).toHaveProperty('kind', 'refused');
    expect(res).toHaveProperty('category');
  });
});
