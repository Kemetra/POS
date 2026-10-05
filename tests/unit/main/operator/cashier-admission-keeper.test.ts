import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CashierAdmissionKeeper,
  DEVICE_401_CONFIRM_MS,
  FAILED_TICK_RETRY_MS,
  MIN_RETRY_MS,
  SAFE_POINT_RECHECK_MS,
  heartbeatIntervalMs,
  nextCallDelayMs,
} from '../../../../src/main/operator/cashier-admission-keeper.js';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { admitCashierOnline } from '../../../../src/main/operator/cashier-admission.js';
import { registerCartHandlers } from '../../../../src/main/ipc/cart.js';
import { createSaleBoundaryIpcMain } from '../../../../src/main/ipc/sale-boundary-guard.js';
import { CART_IPC_CHANNELS } from '../../../../src/shared/cart/channels.js';
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
  admission_requested_at_ms?: number,
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
      ...(admission_requested_at_ms !== undefined ? { admission_requested_at_ms } : {}),
    },
  });
}

/** Records when each admit call is made, in ms since the harness started. */
function recordCallTimes(
  h: Harness,
  answer: (n: number) => CashierAdmissionResult | Promise<CashierAdmissionResult>,
): number[] {
  const start = Date.now();
  const times: number[] = [];
  h.fake.setAdmit(() => {
    times.push(Date.now() - start);
    return answer(times.length);
  });
  return times;
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

  it('Codex P2 4179617259: sub-2 s TTLs keep TTL/2 (no 1 s floor): TTL 1 s → 500 ms, 3 s → 1500 ms', () => {
    expect(heartbeatIntervalMs(1)).toBe(500);
    expect(heartbeatIntervalMs(3)).toBe(1_500);
  });

  it('review F5: capped at the setTimeout maximum (2^31-1 ms)', () => {
    expect(heartbeatIntervalMs(10_000_000)).toBe(2_147_483_647);
  });

  it('a 1 s TTL heartbeats every 500 ms, before the admission expires', async () => {
    const h = harness();
    signInCashier(h.sessions, 1);
    h.fake.setAdmit({ ...ADMITTED, admission_ttl_seconds: 1 });
    await advance(499);
    expect(h.fake.admitCalls).toHaveLength(0);
    await advance(1);
    expect(h.fake.admitCalls).toHaveLength(1);
    await advance(500);
    expect(h.fake.admitCalls).toHaveLength(2);
  });
});

describe('nextCallDelayMs (Codex P2 4179771036)', () => {
  it('while time is left, every delay lands strictly before the deadline and never below MIN_RETRY_MS', () => {
    for (const cap of [500, 30_000, 60_000, 300_000]) {
      for (let left = MIN_RETRY_MS + 1; left <= 700_000; left += 997) {
        const d = nextCallDelayMs(cap, { requested_at_ms: 1_000_000, ttl_ms: left }, 1_000_000);
        expect(d).toBeLessThan(left);
        expect(d).toBeGreaterThanOrEqual(MIN_RETRY_MS);
        expect(d).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('lapsed (MIN_RETRY_MS or less left, or past the deadline): the plain cadence', () => {
    const deadline = { requested_at_ms: 0, ttl_ms: 1_000 };
    expect(nextCallDelayMs(300_000, deadline, 1_000 - MIN_RETRY_MS)).toBe(300_000);
    expect(nextCallDelayMs(300_000, deadline, 1_000)).toBe(300_000);
    expect(nextCallDelayMs(60_000, deadline, 50_000)).toBe(60_000);
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
    '%o keeps the session and retries after half the time left before the deadline (Codex P2 4179771036)',
    async (result) => {
      const h = harness();
      const record = signInCashier(h.sessions);
      h.fake.setAdmit(result);
      await advance(HALF_TTL_MS);
      expect(h.sessions.getCurrent()?.id).toBe(record.id);
      expect(h.fake.admitCalls).toHaveLength(1);
      // TTL/2 left before the admission lapses → retry after half of that.
      await advance(HALF_TTL_MS / 2 - 1);
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

  it('review F6 + Codex P2 4179771036: the backoff is capped by half the time left; a renewal resets the deadline', async () => {
    const h = harness();
    signInCashier(h.sessions); // deadline: 600 s
    const times = recordCallTimes(h, (n) =>
      n === 6 ? { ...ADMITTED, admission_ttl_seconds: TTL_S } : { kind: 'no_connection' },
    );
    await advance(950_000);
    expect(times.slice(0, 8)).toEqual([
      300_000, // TTL/2: fails
      360_000, // backoff 60 s < 150 s left/2
      480_000, // backoff 120 s = 240 s left/2
      540_000, // backoff 240 s, capped: 120 s left → 60 s
      570_000, // 60 s left → 30 s
      585_000, // 30 s left → 15 s: admitted; new deadline 585 + 600 = 1185 s
      885_000, // the normal cadence again: TTL/2 after the renewal; fails
      945_000, // the failure counter restarted: backoff 60 s < 300 s left/2
    ]);
    expect(times.every((t, i) => i === 0 || t > (times[i - 1] ?? 0))).toBe(true);
  });

  it('Codex P2 4179771036: TTL 60 s, a 503 at 30 s: the retry is strictly before 60 s, and several attempts fit before expiry', async () => {
    const h = harness();
    const record = signInCashier(h.sessions, 60);
    const times = recordCallTimes(h, () => ({ kind: 'unavailable' }));
    await advance(60_000);
    expect(times[0]).toBe(30_000);
    expect(times[1]).toBe(45_000); // half of the 30 s left, not 30 s after the 503
    expect(times.length).toBeGreaterThanOrEqual(5);
    expect(times.every((t) => t < 60_000)).toBe(true);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
  });

  it('Codex P2 4179771036: TTL 1 s: the retry lands inside the window, then backs off; no tight loop', async () => {
    const h = harness();
    signInCashier(h.sessions, 1);
    const times = recordCallTimes(h, () => ({ kind: 'no_connection' }));
    await advance(3_000);
    // 500 ms (TTL/2) fails; 250 ms (MIN_RETRY_MS) before the 1 s deadline;
    // then the deadline has lapsed: the F6 backoff, capped at TTL/2.
    expect(times).toEqual([500, 750, 1_250, 1_750, 2_250, 2_750]);
    expect(MIN_RETRY_MS).toBe(250);
  });

  it('Codex P2 4179771036: a 429 backing off is still capped by the deadline', async () => {
    const h = harness();
    signInCashier(h.sessions);
    const times = recordCallTimes(h, () => ({ kind: 'rate_limited' }));
    await advance(TTL_S * 1000);
    expect(times.slice(0, 6)).toEqual([300_000, 360_000, 480_000, 540_000, 570_000, 585_000]);
    expect(times.every((t) => t < TTL_S * 1000)).toBe(true);
  });

  it('Codex P2 4179771036: after the deadline lapses unrenewed, the session stays and retries at the F6 backoff (P1/P3 own offline)', async () => {
    const h = harness();
    const record = signInCashier(h.sessions);
    const times = recordCallTimes(h, () => ({ kind: 'no_connection' }));
    await advance(TTL_S * 1000 + 2 * HALF_TTL_MS);
    const before = times.filter((t) => t < TTL_S * 1000);
    const after = times.filter((t) => t >= TTL_S * 1000);
    const last = before[before.length - 1] ?? 0;
    expect(TTL_S * 1000 - last).toBeGreaterThan(0);
    expect(TTL_S * 1000 - last).toBeLessThanOrEqual(MIN_RETRY_MS);
    // The lapsed branch: no more halving, the capped backoff (TTL/2).
    expect(after).toEqual([last + HALF_TTL_MS, last + 2 * HALF_TTL_MS]);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
    expect(h.sessions.getCurrent()?.authority_latch).toBeUndefined();
    expect(h.ends).toEqual([]);
  });

  it('Codex P2 4179771036: the deadline is anchored at the request SEND time, so a slow admitted shortens the next wait', async () => {
    const h = harness();
    signInCashier(h.sessions, 60);
    const times = recordCallTimes(
      h,
      (n) =>
        new Promise<CashierAdmissionResult>((resolve) => {
          // The first renewal takes 10 s to answer.
          setTimeout(
            () => {
              resolve({ ...ADMITTED, admission_ttl_seconds: 60 });
            },
            n === 1 ? 10_000 : 0,
          );
        }),
    );
    await advance(70_000);
    // Sent at 30 s → deadline 90 s; answered at 40 s → next at 40 + 50/2 = 65 s
    // (answer-anchored TTL/2 would give 70 s).
    expect(times.slice(0, 2)).toEqual([30_000, 65_000]);
  });

  it('Codex P2 4179771036: a sign-in admission sent before the session was created anchors the first deadline', async () => {
    const h = harness();
    // The sign-in admit was SENT 10 s before the session was created.
    signInCashier(h.sessions, 60, performance.now() - 10_000);
    h.fake.setAdmit({ kind: 'unavailable' });
    await advance(24_999);
    expect(h.fake.admitCalls).toHaveLength(0);
    await advance(1);
    // Deadline 50 s from now → the first heartbeat after 25 s, not 30 s.
    expect(h.fake.admitCalls).toHaveLength(1);
  });

  it('Codex P2 4179771036: TTL 60 s, a first device 401 at 30 s is confirmed before the deadline', async () => {
    const h = harness();
    signInCashier(h.sessions, 60);
    const times = recordCallTimes(h, () => ({ kind: 'device_unauthorized' }));
    await advance(60_000);
    // min(30 s, half of the 30 s left) → 45 s, not 60 s.
    expect(times).toEqual([30_000, 45_000]);
    expect(h.ends).toEqual(['terminal_session_terminated']);
  });

  it('Codex P2 4179701427 / 4179771036: with a 1 s TTL a first device 401 is confirmed before the 1 s deadline, not 30 s later', async () => {
    const h = harness();
    const record = signInCashier(h.sessions, 1);
    h.fake.setAdmit({ kind: 'device_unauthorized' });
    await advance(500);
    expect(h.fake.admitCalls).toHaveLength(1);
    expect(h.sessions.getCurrent()?.authority_latch).toBeUndefined();
    await advance(249);
    expect(h.fake.admitCalls).toHaveLength(1);
    await advance(1);
    expect(h.fake.admitCalls).toHaveLength(2);
    // Two consecutive 401s, 250 ms apart: latched and ended (no sale open).
    expect(h.ends).toEqual(['terminal_session_terminated']);
    expect(h.sessions.getCurrent()?.id).not.toBe(record.id);
  });

  it.each([
    { ...ADMITTED, admission_ttl_seconds: 1 },
    { kind: 'device_unauthorized' },
    { kind: 'no_connection' },
    { kind: 'unavailable' },
    { kind: 'rate_limited' },
    { kind: 'rejected' },
    { kind: 'idempotency_conflict' },
    { kind: 'no_token' },
  ] as const)(
    'Codex P2 4179701427: with a 1 s TTL, after %o the next heartbeat comes within TTL/2 (500 ms)',
    async (result) => {
      const h = harness();
      signInCashier(h.sessions, 1);
      h.fake.setAdmit(result);
      await advance(500);
      expect(h.fake.admitCalls).toHaveLength(1);
      await advance(500);
      expect(h.fake.admitCalls).toHaveLength(2);
    },
  );

  it('review F9: a slow heartbeat never overlaps the next one (in-flight stays at 1)', async () => {
    const h = harness();
    signInCashier(h.sessions, 2); // interval 1 s
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
    // The production wiring: every sale call goes through the one choke point.
    const channels = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: (c: string, f: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
        channels.set(c, f);
      },
    } as unknown as IpcMain;
    registerCartHandlers(
      createSaleBoundaryIpcMain(ipcMain, () => {
        h.keeper.recheckSafePoint();
      }),
      {
        handlers: new CartBridgeHandlers({
          getCurrentSession: () => h.sessions.getCurrent(),
          getTerminalId: () => 'term-1',
        }),
      },
    );
    h.safe.value = false; // sale open with lines
    h.fake.setAdmit({ kind: 'active_elsewhere' });
    await advance(HALF_TTL_MS);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);

    h.safe.value = true; // the sale settled
    const res = await channels.get(CART_IPC_CHANNELS.CREATE)?.({} as IpcMainInvokeEvent, {
      idempotency_key: 'create-after-takeover-0001',
    });
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

  it('review (024f07c) item 3 — sign-out then the SAME user signs in again: the new admit waits for the late end', async () => {
    const h = harness();
    signInCashier(h.sessions);
    let land: () => void = () => undefined;
    const order: string[] = [];
    h.fake.setEnd(
      () =>
        new Promise((resolve) => {
          land = () => {
            order.push('end landed');
            resolve({ kind: 'ended' });
          };
        }),
    );
    h.sessions.end(); // sign-out: the keeper fires end(X) without awaiting it
    expect(h.fake.endCalls).toEqual([FAKE_ADMISSION_ID]);
    h.fake.setAdmit(() => {
      order.push('admit sent');
      return { ...ADMITTED, admission_id: FAKE_ADMISSION_ID };
    });
    const res = admitCashierOnline(h.fake.deps, {
      user_id: FAKE_USER_ID,
      operator_id: 'user_clerk_1',
      takeover: false,
      idempotency_key: 'test-idempotency-key-9999',
    });
    await advance(100);
    expect(order).toEqual([]);
    land();
    await res;
    expect(order).toEqual(['end landed', 'admit sent']);
  });

  it('review (024f07c) — an `admitted` in flight at shutdown has no effect: no renewal, no `end` POST after stop (RT-198)', async () => {
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
    settle({ ...ADMITTED, admission_ttl_seconds: TTL_S });
    await advance(0);
    expect(h.fake.endCalls).toEqual([]);
    expect(h.fake.admitted).toEqual([]);
    expect(h.sessions.getCurrent()?.id).toBe(record.id);
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
