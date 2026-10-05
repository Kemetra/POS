/**
 * RT-113 P1.2 — the offline grant wiring: the invalidation audit. Failed
 * inserts are retried (Codex P2 4183175501); a failed refresh and a pairing
 * purge audit every standing grant they remove (4183383061, 4183628413); and
 * every invalidation path keeps the four invariants (4183852355).
 * Shared harness: `__helpers__/offline-grant-wiring-harness.ts`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { CashierAdmittedEvent } from '../cashier-admission.js';
import {
  createOfflineGrantStore,
  type OfflineGrantScope,
  type OfflineGrantStore,
} from '../offline-grant-store.js';
import {
  OFFLINE_GRANT_AUDIT_RETRY_MAX,
  OFFLINE_GRANT_CLOCK_TICK_MS,
  type OfflineGrantWiring,
} from '../offline-grant-wiring.js';
import {
  OPERATOR,
  T0,
  TERMINAL,
  USER,
  admitted,
  rows,
  scope,
} from './__helpers__/offline-grant-fixture.js';
import {
  USER_2,
  OPERATOR_2,
  g,
  ss,
  clock,
  logCalls,
  audits,
  store,
  wiring,
  logger,
  makeWiring,
  refusal,
  current,
  admit,
  admitBoth,
  invalidate,
  breakable,
  auditOf,
  resetLogCalls,
  resetAudits,
  installWiringHarness,
} from './__helpers__/offline-grant-wiring-harness.js';

installWiringHarness();

describe('a failed audit insert is retried, never lost (Codex P2 4183175501)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  /** An emitter that throws `failures` times, then records like the real one (idempotent by event_id). */
  function flakyEmitter(failures: number): { emit: (e: AuditEvent) => void; landed: AuditEvent[] } {
    let left = failures;
    const landed: AuditEvent[] = [];
    return {
      landed,
      emit(e) {
        if (left > 0) {
          left -= 1;
          throw new Error('SQLITE_FULL');
        }
        if (!landed.some((x) => x.event_id === e.event_id)) landed.push(e);
      },
    };
  }

  it('an audit that throws once lands exactly once on the next tick', () => {
    const flaky = flakyEmitter(1);
    const w = makeWiring({ emit: flaky.emit });
    w.setScope(scope());
    w.seam.onCashierAdmitted(current(w));
    w.seam.onCashierAdmissionInvalidated({ reason: 'refused', user_id: USER });
    expect(flaky.landed).toEqual([]);
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated')); // the invalidation stands
    w.start();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(flaky.landed.map(auditOf)).toEqual([{ reason: 'forbidden', operator: OPERATOR }]);
    expect(flaky.landed[0]?.created_at).toBe(T0.toISOString());
    expect(JSON.stringify(logCalls)).toContain('operator.offline_grant.audit_failed');
    w.stop();
  });

  it('a retry reuses the event id, so an insert that landed before the throw is not duplicated', () => {
    const landed: AuditEvent[] = [];
    let threw = false;
    const w = makeWiring({
      emit: (e) => {
        if (!landed.some((x) => x.event_id === e.event_id)) landed.push(e); // insertIgnore
        if (!threw) {
          threw = true;
          throw new Error('post-insert failure');
        }
      },
    });
    w.setScope(scope());
    w.seam.onCashierAdmitted(current(w));
    w.seam.onCashierAdmissionInvalidated({ reason: 'refused', user_id: USER });
    w.start();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(landed).toHaveLength(1);
    w.stop();
  });

  it('keeps retrying across several failed ticks, one event per grant', () => {
    const flaky = flakyEmitter(5);
    const w = makeWiring({ emit: flaky.emit });
    w.setScope(scope());
    w.seam.onCashierAdmitted(current(w));
    w.seam.onCashierAdmitted(current(w, { user_id: USER_2, operator_id: OPERATOR_2 }));
    w.seam.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' });
    w.start();
    for (let i = 0; i < 5; i += 1) vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(flaky.landed).toHaveLength(2);
    expect(new Set(flaky.landed.map((e) => e.acting_operator_id))).toEqual(
      new Set([OPERATOR, OPERATOR_2]),
    );
    w.stop();
  });

  it('the queue is bounded: past the cap the oldest is dropped with a category-only warning', () => {
    const flaky = flakyEmitter(Number.MAX_SAFE_INTEGER);
    const w = makeWiring({ emit: flaky.emit });
    w.setScope(scope());
    for (let i = 0; i <= OFFLINE_GRANT_AUDIT_RETRY_MAX; i += 1) {
      w.seam.onCashierAdmitted(
        current(w, { user_id: `user-${String(i)}`, operator_id: `op-${String(i)}` }),
      );
    }
    resetLogCalls();
    w.seam.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' });
    const dropped = logCalls.filter(
      (c) => (c[1] as Record<string, unknown>)['event'] === 'operator.offline_grant.audit_dropped',
    );
    expect(dropped).toEqual([
      ['warn', { event: 'operator.offline_grant.audit_dropped', count: 1 }, expect.any(String)],
    ]);
    w.stop();
  });

  it('nothing is retried after stop()', () => {
    const flaky = flakyEmitter(1);
    const w = makeWiring({ emit: flaky.emit });
    w.setScope(scope());
    w.start(); // its immediate tick runs before the failure
    w.seam.onCashierAdmitted(current(w));
    w.seam.onCashierAdmissionInvalidated({ reason: 'refused', user_id: USER });
    w.stop();
    vi.advanceTimersByTime(10 * OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(flaky.landed).toEqual([]);
  });
});

describe('a failed refresh that deletes a standing grant is audited (Codex P2 4183383061)', () => {
  it('exactly one refresh_failed event, attributed to the old grant operator; no tombstone needed', () => {
    admit();
    const sealFails = createOfflineGrantStore({
      db: g.handle,
      safeStorage: {
        ...ss,
        encryptString: () => {
          throw new Error('DPAPI unavailable');
        },
      },
      now: () => clock,
      logger,
    });
    const w = makeWiring({ store: sealFails });
    w.setScope(scope());
    w.seam.onCashierAdmitted(current(w, { admission_id: 'adm-new' }));
    expect(audits.map(auditOf)).toEqual([{ reason: 'refresh_failed', operator: OPERATOR }]);
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_missing'));
    w.stop();
  });
});

describe('the purge is the reliable audit point for a pairing change (Codex P2 4183628413)', () => {
  it('(a) invalidateAll throws, the purge succeeds: one event per grant', () => {
    admitBoth();
    const b = breakable();
    b.broken.add('invalidateAll');
    const w = makeWiring({ store: b.store });
    w.setScope(scope());
    w.onPairingChange('repair');
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(audits.map(auditOf)).toEqual(
      expect.arrayContaining([
        { reason: 'repair', operator: OPERATOR },
        { reason: 'repair', operator: OPERATOR_2 },
      ]),
    );
    expect(audits).toHaveLength(2);
    w.stop();
  });

  it('(b) no scope (invalid pairing at start) with leftover rows: one event per grant', () => {
    admitBoth();
    wiring.setScope(null);
    wiring.onPairingChange('unpair');
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(audits.map(auditOf)).toEqual(
      expect.arrayContaining([
        { reason: 'unpair', operator: OPERATOR },
        { reason: 'unpair', operator: OPERATOR_2 },
      ]),
    );
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.originating_terminal_id === TERMINAL)).toBe(true);
  });

  it('(c) the normal path: exactly one event per grant, none twice, none for an already-invalidated grant', () => {
    admitBoth();
    invalidate({ reason: 'refused', user_id: USER }); // audited once, as forbidden
    wiring.onPairingChange('repair');
    expect(audits.map(auditOf)).toEqual([
      { reason: 'forbidden', operator: OPERATOR },
      { reason: 'repair', operator: OPERATOR_2 },
    ]);
  });

  it('a held purge retried by the tick audits what it deletes', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    admitBoth();
    const b = breakable();
    b.broken.add('invalidateAll');
    b.broken.add('purgeAll');
    const w = makeWiring({ store: b.store });
    w.setScope(scope());
    w.start();
    w.onPairingChange('unpair');
    expect(audits).toEqual([]);
    b.broken.clear();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    expect(audits.map((a) => a.payload['reason'])).toEqual(['unpair', 'unpair']);
    w.stop();
  });
});

// ── Every invalidation path, against the four invariants (Codex P1 4183852355) ──
//
//  (a) the per-user (or terminal-wide) invalidation sequence advances;
//  (b) exactly one audit per standing grant affected (through the retry queue);
//  (c) a late `admitted` whose request was sent BEFORE the path is dropped;
//  (d) a throwing store fails closed (the store-throws rows below).

interface PathCase {
  name: string;
  /** Standing grants the path affects, as (operator, reason) audits. */
  audits: { reason: string; operator: string }[];
  /** Whether a request sent after the path writes an admissible grant (default true). */
  restores?: boolean;
  trigger: (
    w: OfflineGrantWiring,
    ctl: { sealFails: boolean; broken: Set<keyof OfflineGrantStore> },
  ) => void;
}

const PATHS: PathCase[] = [
  {
    name: 'seam 403 (forbidden)',
    audits: [{ reason: 'forbidden', operator: OPERATOR }],
    trigger: (w) => {
      w.seam.onCashierAdmissionInvalidated({ reason: 'refused', user_id: USER });
    },
  },
  {
    name: 'seam active_elsewhere (superseded)',
    audits: [{ reason: 'superseded', operator: OPERATOR }],
    trigger: (w) => {
      w.seam.onCashierAdmissionInvalidated({ reason: 'active_elsewhere', user_id: USER });
    },
  },
  {
    name: 'seam device 401 (all users)',
    audits: [
      { reason: 'device_unauthorized', operator: OPERATOR },
      { reason: 'device_unauthorized', operator: OPERATOR_2 },
    ],
    trigger: (w) => {
      w.seam.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' });
    },
  },
  {
    name: 'store grace_disabled (offline_grace_seconds = 0)',
    audits: [{ reason: 'grace_disabled', operator: OPERATOR }],
    trigger: (w) => {
      w.seam.onCashierAdmitted(current(w, { offline_grace_seconds: 0 }));
    },
  },
  {
    name: 'store rejected (malformed admitted → refresh_failed)',
    audits: [{ reason: 'refresh_failed', operator: OPERATOR }],
    trigger: (w) => {
      w.seam.onCashierAdmitted(current(w, { received_at: 'not a time' }));
    },
  },
  {
    name: 'store refresh_failed (seal fails, old grant deleted)',
    audits: [{ reason: 'refresh_failed', operator: OPERATOR }],
    trigger: (w, ctl) => {
      ctl.sealFails = true;
      w.seam.onCashierAdmitted(current(w, { admission_id: 'adm-new' }));
      ctl.sealFails = false;
    },
  },
  {
    name: 'upsert throws (tombstone; audited when the retry applies it)',
    audits: [],
    trigger: (w, ctl) => {
      ctl.broken.add('upsertFromAdmitted');
      w.seam.onCashierAdmitted(current(w, { admission_id: 'adm-new' }));
      ctl.broken.delete('upsertFromAdmitted');
    },
  },
  {
    name: 'seam 403 with the store down (tombstone)',
    audits: [],
    trigger: (w, ctl) => {
      ctl.broken.add('invalidate');
      w.seam.onCashierAdmissionInvalidated({ reason: 'refused', user_id: USER });
      ctl.broken.delete('invalidate');
    },
  },
  {
    name: 'seam active_elsewhere with the store down (tombstone)',
    audits: [],
    trigger: (w, ctl) => {
      ctl.broken.add('invalidate');
      w.seam.onCashierAdmissionInvalidated({ reason: 'active_elsewhere', user_id: USER });
      ctl.broken.delete('invalidate');
    },
  },
  {
    name: 'seam device 401 with the store down (terminal tombstone)',
    audits: [],
    restores: false,
    trigger: (w, ctl) => {
      ctl.broken.add('invalidateAll');
      w.seam.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' });
      ctl.broken.delete('invalidateAll');
    },
  },
  {
    name: 're-pair (purge, repair)',
    audits: [
      { reason: 'repair', operator: OPERATOR },
      { reason: 'repair', operator: OPERATOR_2 },
    ],
    trigger: (w) => {
      w.onPairingChange('repair');
      w.setScope(scope());
    },
  },
  {
    name: 're-pair with the store down (terminal tombstone)',
    audits: [],
    restores: false,
    trigger: (w, ctl) => {
      ctl.broken.add('invalidateAll');
      ctl.broken.add('purgeAll');
      w.onPairingChange('repair');
      w.setScope(scope());
      ctl.broken.clear();
    },
  },
  {
    name: 'unpair (purge, unpair)',
    audits: [
      { reason: 'unpair', operator: OPERATOR },
      { reason: 'unpair', operator: OPERATOR_2 },
    ],
    trigger: (w) => {
      w.onPairingChange('unpair');
      w.setScope(scope());
    },
  },
];

describe('every invalidation path keeps the four invariants (Codex P1 4183852355)', () => {
  function rig(): {
    w: OfflineGrantWiring;
    ctl: { sealFails: boolean; broken: Set<keyof OfflineGrantStore> };
  } {
    const ctl = { sealFails: false, broken: new Set<keyof OfflineGrantStore>() };
    const sealFailing = createOfflineGrantStore({
      db: g.handle,
      safeStorage: {
        ...ss,
        encryptString: () => {
          throw new Error('DPAPI unavailable');
        },
      },
      now: () => clock,
      logger,
    });
    const proxy = new Proxy(store, {
      get(target, prop: keyof OfflineGrantStore) {
        if (ctl.broken.has(prop)) {
          return () => {
            throw new Error('store down');
          };
        }
        if (ctl.sealFails && prop === 'upsertFromAdmitted') {
          return (sc: OfflineGrantScope, e: CashierAdmittedEvent) =>
            sealFailing.upsertFromAdmitted(sc, e);
        }
        return target[prop];
      },
    });
    const w = makeWiring({ store: proxy });
    w.setScope(scope());
    w.seam.onCashierAdmitted(current(w));
    w.seam.onCashierAdmitted(current(w, { user_id: USER_2, operator_id: OPERATOR_2 }));
    return { w, ctl };
  }

  it.each(PATHS)('$name', ({ audits: expected, trigger, restores }) => {
    const { w, ctl } = rig();
    expect(w.evaluate(USER, T0).admissible).toBe(true);
    // A positive admission for U is in flight: its send mark is taken now.
    const inFlight = {
      pairing_generation: w.seam.pairingGeneration?.(),
      invalidation_seq: w.seam.invalidationSeq?.(),
    };
    resetAudits();
    trigger(w, ctl);
    // (a)
    expect(w.seam.invalidationSeq?.()).toBeGreaterThan(inFlight.invalidation_seq ?? Infinity);
    // (b)
    expect(audits.map(auditOf)).toEqual(expect.arrayContaining(expected));
    expect(audits).toHaveLength(expected.length);
    // (c) the late answer of the in-flight request
    w.seam.onCashierAdmitted(admitted({ ...inFlight, admission_id: 'adm-late' }));
    expect(w.evaluate(USER, T0).admissible).toBe(false);
    // (d) nothing threw; a request sent AFTER the path restores the grant,
    // except while a terminal-wide tombstone stands (fail closed until retried)
    w.seam.onCashierAdmitted(current(w, { admission_id: 'adm-after' }));
    expect(w.evaluate(USER, T0).admissible).toBe(restores ?? true);
    w.stop();
  });

  it("Codex's overlap: zero grace answered first, then the earlier positive answer: no grant", () => {
    const { w } = rig();
    const sentA = {
      pairing_generation: w.seam.pairingGeneration?.(),
      invalidation_seq: w.seam.invalidationSeq?.(),
    };
    const sentB = { ...sentA };
    w.seam.onCashierAdmitted(admitted({ ...sentB, offline_grace_seconds: 0 })); // B lands first
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    w.seam.onCashierAdmitted(admitted({ ...sentA, offline_grace_seconds: 86_400 })); // then A
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(audits.filter((a) => a.payload['reason'] === 'grace_disabled')).toHaveLength(1);
    w.stop();
  });

  it('zero grace with no grant yet still blocks an earlier positive answer', () => {
    const w = makeWiring();
    w.setScope(scope());
    const sent = {
      pairing_generation: w.seam.pairingGeneration?.(),
      invalidation_seq: w.seam.invalidationSeq?.(),
    };
    w.seam.onCashierAdmitted(admitted({ ...sent, offline_grace_seconds: 0 }));
    w.seam.onCashierAdmitted(admitted({ ...sent }));
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    w.stop();
  });
});
