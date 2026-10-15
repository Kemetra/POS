/**
 * T062 — Integration test: PR-3 manager unlock flow.
 *
 * Exercises the full IPC path: `registerOperatorHandlers` registers the
 * `operator:unlock-cashier` channel; the handler validates role, input
 * shape, and terminal scope; clears lockout state; emits `cashier.pin.unlock`
 * audit event with manager attribution.
 *
 * Renderer UI (T078) is NOT implemented yet — this test targets the
 * main-process side of the bridge only (IPC channel + PinManagementHandler).
 *
 * Security assertions (PR-1):
 *   - This call MUST NOT accept any PIN field — it only clears lockout state.
 *   - Audit payload contains only allowlisted fields (no PIN, no hash).
 *   - Manager attribution is correct.
 *
 * Contract for state_invalid:
 *   - Returns state_invalid when cashier is already unlocked.
 *   - Still emits the cashier.pin.unlock audit event (support trail).
 */

import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerOperatorHandlers } from '../../../src/main/ipc/operator.js';
import { PinManagementHandler } from '../../../src/main/operator/pin-management.js';
import { OPERATOR_IPC_CHANNELS } from '../../../src/shared/operator/channels.js';
import type { UnlockCashierResponse } from '../../../src/shared/bridge-api.js';
import type { OperatorRefusal, AuditEvent } from '../../../src/shared/audit/event-shape.js';
import type { SessionManager } from '../../../src/main/operator/session-manager.js';
import type { OperatorSessionRecord } from '../../../src/main/operator/session-manager.js';
import type { PairingStore } from '../../../src/main/pairing/store.js';
import type { AuditEmitter } from '../../../src/main/audit/audit-emitter.js';
import type { DatabaseHandle } from '../../../src/main/db/client.js';
import type { SafeStorageLike } from '../../../src/main/secrets/safe-storage.js';
import type {
  SignInHandler,
  CashierSignInHandler,
} from '../../../src/main/operator/sign-in-handler.js';
import type { SignOutHandler } from '../../../src/main/operator/sign-out-handler.js';
import type { RosterHandler } from '../../../src/main/operator/roster-handler.js';
import type { InactivityMonitor } from '../../../src/main/operator/inactivity-monitor.js';
import type { TakeoverHandler } from '../../../src/main/operator/takeover-handler.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const TENANT = 't1';
const BRANCH = 'b1';
const TERMINAL = 'term-1';
const CASHIER_ID = 'cashier-clerk-01';
const MANAGER_OP_ID = 'manager-clerk-01';
const SESSION_ID = 'sess-unlock';

function makeManagerSession(): OperatorSessionRecord {
  return {
    id: SESSION_ID,
    operator_id: MANAGER_OP_ID,
    display_name: 'Manager',
    role: 'manager',
    tenant_id: TENANT,
    branch_id: BRANCH,
    backend_session_id: 'be-1',
    started_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  };
}

function makePairedStore(): PairingStore {
  return {
    getStatus: vi.fn(() =>
      Promise.resolve({
        kind: 'paired' as const,
        tenant_id: TENANT,
        branch_id: BRANCH,
        terminal_id: TERMINAL,
        terminal_label: 'T1',
        paired_at: 0,
      }),
    ),
    persist: vi.fn(),
    clear: vi.fn(),
  };
}

function makeDb(lockout_until: string | null, no_row = false): DatabaseHandle {
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.trimStart().toUpperCase().startsWith('SELECT')) {
        return {
          get: () =>
            no_row
              ? undefined
              : { failed_attempt_count: lockout_until !== null ? 5 : 0, lockout_until },
        };
      }
      return { run: vi.fn() };
    }),
    pragma: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
}

function makeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(s, 'utf8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8')),
  };
}

function makeIpcMain(): {
  ipcMain: IpcMain;
  handlers: Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>;
} {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((ch: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      handlers.set(ch, fn);
    }),
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

const FAKE_EVENT = {} as IpcMainInvokeEvent;

function buildEnv(
  opts: {
    lockout_until?: string | null;
    session?: OperatorSessionRecord | null;
  } = {},
): {
  invoke: (channel: string, req: unknown) => Promise<unknown>;
  emit: ReturnType<typeof vi.fn>;
} {
  const session = opts.session !== undefined ? opts.session : makeManagerSession();
  const lockout_until = opts.lockout_until !== undefined ? opts.lockout_until : null;
  const emit = vi.fn();
  const auditEmitter: AuditEmitter = { emit } as unknown as AuditEmitter;
  const db = makeDb(lockout_until);
  const pinManagementHandler = new PinManagementHandler({
    db,
    safeStorage: makeStorage(),
    sessionManager: { getCurrent: vi.fn(() => session) } as unknown as SessionManager,
    pairingStore: makePairedStore(),
    auditEmitter,
  });

  const { ipcMain, handlers } = makeIpcMain();
  registerOperatorHandlers(ipcMain, {
    signInHandler: { signIn: vi.fn() } as unknown as SignInHandler,
    cashierSignInHandler: { signIn: vi.fn() } as unknown as CashierSignInHandler,
    signOutHandler: { signOut: vi.fn() } as unknown as SignOutHandler,
    rosterHandler: { listRoster: vi.fn() } as unknown as RosterHandler,
    sessionManager: {
      getCurrent: vi.fn(() => session),
      getCurrentBridgeView: vi.fn(() => null),
    } as unknown as SessionManager,
    inactivityMonitor: { reportActivity: vi.fn() } as unknown as InactivityMonitor,
    auditEmitter,
    pairingStore: makePairedStore(),
    takeoverHandler: {
      confirmTakeover: vi.fn(),
      cancelTakeover: vi.fn(),
    } as unknown as TakeoverHandler,
    pinManagementHandler,
  });

  const invoke = (channel: string, req: unknown): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`channel not registered: ${channel}`);
    return Promise.resolve(fn(FAKE_EVENT, req));
  };

  return { invoke, emit };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('T062 — operator:unlock-cashier IPC (manager unlock integration)', () => {
  it('channel is registered', () => {
    const { ipcMain, handlers } = makeIpcMain();
    const pinManagementHandler = new PinManagementHandler({
      db: makeDb(null),
      safeStorage: makeStorage(),
      sessionManager: {
        getCurrent: vi.fn(() => makeManagerSession()),
      } as unknown as SessionManager,
      pairingStore: makePairedStore(),
      auditEmitter: { emit: vi.fn() } as unknown as AuditEmitter,
    });
    registerOperatorHandlers(ipcMain, {
      signInHandler: { signIn: vi.fn() } as unknown as SignInHandler,
      cashierSignInHandler: { signIn: vi.fn() } as unknown as CashierSignInHandler,
      signOutHandler: { signOut: vi.fn() } as unknown as SignOutHandler,
      rosterHandler: { listRoster: vi.fn() } as unknown as RosterHandler,
      sessionManager: {
        getCurrent: vi.fn(() => makeManagerSession()),
        getCurrentBridgeView: vi.fn(() => null),
      } as unknown as SessionManager,
      inactivityMonitor: { reportActivity: vi.fn() } as unknown as InactivityMonitor,
      auditEmitter: { emit: vi.fn() } as unknown as AuditEmitter,
      pairingStore: makePairedStore(),
      takeoverHandler: {
        confirmTakeover: vi.fn(),
        cancelTakeover: vi.fn(),
      } as unknown as TakeoverHandler,
      pinManagementHandler,
    });
    expect(handlers.has(OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER)).toBe(true);
  });

  it('returns unlocked and emits cashier.pin.unlock when cashier is actively locked out', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const { invoke, emit } = buildEnv({ lockout_until: future });
    const event_id = randomUUID();
    const result = (await invoke(OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER, {
      event_id,
      target_cashier_id: CASHIER_ID,
    })) as UnlockCashierResponse;
    expect(result.kind).toBe('unlocked');
    expect(result.audit_event_id).toBe(event_id);

    expect(emit).toHaveBeenCalledOnce();
    const evt = emit.mock.calls[0][0] as AuditEvent;
    expect(evt.action_category).toBe('cashier.pin.unlock');
    expect(evt.acting_operator_id).toBe(MANAGER_OP_ID);
  });

  it('returns state_invalid (and still emits audit) when cashier is not locked out', async () => {
    const { invoke, emit } = buildEnv({ lockout_until: null });
    const result = (await invoke(OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER, {
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
    })) as OperatorRefusal;
    expect(result).toMatchObject({ kind: 'refused', category: 'state_invalid' });
    // Support trail — audit event is still emitted
    expect(emit).toHaveBeenCalledOnce();
    const evt = emit.mock.calls[0][0] as AuditEvent;
    expect(evt.action_category).toBe('cashier.pin.unlock');
  });

  it('lockout clears after unlock — failed_attempt_count reset to 0', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const runCalls: unknown[][] = [];
    const db: DatabaseHandle = {
      prepare: vi.fn((sql: string) => {
        if (sql.trimStart().toUpperCase().startsWith('SELECT')) {
          return { get: () => ({ failed_attempt_count: 5, lockout_until: future }) };
        }
        return {
          run: (...args: unknown[]) => {
            runCalls.push(args);
          },
        };
      }),
      pragma: vi.fn(),
      exec: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    };
    const emit = vi.fn();
    const handler = new PinManagementHandler({
      db,
      safeStorage: makeStorage(),
      sessionManager: {
        getCurrent: vi.fn(() => makeManagerSession()),
      } as unknown as SessionManager,
      pairingStore: makePairedStore(),
      auditEmitter: { emit } as unknown as AuditEmitter,
    });
    await handler.unlockCashier({ event_id: randomUUID(), target_cashier_id: CASHIER_ID });
    // UPDATE must have been called with 0 for failed_attempt_count and NULL for lockout_until
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toContain(0); // failed_attempt_count = 0
    expect(runCalls[0]).toContain(null); // lockout_until = NULL
  });

  it('returns role_mismatch when caller is a cashier session', async () => {
    const cashierSession: OperatorSessionRecord = {
      ...makeManagerSession(),
      role: 'cashier',
      operator_id: CASHIER_ID,
    };
    const { invoke } = buildEnv({ session: cashierSession });
    const result = (await invoke(OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER, {
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
    })) as OperatorRefusal;
    expect(result).toMatchObject({ kind: 'refused', category: 'role_mismatch' });
  });

  it('returns invalid_input on malformed IPC payload (missing event_id)', async () => {
    const { invoke } = buildEnv();
    const result = (await invoke(OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER, {
      // event_id absent
      target_cashier_id: CASHIER_ID,
    })) as OperatorRefusal;
    expect(result).toMatchObject({ kind: 'refused', category: 'invalid_input' });
  });

  it('audit payload does not contain any PIN field (PR-1)', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const { invoke, emit } = buildEnv({ lockout_until: future });
    await invoke(OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER, {
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
    });
    const evt = emit.mock.calls[0][0] as AuditEvent;
    const payloadKeys = Object.keys(evt.payload);
    expect(payloadKeys).not.toContain('pin');
    expect(payloadKeys).not.toContain('new_pin');
    expect(payloadKeys).not.toContain('pin_hash');
    expect(payloadKeys).not.toContain('pin_salt');
  });

  it('manager operator_id is attributed in the audit event', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const { invoke, emit } = buildEnv({ lockout_until: future });
    await invoke(OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER, {
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
    });
    const evt = emit.mock.calls[0][0] as AuditEvent;
    expect(evt.acting_operator_id).toBe(MANAGER_OP_ID);
  });

  it('works for admin role', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const adminSession: OperatorSessionRecord = { ...makeManagerSession(), role: 'admin' };
    const { invoke } = buildEnv({ lockout_until: future, session: adminSession });
    const result = (await invoke(OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER, {
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
    })) as UnlockCashierResponse;
    expect(result.kind).toBe('unlocked');
  });
});
