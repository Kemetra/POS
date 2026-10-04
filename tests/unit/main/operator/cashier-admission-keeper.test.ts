import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CashierAdmissionKeeper,
  DEVICE_401_CONFIRM_MS,
  FAILED_TICK_RETRY_MS,
  SAFE_POINT_RECHECK_MS,
  heartbeatIntervalMs,
} from '../../../../src/main/operator/cashier-admission-keeper.js';
import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
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
  safe: { value: boolean };
  logs: unknown[];
  /** Every session end (cause), as the renderer push and the cart/payment resets see it. */
  ends: (string | undefined)[];
}

function harness(): Harness {
  const sessions = new SessionManager();
  const fake = fakeCashierAdmission({ ...ADMITTED, admission_ttl_seconds: TTL_S });
  const cascade = new LifecycleCascade({ sessionManager: sessions });
  // The immediate RT-138 cascade (sign-in path). Review F1: the heartbeat must
  // NOT use it; it ends at the safe point instead.
  fake.deps.onDeviceRevoked = vi.fn(() => {
    cascade.notifyTerminalRevoked();
  });
  fake.deviceRevoked = fake.deps.onDeviceRevoked as ReturnType<typeof vi.fn>;
  const ends: (string | undefined)[] = [];
  sessions.onEnded((_record, cause) => ends.push(cause));
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
    isAtSafePoint: () => safe.value,
    logger,
  });
  return { sessions, keeper, fake, safe, logs, ends };
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
  });

  it('review F5: clamped to [1000 ms, 2^31-1 ms] (a tiny TTL or a TTL past the setTimeout limit)', () => {
    expect(heartbeatIntervalMs(1)).toBe(1_000);
    expect(heartbeatIntervalMs(0.5)).toBe(1_000);
    expect(heartbeatIntervalMs(10_000_000)).toBe(2_147_483_647);
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

  it('active_elsewhere latches the session (no new sale) until it ends', async () => {
    const h = harness();
    signInCashier(h.sessions);
    h.safe.value = false;
    h.fake.setAdmit({ kind: 'active_elsewhere' });
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()?.authority_latch).toBe('superseded_by_takeover');
    expect(h.ends).toEqual([]);
  });

  it('403 at a safe point ends account_disabled_mid_session and invalidates the grant', async () => {
    const h = harness();
    signInCashier(h.sessions);
    h.fake.setAdmit({ kind: 'refused' });
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()).toBeNull();
    expect(h.ends).toEqual(['account_disabled_mid_session']);
    expect(h.fake.invalidated).toEqual([{ reason: 'refused', user_id: FAKE_USER_ID }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('review F1: a 403 mid-tender latches and defers the end to the safe point', async () => {
    const h = harness();
    const record = signInCashier(h.sessions);
    h.safe.value = false; // live tender on the open sale
    h.fake.setAdmit({ kind: 'refused' });
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    expect(h.sessions.getCurrent()?.authority_latch).toBe('account_disabled_mid_session');
    // The grant is invalidated at once (D4); the session is not ended yet, so
    // the renderer gets no `ended` push and resets no cart or payment store.
    expect(h.fake.invalidated).toEqual([{ reason: 'refused', user_id: FAKE_USER_ID }]);
    await advance(SAFE_POINT_RECHECK_MS * 3);
    expect(h.ends).toEqual([]);
    expect(h.fake.admitCalls).toHaveLength(1); // latched: no more heartbeats
    h.safe.value = true;
    await advance(SAFE_POINT_RECHECK_MS);
    expect(h.ends).toEqual(['account_disabled_mid_session']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('review F3: a single device 401 does not latch; a confirmation call follows in 30 s', async () => {
    const h = harness();
    const record = signInCashier(h.sessions);
    h.fake.setAdmit({ kind: 'device_unauthorized' });
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()?.authority_latch).toBeUndefined();
    expect(h.fake.invalidated).toEqual([]);
    h.fake.setAdmit({ ...ADMITTED, admission_ttl_seconds: TTL_S });
    await advance(DEVICE_401_CONFIRM_MS - 1);
    expect(h.fake.admitCalls).toHaveLength(1);
    await advance(1);
    expect(h.fake.admitCalls).toHaveLength(2);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    expect(h.sessions.getCurrent()?.authority_latch).toBeUndefined();
    expect(h.ends).toEqual([]);
    // The 401 count reset: a later single 401 again needs confirmation.
    h.fake.setAdmit({ kind: 'device_unauthorized' });
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()?.authority_latch).toBeUndefined();
  });

  it('review F3 + F1: two consecutive device 401s latch and end terminal_session_terminated at the safe point', async () => {
    const h = harness();
    const record = signInCashier(h.sessions);
    h.safe.value = false; // mid-tender
    h.fake.setAdmit({ kind: 'device_unauthorized' });
    await advance(HALF_TTL_MS + DEVICE_401_CONFIRM_MS);
    expect(h.fake.admitCalls).toHaveLength(2);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    expect(h.sessions.getCurrent()?.authority_latch).toBe('terminal_session_terminated');
    expect(h.fake.invalidated).toEqual([{ reason: 'device_unauthorized' }]);
    expect(h.fake.deviceRevoked).not.toHaveBeenCalled(); // no immediate cascade
    expect(h.ends).toEqual([]);
    h.safe.value = true;
    await advance(SAFE_POINT_RECHECK_MS);
    expect(h.ends).toEqual(['terminal_session_terminated']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ kind: 'rejected' }, { kind: 'idempotency_conflict' }, { kind: 'no_token' }] as const)(
    '%o keeps the session and retries on the next tick',
    async (result) => {
      const h = harness();
      const record = signInCashier(h.sessions);
      h.fake.setAdmit(result);
      await advance(HALF_TTL_MS);
      expect(h.sessions.getCurrent()?.id).toBe(record.id);
      expect(h.fake.admitCalls).toHaveLength(1);
      await advance(HALF_TTL_MS - 1);
      expect(h.fake.admitCalls).toHaveLength(1);
      await advance(1);
      expect(h.fake.admitCalls).toHaveLength(2);
      expect(h.fake.admitCalls[0]?.idempotency_key).not.toBe(h.fake.admitCalls[1]?.idempotency_key);
      expect(h.sessions.getCurrent()?.authority_latch).toBeUndefined();
      expect(h.fake.deviceRevoked).not.toHaveBeenCalled();
      expect(h.fake.invalidated).toEqual([]);
    },
  );

  it.each([{ kind: 'no_connection' }, { kind: 'unavailable' }, { kind: 'rate_limited' }] as const)(
    'review F6: %o keeps the session and retries sooner, after min(TTL/2, 60 s)',
    async (result) => {
      const h = harness();
      const record = signInCashier(h.sessions);
      h.fake.setAdmit(result);
      await advance(HALF_TTL_MS);
      expect(h.fake.admitCalls).toHaveLength(1);
      await advance(FAILED_TICK_RETRY_MS - 1);
      expect(h.fake.admitCalls).toHaveLength(1);
      await advance(1);
      expect(h.fake.admitCalls).toHaveLength(2);
      expect(h.sessions.getCurrent()?.id).toBe(record.id);
      expect(h.fake.deviceRevoked).not.toHaveBeenCalled();
    },
  );

  it('review F6: failed ticks back off exponentially, capped at TTL/2; success restores the cadence', async () => {
    const h = harness();
    signInCashier(h.sessions);
    h.fake.setAdmit({ kind: 'no_connection' });
    const callTimes: number[] = [];
    const start = Date.now();
    h.fake.setAdmit(() => {
      callTimes.push(Date.now() - start);
      return callTimes.length < 6
        ? { kind: 'no_connection' }
        : { ...ADMITTED, admission_ttl_seconds: TTL_S };
    });
    await advance(HALF_TTL_MS + 60_000 + 120_000 + 240_000 + 300_000 + 300_000 + HALF_TTL_MS);
    expect(callTimes).toEqual([
      HALF_TTL_MS,
      HALF_TTL_MS + 60_000,
      HALF_TTL_MS + 180_000,
      HALF_TTL_MS + 420_000,
      HALF_TTL_MS + 720_000,
      HALF_TTL_MS + 1_020_000,
      HALF_TTL_MS + 1_020_000 + HALF_TTL_MS,
    ]);
  });

  it('review F6: the failed-tick retry never exceeds TTL/2 when TTL/2 is under 60 s', async () => {
    const h = harness();
    signInCashier(h.sessions, 20); // TTL/2 = 10 s
    h.fake.setAdmit({ kind: 'no_connection' });
    await advance(10_000);
    expect(h.fake.admitCalls).toHaveLength(1);
    await advance(10_000);
    expect(h.fake.admitCalls).toHaveLength(2);
  });

  it('review F9: a slow heartbeat never overlaps the next one (in-flight stays at 1)', async () => {
    const h = harness();
    signInCashier(h.sessions, 2); // interval clamped to 1 s
    let inFlight = 0;
    let maxInFlight = 0;
    h.fake.setAdmit(
      () =>
        new Promise<CashierAdmissionResult>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve({ ...ADMITTED, admission_ttl_seconds: 2 });
          }, 5_000);
        }),
    );
    await advance(30_000);
    expect(h.fake.admitCalls.length).toBeGreaterThan(2);
    expect(maxInFlight).toBe(1);
  });
});

describe('Codex P1 #1 / review F2 — the latch blocks a new sale; the first safe point ends the session', () => {
  it('after active_elsewhere mid-sale: the sale completes, cart.create is refused and the session ends', async () => {
    const h = harness();
    const record = signInCashier(h.sessions);
    const cart = new CartBridgeHandlers({
      getCurrentSession: () => h.sessions.getCurrent(),
      getTerminalId: () => 'term-1',
      onSaleBoundary: () => {
        h.keeper.recheckSafePoint();
      },
    });
    h.safe.value = false; // sale open with lines
    h.fake.setAdmit({ kind: 'active_elsewhere' });
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);

    h.safe.value = true; // the sale settled
    const res = await cart.create({ idempotency_key: 'create-after-takeover-0001' });
    expect(res).toEqual({ kind: 'refused', reason: 'authority_conflict' });
    // The boundary re-check ended it at once, without waiting for the poll.
    expect(h.ends).toEqual(['superseded_by_takeover']);
  });

  it('recheckSafePoint is a no-op on an unlatched session', () => {
    const h = harness();
    const record = signInCashier(h.sessions);
    h.keeper.recheckSafePoint();
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    expect(h.ends).toEqual([]);
  });

  it('a lock-state change re-checks the safe point', async () => {
    const h = harness();
    signInCashier(h.sessions);
    h.safe.value = false;
    h.fake.setAdmit({ kind: 'active_elsewhere' });
    await advance(HALF_TTL_MS);
    h.safe.value = true;
    h.sessions.lock(new Date().toISOString());
    expect(h.ends).toEqual(['superseded_by_takeover']);
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

  it('review F4: replacing a session that holds the SAME admission_id does not end it', () => {
    const h = harness();
    signInCashier(h.sessions);
    signInCashier(h.sessions); // same device re-admission: the same admission_id
    expect(h.fake.endCalls).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
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
    expect(h.sessions.getCurrent()?.authority_latch).toBeUndefined();
    expect(h.fake.invalidated).toEqual([]);
    expect(h.fake.endCalls).toEqual([]);
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
    expect(h.sessions.getCurrent()?.authority_latch).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1); // only the new session's heartbeat
  });

  it('review F7: a late admitted after sign-out ends that admission (no orphan)', async () => {
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
    h.sessions.end('signed_out'); // ends FAKE_ADMISSION_ID
    const LATE_ID = '0192f6a0-aaaa-7bbb-8ccc-0000000000aa';
    settle({ ...ADMITTED, admission_id: LATE_ID });
    await advance(0);
    expect(h.fake.endCalls).toEqual([FAKE_ADMISSION_ID, LATE_ID]);
    expect(h.fake.admitted).toEqual([]); // no grant refresh for a dead session
  });

  it('review F7: a late admitted after sign-out + immediate sign-in never ends the new live admission', async () => {
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
    const next = signInCashier(h.sessions); // re-admitted: same device, same admission_id
    settle({ ...ADMITTED }); // the late heartbeat answer carries that same id
    await advance(0);
    expect(h.fake.endCalls).toEqual([FAKE_ADMISSION_ID]); // only the sign-out end
    expect(h.sessions.getCurrent()?.id).toBe(next.id);

    // A DIFFERENT late id while a new session is live is still released.
    const h2 = harness();
    signInCashier(h2.sessions);
    let settle2: (r: CashierAdmissionResult) => void = () => undefined;
    h2.fake.setAdmit(
      () =>
        new Promise<CashierAdmissionResult>((resolve) => {
          settle2 = resolve;
        }),
    );
    await advance(HALF_TTL_MS);
    h2.sessions.end('signed_out');
    signInCashier(h2.sessions);
    const ORPHAN = '0192f6a0-aaaa-7bbb-8ccc-0000000000bb';
    settle2({ ...ADMITTED, admission_id: ORPHAN });
    await advance(0);
    expect(h2.fake.endCalls).toEqual([FAKE_ADMISSION_ID, ORPHAN]);
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
