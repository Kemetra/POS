import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CashierAdmissionKeeper,
  SAFE_POINT_RECHECK_MS,
  heartbeatIntervalMs,
} from '../../../../src/main/operator/cashier-admission-keeper.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import { LifecycleCascade } from '../../../../src/main/operator/lifecycle-cascade.js';
import { SignOutHandler } from '../../../../src/main/operator/sign-out-handler.js';
import type { BackendClient } from '../../../../src/main/operator/backend-client.js';
import type { CashierAdmissionResult } from '../../../../src/main/operator/cashier-admission-client.js';
import {
  ADMITTED,
  FAKE_ADMISSION_ID,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

import { contractErrors } from './__helpers__/openapi-schema.js';

/**
 * RT-113 P2 — the online cashier admission heartbeat and end (BC1 contract:
 * "an online-confirmed session MUST re-call this operation with mode online,
 * takeover false and a fresh idempotency_key at an interval of at most half of
 * admission_ttl_seconds from the latest admitted response").
 */

const TTL_S = 600; // 10 min → heartbeat every 5 min
const HALF_TTL_MS = (TTL_S * 1000) / 2;

interface Harness {
  sessions: SessionManager;
  keeper: CashierAdmissionKeeper;
  fake: ReturnType<typeof fakeCashierAdmission>;
  accountDisabled: ReturnType<typeof vi.fn>;
  safe: { value: boolean };
  logs: unknown[];
}

function harness(): Harness {
  const sessions = new SessionManager();
  const fake = fakeCashierAdmission({ ...ADMITTED, admission_ttl_seconds: TTL_S });
  const cascade = new LifecycleCascade({ sessionManager: sessions });
  // The RT-138 device-revoked handling ends the session terminal_session_terminated.
  fake.deps.onDeviceRevoked = vi.fn(() => {
    cascade.notifyTerminalRevoked();
  });
  fake.deviceRevoked = fake.deps.onDeviceRevoked as ReturnType<typeof vi.fn>;
  const accountDisabled = vi.fn(() => {
    cascade.notifyAccountDisabled();
  });
  const safe = { value: true };
  const logs: unknown[] = [];
  const logger = {
    info: (...a: unknown[]) => logs.push(a),
    warn: (...a: unknown[]) => logs.push(a),
    error: (...a: unknown[]) => logs.push(a),
  } as unknown as NonNullable<ConstructorParameters<typeof CashierAdmissionKeeper>[0]['logger']>;
  const keeper = new CashierAdmissionKeeper({
    sessionManager: sessions,
    admission: fake.deps,
    onAccountDisabled: accountDisabled,
    isAtSafePoint: () => safe.value,
    logger,
  });
  return { sessions, keeper, fake, accountDisabled, safe, logs };
}

function signInCashier(
  sessions: SessionManager,
  ttl = TTL_S,
): ReturnType<SessionManager['create']> {
  return sessions.create({
    operator_id: 'user_clerk_1',
    display_name: 'Mona',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    cashier_admission: {
      user_id: FAKE_USER_ID,
      admission_id: FAKE_ADMISSION_ID,
      admission_ttl_seconds: ttl,
      offline_grace_seconds: 86_400,
    },
  });
}

/** Advance fake time and let the awaited admit() settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('heartbeatIntervalMs', () => {
  it('is half the TTL, in ms', () => {
    expect(heartbeatIntervalMs(43_200)).toBe(21_600_000);
    expect(heartbeatIntervalMs(600)).toBe(300_000);
    expect(heartbeatIntervalMs(1)).toBe(500);
  });
});

describe('heartbeat cadence', () => {
  it('first heartbeat fires at TTL/2 after sign-in, never earlier', async () => {
    const h = harness();
    signInCashier(h.sessions);
    await advance(HALF_TTL_MS - 1);
    expect(h.fake.admitCalls).toHaveLength(0);
    await advance(1);
    expect(h.fake.admitCalls).toHaveLength(1);
  });

  it('every heartbeat is mode online, takeover false, same user, a FRESH key — valid per contract', async () => {
    const h = harness();
    signInCashier(h.sessions);
    await advance(HALF_TTL_MS * 3);
    expect(h.fake.admitCalls).toHaveLength(3);
    for (const call of h.fake.admitCalls) {
      expect(call).toMatchObject({ mode: 'online', user_id: FAKE_USER_ID, takeover: false });
      expect(contractErrors('PosCashierAdmissionRequest', call)).toEqual([]);
    }
    const keys = h.fake.admitCalls.map((c) => c.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the interval follows the TTL of the LATEST admitted response', async () => {
    const h = harness();
    signInCashier(h.sessions);
    h.fake.setAdmit({ ...ADMITTED, admission_ttl_seconds: 60 }); // server policy changed
    await advance(HALF_TTL_MS);
    expect(h.fake.admitCalls).toHaveLength(1);
    expect(h.sessions.getCurrent()?.admission_ttl_seconds).toBe(60);
    await advance(29_999);
    expect(h.fake.admitCalls).toHaveLength(1);
    await advance(1);
    expect(h.fake.admitCalls).toHaveLength(2);
  });

  it('a manager session (no admission) never heartbeats', async () => {
    const h = harness();
    h.sessions.create({
      operator_id: 'mgr',
      display_name: 'M',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'be',
    });
    await advance(HALF_TTL_MS * 4);
    expect(h.fake.admitCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('heartbeat outcomes', () => {
  it('admitted with the same admission_id renews and keeps the session', async () => {
    const h = harness();
    const record = signInCashier(h.sessions);
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    expect(h.sessions.getCurrent()?.admission_id).toBe(FAKE_ADMISSION_ID);
    expect(h.fake.admitted).toHaveLength(1); // P1 grant refresh seam
  });

  it('admitted with a different admission_id (expired and re-admitted) adopts the new id and logs it', async () => {
    const h = harness();
    signInCashier(h.sessions);
    const NEW_ID = '0192f6a0-aaaa-7bbb-8ccc-000000000002';
    h.fake.setAdmit({ ...ADMITTED, admission_ttl_seconds: TTL_S, admission_id: NEW_ID });
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()?.admission_id).toBe(NEW_ID);
    expect(JSON.stringify(h.logs)).toContain('operator.cashier_admission.heartbeat.rotated');
    // sign-out now ends the NEW admission
    h.sessions.end('signed_out');
    expect(h.fake.endCalls).toEqual([NEW_ID]);
  });

  it('active_elsewhere at a safe point ends the session superseded_by_takeover and stops heartbeats', async () => {
    const h = harness();
    signInCashier(h.sessions);
    h.fake.setAdmit({ kind: 'active_elsewhere' });
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()).toBeNull();
    expect(h.sessions.getLastEndCause()).toBe('superseded_by_takeover');
    await advance(HALF_TTL_MS * 4);
    expect(h.fake.admitCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('active_elsewhere mid-sale waits for the next safe point (never discards the sale)', async () => {
    const h = harness();
    const record = signInCashier(h.sessions);
    h.safe.value = false; // a sale with lines or live tender is open
    h.fake.setAdmit({ kind: 'active_elsewhere' });
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    await advance(SAFE_POINT_RECHECK_MS * 3);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    expect(h.fake.admitCalls).toHaveLength(1); // no further heartbeats while superseded
    h.safe.value = true; // sale finished or held
    await advance(SAFE_POINT_RECHECK_MS);
    expect(h.sessions.getCurrent()).toBeNull();
    expect(h.sessions.getLastEndCause()).toBe('superseded_by_takeover');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a throwing safe-point probe is treated as not safe and rechecked', async () => {
    const sessions = new SessionManager();
    const fake = fakeCashierAdmission({ kind: 'active_elsewhere' });
    let probes = 0;
    const keeper = new CashierAdmissionKeeper({
      sessionManager: sessions,
      admission: fake.deps,
      onAccountDisabled: vi.fn(),
      isAtSafePoint: () => {
        probes += 1;
        throw new Error('db busy');
      },
    });
    const record = signInCashier(sessions);
    await advance(HALF_TTL_MS + SAFE_POINT_RECHECK_MS * 2);
    expect(sessions.getCurrent()?.id).toBe(record.id);
    expect(probes).toBe(3);
    keeper.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('403 refused ends the session account_disabled_mid_session and invalidates the grant', async () => {
    const h = harness();
    signInCashier(h.sessions);
    h.fake.setAdmit({ kind: 'refused' });
    await advance(HALF_TTL_MS);
    expect(h.accountDisabled).toHaveBeenCalledOnce();
    expect(h.sessions.getCurrent()).toBeNull();
    expect(h.sessions.getLastEndCause()).toBe('account_disabled_mid_session');
    expect(h.fake.invalidated).toEqual([{ reason: 'refused', user_id: FAKE_USER_ID }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('device 401 runs the device-revoked handling (terminal_session_terminated)', async () => {
    const h = harness();
    signInCashier(h.sessions);
    h.fake.setAdmit({ kind: 'device_unauthorized' });
    await advance(HALF_TTL_MS);
    expect(h.fake.deviceRevoked).toHaveBeenCalledOnce();
    expect(h.sessions.getCurrent()).toBeNull();
    expect(h.sessions.getLastEndCause()).toBe('terminal_session_terminated');
    expect(h.fake.invalidated).toEqual([{ reason: 'device_unauthorized' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { kind: 'no_connection' },
    { kind: 'unavailable' },
    { kind: 'rejected' },
    { kind: 'idempotency_conflict' },
    { kind: 'rate_limited' },
  ] as const)('%o keeps the session and retries on the next tick', async (result) => {
    const h = harness();
    const record = signInCashier(h.sessions);
    h.fake.setAdmit(result);
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    expect(h.fake.admitCalls).toHaveLength(1);
    await advance(HALF_TTL_MS);
    expect(h.fake.admitCalls).toHaveLength(2);
    expect(h.fake.admitCalls[0]?.idempotency_key).not.toBe(h.fake.admitCalls[1]?.idempotency_key);
    expect(h.accountDisabled).not.toHaveBeenCalled();
    expect(h.fake.deviceRevoked).not.toHaveBeenCalled();
  });
});

describe('end and timer lifecycle', () => {
  it('sign-out stops the heartbeat and ends the admission (best-effort)', async () => {
    const h = harness();
    signInCashier(h.sessions);
    const signOut = new SignOutHandler({
      backend: {} as BackendClient,
      sessionManager: h.sessions,
      jwtFor: () => null,
    });
    await expect(signOut.signOut()).resolves.toEqual({ kind: 'signed_out' });
    expect(h.fake.endCalls).toEqual([FAKE_ADMISSION_ID]);
    expect(vi.getTimerCount()).toBe(0);
    await advance(HALF_TTL_MS * 4);
    expect(h.fake.admitCalls).toHaveLength(0);
  });

  it('a failing or hanging end never blocks sign-out', async () => {
    const h = harness();
    signInCashier(h.sessions);
    h.fake.setEnd(() => new Promise(() => undefined)); // never settles
    const signOut = new SignOutHandler({
      backend: {} as BackendClient,
      sessionManager: h.sessions,
      jwtFor: () => null,
    });
    await expect(signOut.signOut()).resolves.toEqual({ kind: 'signed_out' });
    expect(h.sessions.getCurrent()).toBeNull();

    const h2 = harness();
    signInCashier(h2.sessions);
    h2.fake.setEnd(() => Promise.reject(new Error('boom')));
    const signOut2 = new SignOutHandler({
      backend: {} as BackendClient,
      sessionManager: h2.sessions,
      jwtFor: () => null,
    });
    await expect(signOut2.signOut()).resolves.toEqual({ kind: 'signed_out' });
    await advance(0);
    expect(h2.sessions.getCurrent()).toBeNull();
  });

  it('any session end (e.g. account disabled) stops the timer and ends the admission', () => {
    const h = harness();
    signInCashier(h.sessions);
    h.sessions.end('account_disabled_mid_session');
    expect(h.fake.endCalls).toEqual([FAKE_ADMISSION_ID]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a new session replacing the old one disarms the old heartbeat and ends its admission', () => {
    const h = harness();
    signInCashier(h.sessions);
    h.sessions.create({
      operator_id: 'mgr',
      display_name: 'M',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'be',
    });
    expect(h.fake.endCalls).toEqual([FAKE_ADMISSION_ID]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shutdown (stop latch) clears the timer; no heartbeat or end afterwards', async () => {
    const h = harness();
    signInCashier(h.sessions);
    h.keeper.stop();
    expect(vi.getTimerCount()).toBe(0);
    await advance(HALF_TTL_MS * 4);
    expect(h.fake.admitCalls).toHaveLength(0);
    h.sessions.end('signed_out');
    expect(h.fake.endCalls).toEqual([]);
    // A session started after stop is never armed.
    signInCashier(h.sessions);
    expect(vi.getTimerCount()).toBe(0);
    h.keeper.stop(); // idempotent
  });

  it('a heartbeat in flight at shutdown has no effect when it settles', async () => {
    const h = harness();
    const record = signInCashier(h.sessions);
    let settle: (r: CashierAdmissionResult) => void = () => undefined;
    h.fake.setAdmit(
      () =>
        new Promise<CashierAdmissionResult>((resolve) => {
          settle = resolve;
        }),
    );
    await advance(HALF_TTL_MS);
    expect(h.fake.admitCalls).toHaveLength(1);
    h.keeper.stop();
    settle({ kind: 'refused' });
    await advance(0);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    expect(h.accountDisabled).not.toHaveBeenCalled();
    expect(h.fake.invalidated).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a heartbeat that settles after its session ended does not touch the next session', async () => {
    const h = harness();
    signInCashier(h.sessions);
    let settle: (r: CashierAdmissionResult) => void = () => undefined;
    h.fake.setAdmit(
      () =>
        new Promise<CashierAdmissionResult>((resolve) => {
          settle = resolve;
        }),
    );
    await advance(HALF_TTL_MS);
    h.sessions.end('signed_out');
    h.fake.setAdmit({ ...ADMITTED, admission_ttl_seconds: TTL_S });
    const next = signInCashier(h.sessions);
    settle({ kind: 'refused' });
    await advance(0);
    expect(h.sessions.getCurrent()?.id).toBe(next.id);
    expect(h.accountDisabled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1); // only the new session's heartbeat
  });
});

describe('redaction', () => {
  it('logs carry outcome kinds only — no admission id, user id, key or name', async () => {
    const h = harness();
    signInCashier(h.sessions);
    await advance(HALF_TTL_MS);
    h.fake.setAdmit({ kind: 'no_connection' });
    await advance(HALF_TTL_MS);
    h.sessions.end('signed_out');
    await advance(0);
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(FAKE_ADMISSION_ID);
    expect(logged).not.toContain(FAKE_USER_ID);
    expect(logged).not.toContain('test-idempotency-key');
    expect(logged).not.toContain('Mona');
    expect(logged).not.toContain('Server Name');
  });
});
