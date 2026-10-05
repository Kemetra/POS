import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerOperatorHandlers } from '../operator.js';
import { OPERATOR_IPC_CHANNELS } from '../../../shared/operator/channels.js';
import type { EmitAuditEventRequest, EmitAuditEventResponse } from '../../../shared/bridge-api.js';
import type { AuditEmitter } from '../../audit/audit-emitter.js';
import {
  ForbiddenPayloadKeyError,
  MissingMandatoryAttributeError,
} from '../../audit/audit-emitter.js';
import type { PairingStore } from '../../pairing/store.js';
import type { SessionManager } from '../../operator/session-manager.js';
import type { CashierSignInHandler, SignInHandler } from '../../operator/sign-in-handler.js';
import type { SignOutHandler } from '../../operator/sign-out-handler.js';
import type { RosterHandler } from '../../operator/roster-handler.js';
import type { InactivityMonitor } from '../../operator/inactivity-monitor.js';
import type { TakeoverHandler } from '../../operator/takeover-handler.js';
import type { PinManagementHandler } from '../../operator/pin-management.js';
import type { ForcedCloseHandler } from '../../operator/forced-close-handler.js';
import type { StuckShiftsHandler } from '../../operator/stuck-shifts-handler.js';

/**
 * T048 — operator:emit-audit-event IPC handler tests.
 *
 * Covers the bridge-call contract end-to-end at the IPC boundary:
 * - Well-formed request enriches trusted fields and delegates to AuditEmitter.
 * - No active session → not_signed_in refusal.
 * - AuditEmitter throws ForbiddenPayloadKeyError → invalid_input refusal (no key echo).
 * - AuditEmitter throws MissingMandatoryAttributeError → invalid_input refusal.
 * - Unexpected throw → invalid_input refusal, message not echoed.
 * - Terminal unpaired → originating_terminal_id falls back gracefully.
 * - Renderer-visible response never contains Clerk JWT or device_token.
 * - No T051/lifecycle side-effects tested here.
 */

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function makeIpcMain(): {
  ipcMain: IpcMain;
  handlers: Map<string, IpcHandler>;
} {
  const handlers = new Map<string, IpcHandler>();
  const handle = vi.fn((channel: string, fn: IpcHandler) => {
    handlers.set(channel, fn);
  });
  const ipcMain = { handle } as unknown as IpcMain;
  return { ipcMain, handlers };
}

function fakeAuditEmitter(impl?: Partial<{ emit: (event: unknown) => void }>): AuditEmitter {
  return {
    emit: impl?.emit ?? vi.fn(),
  } as unknown as AuditEmitter;
}

function fakePairingStore(terminalId: string | null = 'terminal-001'): PairingStore {
  const getStatus = vi.fn(() => {
    if (terminalId !== null) {
      return Promise.resolve({
        kind: 'paired' as const,
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        terminal_id: terminalId,
        terminal_label: 'POS-01',
        paired_at: 1700000000,
      });
    }
    return Promise.resolve({ kind: 'unpaired' as const });
  });
  const store: PairingStore = {
    getStatus,
    getCurrentTerminalId: vi.fn(() => terminalId),
    persist: vi.fn(),
    clear: vi.fn(),
  };
  return store;
}

function fakeSessionManager(
  opts: {
    id?: string;
    operator_id?: string;
    tenant_id?: string;
    branch_id?: string;
  } | null = {
    id: 'sess-abc',
    operator_id: 'op-xyz',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
  },
): SessionManager {
  const getCurrent = vi.fn(() => {
    if (opts === null) return null;
    return {
      id: opts.id ?? 'sess-abc',
      operator_id: opts.operator_id ?? 'op-xyz',
      tenant_id: opts.tenant_id ?? 'tenant-1',
      branch_id: opts.branch_id ?? 'branch-1',
      display_name: 'Test User',
      role: 'manager' as const,
      backend_session_id: 'be-sess-1',
      started_at: '2026-05-07T00:00:00.000Z',
      last_activity_at: '2026-05-07T00:00:00.000Z',
    };
  });
  const getCurrentBridgeView = vi.fn(() => null);
  return { getCurrent, getCurrentBridgeView } as unknown as SessionManager;
}

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
  return {
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
  } as unknown as SignOutHandler;
}

function fakeInactivityMonitor(): InactivityMonitor {
  return { reportActivity: vi.fn(), start: vi.fn() } as unknown as InactivityMonitor;
}

function fakeRosterHandler(): RosterHandler {
  return {
    listRoster: vi.fn(() => Promise.resolve({ kind: 'roster' as const, cashiers: [] })),
  } as unknown as RosterHandler;
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

interface SetupOpts {
  sessionManager?: SessionManager;
  auditEmitter?: AuditEmitter;
  pairingStore?: PairingStore;
}

function setup(opts: SetupOpts = {}) {
  const { ipcMain, handlers } = makeIpcMain();
  const sessionManager = opts.sessionManager ?? fakeSessionManager();
  const auditEmitter = opts.auditEmitter ?? fakeAuditEmitter();
  const pairingStore = opts.pairingStore ?? fakePairingStore();

  registerOperatorHandlers(ipcMain, {
    signInHandler: fakeSignInHandler(),
    cashierSignInHandler: fakeCashierSignInHandler(),
    signOutHandler: fakeSignOutHandler(),
    rosterHandler: fakeRosterHandler(),
    sessionManager,
    inactivityMonitor: fakeInactivityMonitor(),
    auditEmitter,
    pairingStore,
    takeoverHandler: fakeTakeoverHandler(),
    pinManagementHandler: fakePinManagementHandler(),
    forcedCloseHandler: fakeForcedCloseHandler(),
    stuckShiftsHandler: fakeStuckShiftsHandler(),
  });

  const emitAuditEvent = handlers.get(OPERATOR_IPC_CHANNELS.EMIT_AUDIT_EVENT);
  if (emitAuditEvent === undefined) {
    throw new Error('operator:emit-audit-event channel not registered');
  }

  return { emitAuditEvent, auditEmitter, sessionManager, pairingStore };
}

const FAKE_EVENT = {} as IpcMainInvokeEvent;

const VALID_REQUEST: EmitAuditEventRequest = {
  event_id: 'evt-001',
  action_category: 'shift.open',
  shift_id: 'shift-1',
  payload: { shift_id: 'shift-1', opened_at: '2026-05-07T08:00:00.000Z' },
};

describe('operator:emit-audit-event — channel registration', () => {
  it('registers the emit-audit-event channel', () => {
    const { ipcMain, handlers } = makeIpcMain();
    registerOperatorHandlers(ipcMain, {
      signInHandler: fakeSignInHandler(),
      cashierSignInHandler: fakeCashierSignInHandler(),
      signOutHandler: fakeSignOutHandler(),
      rosterHandler: fakeRosterHandler(),
      sessionManager: fakeSessionManager(),
      inactivityMonitor: fakeInactivityMonitor(),
      auditEmitter: fakeAuditEmitter(),
      pairingStore: fakePairingStore(),
      takeoverHandler: fakeTakeoverHandler(),
      pinManagementHandler: fakePinManagementHandler(),
      forcedCloseHandler: fakeForcedCloseHandler(),
      stuckShiftsHandler: fakeStuckShiftsHandler(),
    });
    expect(handlers.has(OPERATOR_IPC_CHANNELS.EMIT_AUDIT_EVENT)).toBe(true);
  });
});

describe('operator:emit-audit-event — not-signed-in gate', () => {
  it('refuses with not_signed_in when no session is active', async () => {
    const { emitAuditEvent } = setup({ sessionManager: fakeSessionManager(null) });
    const res = await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    expect(res).toEqual({ kind: 'refused', category: 'not_signed_in' });
  });
});

describe('operator:emit-audit-event — input validation', () => {
  it('refuses invalid_input when request is not an object', async () => {
    const { emitAuditEvent } = setup();
    for (const bad of [null, undefined, 'string', 42, true]) {
      const res = await emitAuditEvent(FAKE_EVENT, bad);
      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    }
  });

  it('refuses invalid_input when event_id is missing or not a string', async () => {
    const { emitAuditEvent } = setup();
    const res = await emitAuditEvent(FAKE_EVENT, { ...VALID_REQUEST, event_id: 42 });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('refuses invalid_input when action_category is missing or not a string', async () => {
    const { emitAuditEvent } = setup();
    const res = await emitAuditEvent(FAKE_EVENT, {
      event_id: 'evt-1',
      action_category: 99,
      payload: {},
    });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('refuses invalid_input when payload is missing or not an object', async () => {
    const { emitAuditEvent } = setup();
    for (const bad of [null, 'string', 42, undefined]) {
      const res = await emitAuditEvent(FAKE_EVENT, {
        event_id: 'evt-1',
        action_category: 'shift.open',
        payload: bad,
      });
      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    }
  });
});

describe('operator:emit-audit-event — successful emission', () => {
  it('returns { kind: emitted, event_id } on success', async () => {
    const { emitAuditEvent } = setup();
    const res = await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    const expected: EmitAuditEventResponse = { kind: 'emitted', event_id: VALID_REQUEST.event_id };
    expect(res).toEqual(expected);
  });

  it('delegates to AuditEmitter.emit with trusted fields enriched from session', async () => {
    const emitSpy = vi.fn();
    const { emitAuditEvent } = setup({
      auditEmitter: fakeAuditEmitter({ emit: emitSpy }),
    });
    await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    // Trusted fields — set by main, not renderer
    expect(emitted['acting_operator_id']).toBe('op-xyz');
    expect(emitted['tenant_id']).toBe('tenant-1');
    expect(emitted['branch_id']).toBe('branch-1');
    expect(emitted['originating_terminal_id']).toBe('terminal-001');
    expect(emitted['session_id']).toBe('sess-abc');
    // created_at must be a valid ISO timestamp set by main
    expect(typeof emitted['created_at']).toBe('string');
    expect(() => new Date(emitted['created_at'] as string)).not.toThrow();
    // Renderer-supplied fields pass through
    expect(emitted['event_id']).toBe(VALID_REQUEST.event_id);
    expect(emitted['action_category']).toBe(VALID_REQUEST.action_category);
    expect(emitted['shift_id']).toBe(VALID_REQUEST.shift_id);
    expect(emitted['payload']).toEqual(VALID_REQUEST.payload);
  });

  it('sets originating_terminal_id to empty string when terminal is unpaired', async () => {
    const emitSpy = vi.fn();
    const { emitAuditEvent } = setup({
      auditEmitter: fakeAuditEmitter({ emit: emitSpy }),
      pairingStore: fakePairingStore(null),
    });
    await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(emitted['originating_terminal_id']).toBe('');
  });

  it('sets shift_id to null when not provided in request', async () => {
    const emitSpy = vi.fn();
    const { emitAuditEvent } = setup({
      auditEmitter: fakeAuditEmitter({ emit: emitSpy }),
    });
    const reqWithoutShiftId: EmitAuditEventRequest = {
      event_id: 'evt-002',
      action_category: 'operator.session.takeover',
      payload: {
        superseded_session_id: 'sess-old',
        prior_terminal_reference: 'term-ref-1',
      },
    };
    await emitAuditEvent(FAKE_EVENT, reqWithoutShiftId);
    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(emitted['shift_id']).toBeNull();
  });

  it('sets approving_supervisor_id to null when not provided', async () => {
    const emitSpy = vi.fn();
    const { emitAuditEvent } = setup({
      auditEmitter: fakeAuditEmitter({ emit: emitSpy }),
    });
    await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(emitted['approving_supervisor_id']).toBeNull();
  });

  it('passes approving_supervisor_id when provided', async () => {
    const emitSpy = vi.fn();
    const { emitAuditEvent } = setup({
      auditEmitter: fakeAuditEmitter({ emit: emitSpy }),
    });
    const req: EmitAuditEventRequest = {
      ...VALID_REQUEST,
      approving_supervisor_id: 'sup-001',
    };
    await emitAuditEvent(FAKE_EVENT, req);
    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(emitted['approving_supervisor_id']).toBe('sup-001');
  });
});

describe('operator:emit-audit-event — forbidden payload key rejection', () => {
  it('refuses invalid_input when AuditEmitter throws ForbiddenPayloadKeyError', async () => {
    const { emitAuditEvent } = setup({
      auditEmitter: fakeAuditEmitter({
        emit: () => {
          throw new ForbiddenPayloadKeyError('pin');
        },
      }),
    });
    const res = await emitAuditEvent(FAKE_EVENT, {
      ...VALID_REQUEST,
      payload: { pin: '1234' },
    });
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    // The forbidden key name MUST NOT be echoed back
    expect(JSON.stringify(res)).not.toContain('pin');
  });

  it('does not echo forbidden key names in refusal response (defence-in-depth)', async () => {
    for (const forbiddenKey of [
      'password',
      'clerk_jwt',
      'device_token',
      'token',
      'secret',
      'credential',
    ]) {
      const { emitAuditEvent } = setup({
        auditEmitter: fakeAuditEmitter({
          emit: () => {
            throw new ForbiddenPayloadKeyError(forbiddenKey);
          },
        }),
      });
      const res = await emitAuditEvent(FAKE_EVENT, {
        ...VALID_REQUEST,
        payload: { [forbiddenKey]: 'sensitive-value' },
      });
      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
      expect(JSON.stringify(res)).not.toContain(forbiddenKey);
    }
  });
});

describe('operator:emit-audit-event — missing mandatory attribute rejection', () => {
  it('refuses invalid_input when AuditEmitter throws MissingMandatoryAttributeError', async () => {
    const { emitAuditEvent } = setup({
      auditEmitter: fakeAuditEmitter({
        emit: () => {
          throw new MissingMandatoryAttributeError('acting_operator_id');
        },
      }),
    });
    const res = await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
  });
});

describe('operator:emit-audit-event — generic error handling', () => {
  it('refuses invalid_input on unexpected throw (no message echo)', async () => {
    const { emitAuditEvent } = setup({
      auditEmitter: fakeAuditEmitter({
        emit: () => {
          throw new Error('INTERNAL-SECRET-MESSAGE');
        },
      }),
    });
    const res = await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
    expect(JSON.stringify(res)).not.toContain('INTERNAL-SECRET-MESSAGE');
  });
});

describe('operator:emit-audit-event — security invariants', () => {
  it('success response does not contain Clerk JWT fields', async () => {
    const { emitAuditEvent } = setup();
    const res = await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('clerk_jwt');
    expect(serialized).not.toContain('clerk_session_token');
  });

  it('success response does not contain device_token fields', async () => {
    const { emitAuditEvent } = setup();
    const res = await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('device_token');
    expect(serialized).not.toContain('device_token_attestation');
  });

  it('success response does not contain the session backend_session_id', async () => {
    const { emitAuditEvent } = setup();
    const res = await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('backend_session_id');
    expect(serialized).not.toContain('be-sess-1');
  });
});

describe('operator:emit-audit-event — idempotency', () => {
  it('returns emitted for the same event_id on repeat call (idempotent)', async () => {
    const { emitAuditEvent } = setup();
    const res1 = await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    const res2 = await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    expect(res1).toEqual({ kind: 'emitted', event_id: VALID_REQUEST.event_id });
    expect(res2).toEqual({ kind: 'emitted', event_id: VALID_REQUEST.event_id });
  });
});

describe('operator:emit-audit-event — main-only categories (RT-117 §A4 L1)', () => {
  it.each(['operator.session.locked', 'operator.session.unlocked'])(
    'refuses a renderer-forged %s and never emits it',
    async (action_category) => {
      const emit = vi.fn();
      const { emitAuditEvent } = setup({ auditEmitter: fakeAuditEmitter({ emit }) });

      const res = await emitAuditEvent(FAKE_EVENT, {
        ...VALID_REQUEST,
        action_category,
        payload: { lock_cause: 'inactivity' },
      });

      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
      expect(emit).not.toHaveBeenCalled();
    },
  );

  it.each(['pairing.device_revoked', 'pairing.device_revoked_cleared'])(
    'RT-215: refuses a renderer-forged %s (a main-side pairing state change) and never emits it',
    async (action_category) => {
      const emit = vi.fn();
      const { emitAuditEvent } = setup({ auditEmitter: fakeAuditEmitter({ emit }) });

      const res = await emitAuditEvent(FAKE_EVENT, {
        ...VALID_REQUEST,
        action_category,
        payload: { source: 'cashier_admissions' },
      });

      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
      expect(emit).not.toHaveBeenCalled();
    },
  );
});

describe('operator:emit-audit-event — no T051 lifecycle behavior', () => {
  it('does not expose a sign-out, lifecycle cascade, or session-destroy path', async () => {
    const { emitAuditEvent } = setup();
    const res = await emitAuditEvent(FAKE_EVENT, VALID_REQUEST);
    // T048 scope: only emitted or refused. No lifecycle side-effects.
    expect((res as Record<string, unknown>)['kind']).toMatch(/^(emitted|refused)$/);
  });
});
