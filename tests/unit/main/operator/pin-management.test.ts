import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { PinManagementHandler } from '../../../../src/main/operator/pin-management.js';
import type { PinManagementHandlerDeps } from '../../../../src/main/operator/pin-management.js';
import type { SessionManager } from '../../../../src/main/operator/session-manager.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import type { PairingStore } from '../../../../src/main/pairing/store.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import type { SafeStorageLike } from '../../../../src/main/secrets/safe-storage.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const TENANT = 't1';
const BRANCH = 'b1';
const TERMINAL = 'term-1';
const CASHIER_ID = 'cashier-clerk-01';
const MANAGER_OP_ID = 'manager-clerk-01';
const SESSION_ID = 'sess-abc';

function makeManagerSession(): OperatorSessionRecord {
  return {
    id: SESSION_ID,
    operator_id: MANAGER_OP_ID,
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: TENANT,
    branch_id: BRANCH,
    backend_session_id: 'be-sess-1',
    started_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  };
}

function makeCashierSession(): OperatorSessionRecord {
  return {
    id: 'sess-cashier',
    operator_id: CASHIER_ID,
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: TENANT,
    branch_id: BRANCH,
    backend_session_id: '',
    started_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  };
}

function makeSessionManager(session: OperatorSessionRecord | null): SessionManager {
  return { getCurrent: vi.fn(() => session) } as unknown as SessionManager;
}

function makePairedStore(terminal_id = TERMINAL): PairingStore {
  return {
    getStatus: vi.fn(() =>
      Promise.resolve({
        kind: 'paired' as const,
        tenant_id: TENANT,
        branch_id: BRANCH,
        terminal_id,
        terminal_label: 'T1',
        paired_at: 0,
      }),
    ),
    persist: vi.fn(),
    clear: vi.fn(),
  };
}

function makeUnpairedStore(): PairingStore {
  return {
    getStatus: vi.fn(() => Promise.resolve({ kind: 'unpaired' as const })),
    persist: vi.fn(),
    clear: vi.fn(),
  };
}

function makeAuditEmitter(): { emitter: AuditEmitter; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  return { emitter: { emit } as unknown as AuditEmitter, emit };
}

/** Build a fake DatabaseHandle that returns a preset row for SELECT and records UPDATE calls. */
function makeDb(
  existingRow: { failed_attempt_count: number; lockout_until: string | null } | undefined,
): {
  db: DatabaseHandle;
  runCalls: { sql: string; args: unknown[] }[];
  getCalls: { sql: string; args: unknown[] }[];
} {
  const runCalls: { sql: string; args: unknown[] }[] = [];
  const getCalls: { sql: string; args: unknown[] }[] = [];

  const db: DatabaseHandle = {
    prepare: vi.fn((sql: string) => {
      if (sql.trimStart().toUpperCase().startsWith('SELECT')) {
        return {
          get: (...args: unknown[]) => {
            getCalls.push({ sql, args });
            return existingRow;
          },
        };
      }
      return {
        run: (...args: unknown[]) => {
          runCalls.push({ sql, args });
        },
      };
    }),
    pragma: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };

  return { db, runCalls, getCalls };
}

/** Identity safeStorage — stores/retrieves bytes as-is (test environment has no DPAPI). */
function makePassthroughStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(s, 'utf8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8')),
  };
}

function makeDeps(
  overrides: Partial<PinManagementHandlerDeps> = {},
): PinManagementHandlerDeps & { emit: ReturnType<typeof vi.fn> } {
  const { emitter, emit } = makeAuditEmitter();
  return {
    db: makeDb({ failed_attempt_count: 0, lockout_until: null }).db,
    safeStorage: makePassthroughStorage(),
    sessionManager: makeSessionManager(makeManagerSession()),
    pairingStore: makePairedStore(),
    auditEmitter: emitter,
    ...overrides,
    emit,
  };
}

// ─── resetCashierPin — T072 ────────────────────────────────────────────────

describe('PinManagementHandler.resetCashierPin', () => {
  it('refuses with role_mismatch when caller is a cashier', async () => {
    const deps = makeDeps({ sessionManager: makeSessionManager(makeCashierSession()) });
    const handler = new PinManagementHandler(deps);
    const result = await handler.resetCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
      new_pin: '1234',
    });
    expect(result).toMatchObject({ kind: 'refused', category: 'role_mismatch' });
  });

  it('refuses with not_signed_in when no session is active', async () => {
    const deps = makeDeps({ sessionManager: makeSessionManager(null) });
    const handler = new PinManagementHandler(deps);
    const result = await handler.resetCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
      new_pin: '1234',
    });
    expect(result).toMatchObject({ kind: 'refused', category: 'not_signed_in' });
  });

  it.each([
    { name: 'is too short (3 digits)', new_pin: '123' },
    { name: 'is too long (7 digits)', new_pin: '1234567' },
    { name: 'contains non-digits', new_pin: '12ab' },
  ])('refuses with invalid_input when new_pin $name', async ({ new_pin }) => {
    const deps = makeDeps();
    const handler = new PinManagementHandler(deps);
    const result = await handler.resetCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
      new_pin,
    });
    expect(result).toMatchObject({ kind: 'refused', category: 'invalid_input' });
  });

  it('refuses with invalid_input when target_cashier_id has no pin record on this terminal', async () => {
    const { db } = makeDb(undefined);
    const deps = makeDeps({ db });
    const handler = new PinManagementHandler(deps);
    const result = await handler.resetCashierPin({
      event_id: randomUUID(),
      target_cashier_id: 'unknown-cashier',
      new_pin: '4321',
    });
    expect(result).toMatchObject({ kind: 'refused', category: 'invalid_input' });
  });

  it('refuses with invalid_input when terminal is unpaired', async () => {
    const deps = makeDeps({ pairingStore: makeUnpairedStore() });
    const handler = new PinManagementHandler(deps);
    const result = await handler.resetCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
      new_pin: '1234',
    });
    expect(result).toMatchObject({ kind: 'refused', category: 'invalid_input' });
  });

  it('succeeds and returns pin_reset with the audit_event_id', async () => {
    const deps = makeDeps();
    const handler = new PinManagementHandler(deps);
    const event_id = randomUUID();
    const result = await handler.resetCashierPin({
      event_id,
      target_cashier_id: CASHIER_ID,
      new_pin: '5678',
    });
    expect(result).toMatchObject({ kind: 'pin_reset', audit_event_id: event_id });
  });

  it('emits cashier.pin.reset audit event with manager attribution and no PIN value', async () => {
    const { emitter, emit } = makeAuditEmitter();
    const deps = makeDeps({ auditEmitter: emitter });
    const handler = new PinManagementHandler(deps);
    const event_id = randomUUID();
    await handler.resetCashierPin({ event_id, target_cashier_id: CASHIER_ID, new_pin: '9999' });

    expect(emit).toHaveBeenCalledOnce();
    const emitted = emit.mock.calls[0][0] as AuditEvent;
    expect(emitted.action_category).toBe('cashier.pin.reset');
    expect(emitted.acting_operator_id).toBe(MANAGER_OP_ID);
    expect(emitted.event_id).toBe(event_id);
    expect(emitted.originating_terminal_id).toBe(TERMINAL);

    // PR-1: PIN value MUST NOT appear anywhere in the emitted event
    const serialised = JSON.stringify(emitted);
    expect(serialised).not.toContain('9999');
    expect(serialised).not.toContain('new_pin');

    // Payload must contain target_cashier_id and terminal_id — nothing else
    expect(emitted.payload).toMatchObject({ target_cashier_id: CASHIER_ID, terminal_id: TERMINAL });
    expect(Object.keys(emitted.payload)).toHaveLength(2);
  });

  it('works for admin role (not manager-only)', async () => {
    const adminSession: OperatorSessionRecord = { ...makeManagerSession(), role: 'admin' };
    const deps = makeDeps({ sessionManager: makeSessionManager(adminSession) });
    const handler = new PinManagementHandler(deps);
    const result = await handler.resetCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
      new_pin: '1234',
    });
    expect(result).toMatchObject({ kind: 'pin_reset' });
  });

  it('accepts 6-digit PIN', async () => {
    const deps = makeDeps();
    const handler = new PinManagementHandler(deps);
    const result = await handler.resetCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
      new_pin: '123456',
    });
    expect(result).toMatchObject({ kind: 'pin_reset' });
  });

  it('does not log PIN value in any audit or log output', async () => {
    const loggedMessages: unknown[] = [];
    const fakeLogger = {
      info: vi.fn((...args: unknown[]) => loggedMessages.push(args)),
      warn: vi.fn((...args: unknown[]) => loggedMessages.push(args)),
    };
    const deps = makeDeps({ logger: fakeLogger as never });
    const handler = new PinManagementHandler(deps);
    await handler.resetCashierPin({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
      new_pin: '7777',
    });
    const logText = JSON.stringify(loggedMessages);
    expect(logText).not.toContain('7777');
    expect(logText).not.toContain('new_pin');
  });
});

// ─── unlockCashier — T073 ─────────────────────────────────────────────────

describe('PinManagementHandler.unlockCashier', () => {
  it('refuses with role_mismatch when caller is a cashier', async () => {
    const deps = makeDeps({ sessionManager: makeSessionManager(makeCashierSession()) });
    const handler = new PinManagementHandler(deps);
    const result = await handler.unlockCashier({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
    });
    expect(result).toMatchObject({ kind: 'refused', category: 'role_mismatch' });
  });

  it('refuses with not_signed_in when no session', async () => {
    const deps = makeDeps({ sessionManager: makeSessionManager(null) });
    const handler = new PinManagementHandler(deps);
    const result = await handler.unlockCashier({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
    });
    expect(result).toMatchObject({ kind: 'refused', category: 'not_signed_in' });
  });

  it('refuses with invalid_input when terminal is unpaired', async () => {
    const deps = makeDeps({ pairingStore: makeUnpairedStore() });
    const handler = new PinManagementHandler(deps);
    const result = await handler.unlockCashier({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
    });
    expect(result).toMatchObject({ kind: 'refused', category: 'invalid_input' });
  });

  it('returns state_invalid (and emits audit event) when cashier is not locked out', async () => {
    // Row exists but lockout_until is null → not locked
    const { db } = makeDb({ failed_attempt_count: 0, lockout_until: null });
    const { emitter, emit } = makeAuditEmitter();
    const deps = makeDeps({ db, auditEmitter: emitter });
    const handler = new PinManagementHandler(deps);
    const event_id = randomUUID();
    const result = await handler.unlockCashier({ event_id, target_cashier_id: CASHIER_ID });

    // state_invalid per contract (already unlocked)
    expect(result).toMatchObject({ kind: 'refused', category: 'state_invalid' });
    // Audit event still emitted (support trail)
    expect(emit).toHaveBeenCalledOnce();
    const emitted = emit.mock.calls[0][0] as AuditEvent;
    expect(emitted.action_category).toBe('cashier.pin.unlock');
  });

  it('returns state_invalid when lockout_until is in the past (expired lockout)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { db } = makeDb({ failed_attempt_count: 5, lockout_until: past });
    const { emitter, emit } = makeAuditEmitter();
    const deps = makeDeps({ db, auditEmitter: emitter });
    const handler = new PinManagementHandler(deps);
    const result = await handler.unlockCashier({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
    });
    expect(result).toMatchObject({ kind: 'refused', category: 'state_invalid' });
    expect(emit).toHaveBeenCalledOnce();
  });

  it('succeeds and returns unlocked when cashier is actively locked out', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const { db } = makeDb({ failed_attempt_count: 5, lockout_until: future });
    const { emitter } = makeAuditEmitter();
    const deps = makeDeps({ db, auditEmitter: emitter });
    const handler = new PinManagementHandler(deps);
    const event_id = randomUUID();
    const result = await handler.unlockCashier({ event_id, target_cashier_id: CASHIER_ID });
    expect(result).toMatchObject({ kind: 'unlocked', audit_event_id: event_id });
  });

  it('emits cashier.pin.unlock audit event with manager attribution', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const { db } = makeDb({ failed_attempt_count: 5, lockout_until: future });
    const { emitter, emit } = makeAuditEmitter();
    const deps = makeDeps({ db, auditEmitter: emitter });
    const handler = new PinManagementHandler(deps);
    const event_id = randomUUID();
    await handler.unlockCashier({ event_id, target_cashier_id: CASHIER_ID });

    expect(emit).toHaveBeenCalledOnce();
    const emitted = emit.mock.calls[0][0] as AuditEvent;
    expect(emitted.action_category).toBe('cashier.pin.unlock');
    expect(emitted.acting_operator_id).toBe(MANAGER_OP_ID);
    expect(emitted.event_id).toBe(event_id);
    expect(emitted.originating_terminal_id).toBe(TERMINAL);
    expect(emitted.payload).toMatchObject({ target_cashier_id: CASHIER_ID, terminal_id: TERMINAL });
  });

  it('audit payload contains no PIN fields', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const { db } = makeDb({ failed_attempt_count: 5, lockout_until: future });
    const { emitter, emit } = makeAuditEmitter();
    const deps = makeDeps({ db, auditEmitter: emitter });
    const handler = new PinManagementHandler(deps);
    await handler.unlockCashier({ event_id: randomUUID(), target_cashier_id: CASHIER_ID });

    const emitted = emit.mock.calls[0][0] as AuditEvent;
    const payloadKeys = Object.keys(emitted.payload);
    expect(payloadKeys).not.toContain('pin');
    expect(payloadKeys).not.toContain('new_pin');
    expect(payloadKeys).not.toContain('pin_hash');
    expect(payloadKeys).not.toContain('pin_salt');
  });

  it('works for admin role', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const { db } = makeDb({ failed_attempt_count: 5, lockout_until: future });
    const adminSession: OperatorSessionRecord = { ...makeManagerSession(), role: 'admin' };
    const deps = makeDeps({ db, sessionManager: makeSessionManager(adminSession) });
    const handler = new PinManagementHandler(deps);
    const result = await handler.unlockCashier({
      event_id: randomUUID(),
      target_cashier_id: CASHIER_ID,
    });
    expect(result).toMatchObject({ kind: 'unlocked' });
  });

  it('state_invalid path still emits audit event even when no DB row exists', async () => {
    const { db } = makeDb(undefined);
    const { emitter, emit } = makeAuditEmitter();
    const deps = makeDeps({ db, auditEmitter: emitter });
    const handler = new PinManagementHandler(deps);
    const result = await handler.unlockCashier({
      event_id: randomUUID(),
      target_cashier_id: 'unknown-cashier',
    });
    expect(result).toMatchObject({ kind: 'refused', category: 'state_invalid' });
    expect(emit).toHaveBeenCalledOnce();
  });
});
