import { describe, expect, it, vi } from 'vitest';

import { StuckShiftsHandler } from '../../../../src/main/operator/stuck-shifts-handler.js';
import type { StuckShiftsHandlerDeps } from '../../../../src/main/operator/stuck-shifts-handler.js';
import type { BackendClient } from '../../../../src/main/operator/backend-client.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { createJwtHolder } from '../../../../src/main/operator/jwt-holder.js';

/**
 * 004-operator-session T090 — StuckShiftsHandler main-side tests.
 *
 * Verifies:
 *  - Role gate: cashier → role_mismatch, not_signed_in → not_signed_in.
 *  - Happy path: manager session → calls backend with branchId + jwt.
 *  - Admin role is also permitted.
 *  - Backend no_connection → { kind: 'refused', category: 'no_connection' }.
 *  - Backend refused → { kind: 'refused', category: 'invalid_input' }.
 *  - Allowlist: only safe fields cross the bridge (no email, no device_id etc.).
 */

const MANAGER_SESSION: OperatorSessionRecord = {
  id: 'sess-1',
  operator_id: 'op-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-42',
  role: 'manager',
  display_name: 'Ahmed Manager',
  backend_session_id: 'be-sess-1',
  started_at: '2026-05-13T08:00:00.000Z',
  last_activity_at: '2026-05-13T08:00:00.000Z',
};

const CASHIER_SESSION: OperatorSessionRecord = {
  ...MANAGER_SESSION,
  id: 'sess-2',
  role: 'cashier',
};

const ADMIN_SESSION: OperatorSessionRecord = {
  ...MANAGER_SESSION,
  id: 'sess-3',
  role: 'admin',
};

const SAMPLE_STUCK_SHIFTS = [
  {
    shift_id: 'shift-111',
    cashier_display_name: 'Nour Al-Hassan',
    terminal_label: 'Terminal 3',
    opened_at: '2026-05-12T08:30:00.000Z',
    duration_minutes: 47,
  },
];

function fakeBackend(
  result: Awaited<ReturnType<BackendClient['getStuckShifts']>>,
  calls: { branchId?: string; jwt?: string }[] = [],
): BackendClient {
  return {
    signIn: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    signOut: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    listRoster: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    confirmTakeover: vi.fn(() => Promise.resolve({ kind: 'refused' as const })),
    getStuckShifts: vi.fn((branchId: string, jwt: string) => {
      calls.push({ branchId, jwt });
      return Promise.resolve(result);
    }),
  };
}

function makeDeps(
  session: OperatorSessionRecord | null,
  backendResult: Awaited<ReturnType<BackendClient['getStuckShifts']>>,
  calls?: { branchId?: string; jwt?: string }[],
  jwtForSession?: string,
): StuckShiftsHandlerDeps {
  const jwtHolder = createJwtHolder();
  if (session !== null && jwtForSession !== undefined) {
    jwtHolder.set(session.backend_session_id, jwtForSession);
  }
  return {
    sessionManager: { getCurrent: () => session },
    backendClient: fakeBackend(backendResult, calls),
    jwtHolder,
  };
}

describe('StuckShiftsHandler — role gate', () => {
  it('returns not_signed_in when no session', async () => {
    const handler = new StuckShiftsHandler(
      makeDeps(null, { kind: 'ok', shifts: SAMPLE_STUCK_SHIFTS }),
    );
    const res = await handler.listStuckShifts();
    expect(res).toEqual({ kind: 'refused', category: 'not_signed_in' });
  });

  it('returns role_mismatch for cashier session', async () => {
    const handler = new StuckShiftsHandler(
      makeDeps(CASHIER_SESSION, { kind: 'ok', shifts: SAMPLE_STUCK_SHIFTS }),
    );
    const res = await handler.listStuckShifts();
    expect(res).toEqual({ kind: 'refused', category: 'role_mismatch' });
  });

  it('permits manager session', async () => {
    const handler = new StuckShiftsHandler(
      makeDeps(MANAGER_SESSION, { kind: 'ok', shifts: SAMPLE_STUCK_SHIFTS }),
    );
    const res = await handler.listStuckShifts();
    expect(res.kind).toBe('stuck_shifts');
  });

  it('permits admin session', async () => {
    const handler = new StuckShiftsHandler(
      makeDeps(ADMIN_SESSION, { kind: 'ok', shifts: SAMPLE_STUCK_SHIFTS }),
    );
    const res = await handler.listStuckShifts();
    expect(res.kind).toBe('stuck_shifts');
  });
});

describe('StuckShiftsHandler — backend forwarding', () => {
  it('calls backend with session branchId and jwt from jwtHolder', async () => {
    const calls: { branchId?: string; jwt?: string }[] = [];
    const handler = new StuckShiftsHandler(
      makeDeps(MANAGER_SESSION, { kind: 'ok', shifts: SAMPLE_STUCK_SHIFTS }, calls, 'jwt-tok'),
    );
    await handler.listStuckShifts();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.branchId).toBe('branch-42');
    expect(calls[0]?.jwt).toBe('jwt-tok');
  });

  it('maps backend no_connection → refused/no_connection', async () => {
    const handler = new StuckShiftsHandler(makeDeps(MANAGER_SESSION, { kind: 'no_connection' }));
    const res = await handler.listStuckShifts();
    expect(res).toEqual({ kind: 'refused', category: 'no_connection' });
  });

  it('maps backend refused → refused/invalid_input', async () => {
    const handler = new StuckShiftsHandler(makeDeps(MANAGER_SESSION, { kind: 'refused' }));
    const res = await handler.listStuckShifts();
    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
  });
});

describe('StuckShiftsHandler — allowlist / field redaction', () => {
  it('happy path: returns stuck_shifts with only safe fields', async () => {
    const handler = new StuckShiftsHandler(
      makeDeps(MANAGER_SESSION, { kind: 'ok', shifts: SAMPLE_STUCK_SHIFTS }),
    );
    const res = await handler.listStuckShifts();
    expect(res.kind).toBe('stuck_shifts');
    if (res.kind === 'stuck_shifts') {
      expect(res.shifts).toHaveLength(1);
      expect(res.shifts[0]).toEqual({
        shift_id: 'shift-111',
        cashier_display_name: 'Nour Al-Hassan',
        terminal_label: 'Terminal 3',
        opened_at: '2026-05-12T08:30:00.000Z',
        duration_minutes: 47,
      });
    }
  });

  it('strips extra backend fields not in allowlist', async () => {
    const leakyShifts = [
      {
        shift_id: 'shift-222',
        cashier_display_name: 'Test',
        terminal_label: 'T1',
        opened_at: '2026-05-12T08:00:00.000Z',
        duration_minutes: 10,
        // Extra fields that must not cross the bridge
        branch_id: 'branch-secret',
        tenant_id: 'tenant-secret',
        cashier_clerk_id: 'user_abc123',
      },
    ] as unknown as typeof SAMPLE_STUCK_SHIFTS;

    const handler = new StuckShiftsHandler(
      makeDeps(MANAGER_SESSION, { kind: 'ok', shifts: leakyShifts }),
    );
    const res = await handler.listStuckShifts();
    if (res.kind === 'stuck_shifts') {
      const shift = res.shifts[0];
      expect(shift).not.toHaveProperty('branch_id');
      expect(shift).not.toHaveProperty('tenant_id');
      expect(shift).not.toHaveProperty('cashier_clerk_id');
    }
  });

  it('accepts an empty shifts array', async () => {
    const handler = new StuckShiftsHandler(makeDeps(MANAGER_SESSION, { kind: 'ok', shifts: [] }));
    const res = await handler.listStuckShifts();
    expect(res).toEqual({ kind: 'stuck_shifts', shifts: [] });
  });
});
