/**
 * RT-113 P1.2 — the offline grant wiring: fail closed. A throwing store leaves
 * an in-memory tombstone (per user, or terminal-wide) that `evaluate`
 * consults; the 60 s clock tick (OD7, RT-198 stop latch) retries it; held
 * terminal-wide operations merge by strength (Codex P2 4184105427).
 * Shared harness: `__helpers__/offline-grant-wiring-harness.ts`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { OfflineGrantStore } from '../offline-grant-store.js';
import {
  OFFLINE_GRANT_CLOCK_TICK_MS,
  createOfflineGrantWiring,
  type OfflineGrantWiring,
} from '../offline-grant-wiring.js';
import {
  EPOCH,
  HOUR_MS,
  OPERATOR,
  T0,
  T0_MS,
  TERMINAL,
  USER,
  admitted,
  at,
  rows,
  scope,
} from './__helpers__/offline-grant-fixture.js';
import {
  USER_2,
  OPERATOR_2,
  g,
  clock,
  audits,
  store,
  wiring,
  makeWiring,
  refusal,
  categoryOf,
  current,
  admit,
  admitBoth,
  invalidate,
  body,
  breakable,
  auditOf,
  setWiring,
  setClock,
  resetAudits,
  installWiringHarness,
} from './__helpers__/offline-grant-wiring-harness.js';

installWiringHarness();

describe('fail closed: a throwing store leaves a tombstone that evaluate consults (10871)', () => {
  let b: ReturnType<typeof breakable>;

  beforeEach(() => {
    admitBoth();
    b = breakable();
    setWiring(makeWiring({ store: b.store }));
    wiring.setScope(scope());
  });

  it('a failed 403 invalidation refuses that user, not the other, and never throws', () => {
    b.broken.add('invalidate');
    expect(() => {
      invalidate({ reason: 'refused', user_id: USER });
    }).not.toThrow();
    expect(store.evaluate(scope(), USER, T0).admissible).toBe(true); // the store missed it
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.consumeOfflineUse(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(body()['offline_admissions_used']).toBe(0);
    expect(wiring.evaluate(USER_2, T0).admissible).toBe(true);
  });

  it('a failed active_elsewhere invalidation refuses that user', () => {
    b.broken.add('invalidate');
    invalidate({ reason: 'active_elsewhere', user_id: USER_2 });
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
  });

  it('a failed 401 invalidation refuses EVERY user (terminal-wide)', () => {
    b.broken.add('invalidateAll');
    expect(() => {
      invalidate({ reason: 'device_unauthorized' });
    }).not.toThrow();
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate('user-never-seen', T0)).toEqual(refusal('grant_invalidated'));
  });

  it('a failed write still refuses: the old grant cannot stand', () => {
    b.broken.add('upsertFromAdmitted');
    expect(() => {
      admit({ admission_id: 'adm-new' });
    }).not.toThrow();
    expect(store.evaluate(scope(), USER, T0).admissible).toBe(true); // the old one, in the store
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate(USER_2, T0).admissible).toBe(true);
  });

  it('a device 401 with no pairing scope is held terminal-wide', () => {
    wiring.setScope(null);
    invalidate({ reason: 'device_unauthorized' });
    wiring.setScope(scope());
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
  });

  it('an invalidation with no pairing scope is held as a tombstone', () => {
    wiring.setScope(null);
    invalidate({ reason: 'refused', user_id: USER });
    wiring.setScope(scope());
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
  });

  it('a later successful admitted for that user lifts the per-user tombstone', () => {
    b.broken.add('invalidate');
    invalidate({ reason: 'refused', user_id: USER });
    b.broken.clear();
    admit();
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
  });

  it('RT-113 follow-up A: an admitted that lifts a held invalidation audits it exactly once, then writes the new grant', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    b.broken.add('invalidate');
    invalidate({ reason: 'refused', user_id: USER });
    b.broken.clear();
    admit({ admission_id: 'adm-new' });
    expect(audits.map(auditOf)).toEqual([{ reason: 'forbidden', operator: OPERATOR }]);
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
    expect(body()).toMatchObject({ admission_id: 'adm-new', invalidated: null });
    wiring.start(); // the tick has nothing left to retry: no second audit
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(audits).toHaveLength(1);
  });

  it('RT-113 follow-up A: if the held invalidation still fails, the admitted writes nothing and the hold stays', () => {
    b.broken.add('invalidate');
    invalidate({ reason: 'refused', user_id: USER });
    admit({ admission_id: 'adm-new' });
    expect(audits).toEqual([]);
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(body()['admission_id']).not.toBe('adm-new');
  });

  it('RT-113 follow-up A: the held invalidation applied by an admitted is not re-audited when the write then fails', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    b.broken.add('invalidate');
    invalidate({ reason: 'refused', user_id: USER });
    b.broken.clear();
    b.broken.add('upsertFromAdmitted');
    admit({ admission_id: 'adm-new' });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    b.broken.clear();
    wiring.start();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(audits.map(auditOf)).toEqual([{ reason: 'forbidden', operator: OPERATOR }]);
  });

  it('the clock tick retries the held invalidation into the store, audits it and lifts the tombstone', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    b.broken.add('invalidate');
    invalidate({ reason: 'refused', user_id: USER });
    expect(audits).toEqual([]);
    wiring.start();
    b.broken.clear();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(body()['invalidated']).toMatchObject({ reason: 'forbidden' });
    expect(audits.map(auditOf)).toEqual([{ reason: 'forbidden', operator: OPERATOR }]);
    expect(wiring.evaluate(USER_2, T0).admissible).toBe(true);
  });

  it('the clock tick retries a held 401 into the store; until then everyone is refused', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    b.broken.add('invalidateAll');
    invalidate({ reason: 'device_unauthorized' });
    wiring.start();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
    b.broken.clear();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(store.evaluate(scope(), USER_2, T0)).toEqual(refusal('grant_invalidated'));
    expect(audits).toHaveLength(2);
  });

  it('a throwing audit emitter or logger never breaks the seam', () => {
    const loud = createOfflineGrantWiring({
      store,
      audit: {
        emit: () => {
          throw new Error('audit down');
        },
      },
      uuid: () => 'evt',
      now: () => clock,
      logger: {
        info: () => {
          throw new Error('log down');
        },
        warn: () => {
          throw new Error('log down');
        },
      },
    });
    loud.setScope(scope());
    expect(() => {
      loud.seam.onCashierAdmitted(current(loud));
      loud.seam.onCashierAdmissionInvalidated({ reason: 'refused', user_id: USER });
      loud.seam.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' });
      loud.onPairingChange('unpair');
    }).not.toThrow();
    expect(loud.evaluate(USER, T0).admissible).toBe(false);
  });

  it('evaluate and consume never throw, even when the store does', () => {
    b.broken.add('evaluate');
    b.broken.add('consumeOfflineUse');
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('storage'));
    expect(wiring.consumeOfflineUse(USER, T0)).toEqual(refusal('storage'));
  });
});

describe('the clock high-water-mark tick (OD7) under the RT-198 stop latch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  function hwmRows(): number {
    return rows(g.raw, 'cashier_offline_clock_hwm').length;
  }

  it('raises the mark at start', () => {
    expect(hwmRows()).toBe(0);
    wiring.start();
    expect(hwmRows()).toBe(1);
  });

  it('raises the mark every 60 s', () => {
    const spy = vi.spyOn(store, 'observeClock');
    wiring.start();
    expect(spy).toHaveBeenCalledTimes(1);
    setClock(at(T0_MS + HOUR_MS));
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS - 1);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(at(T0_MS + HOUR_MS));
    // The raised mark refuses a clock rolled back further than 5 min below it.
    admit();
    expect(categoryOf(wiring.evaluate(USER, at(T0_MS + HOUR_MS - 6 * 60_000)))).toBe(
      'clock_suspect',
    );
  });

  it('no tick survives stop(), and start() after stop() does nothing', () => {
    const spy = vi.spyOn(store, 'observeClock');
    wiring.start();
    wiring.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    wiring.start();
    vi.advanceTimersByTime(10 * OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a second start() does not add a second interval', () => {
    wiring.start();
    wiring.start();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('after stop() the seam writes nothing (the DB handle is about to close)', () => {
    wiring.stop();
    admit();
    invalidate({ reason: 'device_unauthorized' });
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(audits).toEqual([]);
  });
});

// ── Held terminal-wide operations merge by strength (Codex P2 4184105427) ──
//
// purge > invalidate_all: a pending operation is never replaced by a weaker
// one, and a retry lifts the hold only once the strongest held op applied.

type HeldOp = 'invalidate_all' | 'purge';

describe('held terminal-wide operations merge by strength (Codex P2 4184105427)', () => {
  function rig(): { w: OfflineGrantWiring; broken: Set<keyof OfflineGrantStore> } {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const broken = new Set<keyof OfflineGrantStore>();
    const proxy = new Proxy(store, {
      get(target, prop: keyof OfflineGrantStore) {
        if (broken.has(prop)) {
          return () => {
            throw new Error('store down');
          };
        }
        return target[prop];
      },
    });
    const w = makeWiring({ store: proxy });
    w.setScope(scope());
    w.seam.onCashierAdmitted(current(w));
    w.seam.onCashierAdmitted(current(w, { user_id: USER_2, operator_id: OPERATOR_2 }));
    w.start();
    return { w, broken };
  }

  /** Make `op` fail and stay held. */
  function holdOp(w: OfflineGrantWiring, broken: Set<keyof OfflineGrantStore>, op: HeldOp): void {
    broken.add('invalidateAll');
    broken.add('purgeAll');
    if (op === 'purge') {
      w.onPairingChange('repair');
      w.setScope(scope());
    } else {
      w.seam.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' });
    }
    broken.clear();
  }

  it.each([
    ['invalidate_all', 'invalidate_all', 'invalidate_all'],
    ['invalidate_all', 'purge', 'purge'],
    ['purge', 'invalidate_all', 'purge'],
    ['purge', 'purge', 'purge'],
  ] as const)('held %s + incoming %s → %s applied by the tick', (held, incoming, merged) => {
    const { w, broken } = rig();
    holdOp(w, broken, held);
    holdOp(w, broken, incoming);
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    if (merged === 'purge') {
      expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    } else {
      expect(rows(g.raw, 'cashier_offline_grants')).toHaveLength(2);
      expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_invalidated'));
    }
    w.stop();
  });

  it('per-user tombstones held alongside a pending purge: both stay until the purge applies', () => {
    const { w, broken } = rig();
    holdOp(w, broken, 'purge');
    broken.add('invalidate');
    w.seam.onCashierAdmissionInvalidated({ reason: 'refused', user_id: USER });
    broken.clear();
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(w.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    w.stop();
  });

  it("Codex's scenario: purge pending, then a 401, then the pairing completes, then the tick: every scope purged and audited", () => {
    const { w, broken } = rig();
    store.upsertFromAdmitted(
      scope({ terminal_id: 'terminal-old' }),
      admitted({ operator_id: 'op-old' }),
    );
    // A re-pair whose purge fails: the purge is held, the scope is null.
    broken.add('invalidateAll');
    broken.add('purgeAll');
    w.onPairingChange('repair');
    // A delayed heartbeat 401 lands while the scope is null (and the store is still down).
    w.seam.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' });
    broken.clear();
    // The pairing completes.
    w.setScope(scope({ terminal_id: 'terminal-new', pairing_epoch: EPOCH + 1 }));
    resetAudits();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(
      audits.map((a) => [a.payload['reason'], a.acting_operator_id, a.originating_terminal_id]),
    ).toEqual(
      expect.arrayContaining([
        ['repair', OPERATOR, TERMINAL],
        ['repair', OPERATOR_2, TERMINAL],
        ['repair', 'op-old', 'terminal-old'],
      ]),
    );
    expect(audits).toHaveLength(3);
    w.stop();
  });

  it('a weaker op that applies does not lift a held purge (401 applied for the new scope only)', () => {
    const { w, broken } = rig();
    store.upsertFromAdmitted(
      scope({ terminal_id: 'terminal-old' }),
      admitted({ operator_id: 'op-old' }),
    );
    broken.add('invalidateAll');
    broken.add('purgeAll');
    w.onPairingChange('repair');
    broken.clear();
    w.setScope(scope({ terminal_id: 'terminal-new', pairing_epoch: EPOCH + 1 }));
    w.seam.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' }); // applies (new scope)
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated')); // the purge still holds
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(audits.filter((a) => a.originating_terminal_id === 'terminal-old')).toHaveLength(1);
    w.stop();
  });

  it('a per-user hold keeps its first reason; a later one never replaces it', () => {
    const { w, broken } = rig();
    broken.add('invalidate');
    w.seam.onCashierAdmissionInvalidated({ reason: 'refused', user_id: USER });
    w.seam.onCashierAdmissionInvalidated({ reason: 'active_elsewhere', user_id: USER });
    broken.clear();
    resetAudits();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(audits.map(auditOf)).toEqual([{ reason: 'forbidden', operator: OPERATOR }]);
    w.stop();
  });

  it('Codex P1 4184710216: merged purge holds keep the MAX prior epoch, and the retry passes it', () => {
    const { w, broken } = rig();
    const big = Math.floor(T0_MS / 1000) + 100_000; // above anything the clock mark holds
    broken.add('invalidateAll');
    broken.add('purgeAll');
    w.onPairingChange('unpair', big);
    w.onPairingChange('repair', big - 50_000); // a lower prior epoch never lowers the hold
    w.onPairingChange('repair', null);
    expect(w.reservePairingEpoch(EPOCH)).toBeGreaterThan(big); // reserved above it while held
    broken.clear();
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(store.nextPairingEpoch(EPOCH)).toBeGreaterThan(big); // the retried purge kept it
    w.stop();
  });

  it('a failed retry keeps the strongest hold for the next tick', () => {
    const { w, broken } = rig();
    holdOp(w, broken, 'purge');
    holdOp(w, broken, 'invalidate_all');
    broken.add('purgeAll');
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(rows(g.raw, 'cashier_offline_grants')).toHaveLength(2);
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    broken.clear();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    w.stop();
  });
});
