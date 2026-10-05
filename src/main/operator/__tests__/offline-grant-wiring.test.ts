/**
 * RT-113 P1.2 — the offline grant store wired into the app (Jira RT-113: plan
 * 10871 §"PR P1.2", decisions OD4–OD7/OD10 confirmed in 10874, P1.1 evidence
 * and the items moved into P1.2 in 10893: F2, F3, F4, the `refused` →
 * `forbidden` mapping). Test-first.
 *
 * The REAL store runs on the full migration stack (sql.js) with the
 * authenticated AES-GCM fake of safeStorage; the pairing store is the REAL
 * `createPairingStore` over the same database. Covered:
 *  - the seam: `admitted` writes or refreshes the grant for the pairing scope;
 *    a 403 invalidates THAT user only (`forbidden`); `active_elsewhere`
 *    invalidates that user (`superseded`, OD6); a device 401 invalidates ALL
 *    grants (OD5);
 *  - fail closed: a throwing store leaves an in-memory tombstone (per user, or
 *    terminal-wide for a 401) that `evaluate` consults, and never throws into
 *    sign-in or the heartbeat;
 *  - the audit: one `operator.offline_grant.invalidated` event per grant,
 *    attributed to that grant's operator, payload `{reason}` only (OD10);
 *  - the 60 s clock tick under the RT-198 stop latch, and a raise at start (OD7);
 *  - the pairing purge on persist and clear, and a NEW epoch on every re-pair (OD4, F4).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import { AUDIT_ACTION_CATEGORIES } from '../../../shared/audit/event-shape.js';
import { makeSecretKey, type SecretKey, type SecretStore } from '../../../shared/secret-store.js';
import {
  bindPairingStoreDb,
  createPairingStore,
  type PairingStore,
  type PersistInput,
} from '../../pairing/store.js';
import type { CashierAdmissionInvalidation, CashierAdmittedEvent } from '../cashier-admission.js';
import {
  createOfflineGrantStore,
  type OfflineGrantEvaluation,
  type OfflineGrantStore,
} from '../offline-grant-store.js';
import {
  OFFLINE_GRANT_CLOCK_TICK_MS,
  createOfflineGrantWiring,
  scopeFromPairingStatus,
  withOfflineGrantPairing,
  type OfflineGrantWiring,
} from '../offline-grant-wiring.js';
import {
  BRANCH,
  DISPLAY_NAME,
  EPOCH,
  HOUR_MS,
  OPERATOR,
  SENSITIVE_VALUES,
  T0,
  T0_MS,
  TENANT,
  TERMINAL,
  USER,
  aeadSafeStorage,
  admitted,
  at,
  grantBlob,
  grantDb,
  initGrantSql,
  rows,
  scope,
  type AeadSafeStorage,
  type GrantDb,
} from './__helpers__/offline-grant-fixture.js';

const USER_2 = 'user-SENTINEL-2c88';
const OPERATOR_2 = 'user_clerk_SENTINEL_77aa';
const CATEGORY = 'operator.offline_grant.invalidated';

let g: GrantDb;
let ss: AeadSafeStorage;
let clock: Date;
let logCalls: unknown[][];
let audits: AuditEvent[];
let store: OfflineGrantStore;
let wiring: OfflineGrantWiring;
let uuidSeq: number;

const logger = {
  info: (...args: unknown[]): void => {
    logCalls.push(['info', ...args]);
  },
  warn: (...args: unknown[]): void => {
    logCalls.push(['warn', ...args]);
  },
};

function makeWiring(
  over: { store?: OfflineGrantStore; emit?: (e: AuditEvent) => void } = {},
): OfflineGrantWiring {
  return createOfflineGrantWiring({
    store: over.store ?? store,
    audit: {
      emit:
        over.emit ??
        ((e) => {
          audits.push(e);
        }),
    },
    uuid: () => `evt-${String(++uuidSeq)}`,
    now: () => clock,
    logger,
  });
}

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  g = grantDb();
  ss = aeadSafeStorage();
  clock = T0;
  logCalls = [];
  audits = [];
  uuidSeq = 0;
  store = createOfflineGrantStore({ db: g.handle, safeStorage: ss, now: () => clock, logger });
  wiring = makeWiring();
  wiring.setScope(scope());
});

afterEach(() => {
  wiring.stop();
  vi.useRealTimers();
  g.raw.close();
});

function refusal(category: string): OfflineGrantEvaluation {
  return { admissible: false, category } as OfflineGrantEvaluation;
}

function categoryOf(e: OfflineGrantEvaluation): string {
  return e.admissible ? 'admissible' : e.category;
}

/** An `admitted` for a request sent under the CURRENT pairing (P1-b). */
function current(
  w: OfflineGrantWiring,
  over: Partial<CashierAdmittedEvent> = {},
): CashierAdmittedEvent {
  return admitted({ pairing_generation: w.seam.pairingGeneration?.(), ...over });
}

function admit(over: Partial<CashierAdmittedEvent> = {}): void {
  wiring.seam.onCashierAdmitted(current(wiring, over));
}

function admitBoth(): void {
  admit();
  admit({ user_id: USER_2, operator_id: OPERATOR_2 });
}

function invalidate(event: CashierAdmissionInvalidation): void {
  wiring.seam.onCashierAdmissionInvalidated(event);
}

function body(user = USER): Record<string, unknown> {
  return JSON.parse(ss.decryptString(grantBlob(g.raw, user))) as Record<string, unknown>;
}

/** A store whose every method can be made to throw, the rest delegating to the real one. */
function breakable(): { store: OfflineGrantStore; broken: Set<keyof OfflineGrantStore> } {
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
  return { store: proxy, broken };
}

function auditOf(e: AuditEvent): { reason: unknown; operator: string } {
  return { reason: e.payload['reason'], operator: e.acting_operator_id };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the audit category (OD10)', () => {
  it('operator.offline_grant.invalidated is in the closed audit catalogue', () => {
    expect(AUDIT_ACTION_CATEGORIES).toContain(CATEGORY);
  });
});

describe('admitted writes or refreshes the grant (D3)', () => {
  it('writes a grant bound to the pairing scope (tenant, branch, terminal, epoch)', () => {
    admit();
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
    expect(body()).toMatchObject({
      tenant_id: TENANT,
      branch_id: BRANCH,
      terminal_id: TERMINAL,
      pairing_epoch: EPOCH,
      user_id: USER,
    });
    expect(audits).toEqual([]);
  });

  it('a refresh resets the counter', () => {
    admit();
    wiring.consumeOfflineUse(USER, T0);
    wiring.consumeOfflineUse(USER, T0);
    expect(body()['offline_admissions_used']).toBe(2);
    admit();
    expect(body()['offline_admissions_used']).toBe(0);
  });

  it('writes nothing while the terminal is not paired', () => {
    wiring.setScope(null);
    admit();
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('scope_mismatch'));
  });

  it('grace 0 invalidates the grant and audits grace_disabled (OD8)', () => {
    admit();
    admit({ offline_grace_seconds: 0 });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(audits.map(auditOf)).toEqual([{ reason: 'grace_disabled', operator: OPERATOR }]);
  });

  it('a malformed admitted event invalidates the grant and audits refresh_failed', () => {
    admit();
    admit({ received_at: 'not a time' });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(audits.map(auditOf)).toEqual([{ reason: 'refresh_failed', operator: OPERATOR }]);
  });
});

describe('an admission result is bound to the pairing that sent it (Codex P1 4181552524)', () => {
  it('a result for a request sent before a re-pair writes no grant for the new pairing', () => {
    const sentUnder = wiring.seam.pairingGeneration?.();
    wiring.onPairingChange('repair');
    wiring.setScope(scope({ terminal_id: 'terminal-new', pairing_epoch: EPOCH + 1 }));
    wiring.seam.onCashierAdmitted(admitted({ pairing_generation: sentUnder }));
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_missing'));
    expect(JSON.stringify(logCalls)).toContain('operator.offline_grant.stale_result');
  });

  it('a result for a request sent before an unpair-and-pair writes nothing either', () => {
    const sentUnder = wiring.seam.pairingGeneration?.();
    wiring.onPairingChange('unpair');
    wiring.setScope(null);
    wiring.onPairingChange('repair');
    wiring.setScope(scope());
    wiring.seam.onCashierAdmitted(admitted({ pairing_generation: sentUnder }));
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
  });

  it('an admitted event that does not say which pairing sent it is dropped (fail closed)', () => {
    wiring.seam.onCashierAdmitted(admitted());
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
  });

  it('a result for the current pairing is written', () => {
    const sentUnder = wiring.seam.pairingGeneration?.();
    wiring.seam.onCashierAdmitted(admitted({ pairing_generation: sentUnder }));
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
  });
});

describe('invalidation per outcome (D4, OD5, OD6)', () => {
  beforeEach(() => {
    admitBoth();
  });

  it('a 403 (`refused`) invalidates THAT user only, reason forbidden', () => {
    invalidate({ reason: 'refused', user_id: USER });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate(USER_2, T0).admissible).toBe(true);
    expect(body()['invalidated']).toMatchObject({ reason: 'forbidden' });
    expect(audits.map(auditOf)).toEqual([{ reason: 'forbidden', operator: OPERATOR }]);
  });

  it('active_elsewhere invalidates that user only, reason superseded (OD6)', () => {
    invalidate({ reason: 'active_elsewhere', user_id: USER_2 });
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
    expect(body(USER_2)['invalidated']).toMatchObject({ reason: 'superseded' });
    expect(audits.map(auditOf)).toEqual([{ reason: 'superseded', operator: OPERATOR_2 }]);
  });

  it('a device 401 invalidates ALL grants, one audit event per grant (OD5, OD10)', () => {
    invalidate({ reason: 'device_unauthorized' });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
    expect(audits.map(auditOf)).toEqual(
      expect.arrayContaining([
        { reason: 'device_unauthorized', operator: OPERATOR },
        { reason: 'device_unauthorized', operator: OPERATOR_2 },
      ]),
    );
    expect(audits).toHaveLength(2);
  });

  it('a second invalidation of the same grant audits nothing more', () => {
    invalidate({ reason: 'refused', user_id: USER });
    invalidate({ reason: 'device_unauthorized' });
    expect(audits.map(auditOf)).toEqual([
      { reason: 'forbidden', operator: OPERATOR },
      { reason: 'device_unauthorized', operator: OPERATOR_2 },
    ]);
  });
});

describe('the audit event carries {reason} only, attributed to the grant operator (OD10)', () => {
  it('has the full envelope, a null session and shift, and no grant field', () => {
    admit();
    invalidate({ reason: 'refused', user_id: USER });
    expect(audits).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: TENANT,
        branch_id: BRANCH,
        originating_terminal_id: TERMINAL,
        acting_operator_id: OPERATOR,
        session_id: null,
        shift_id: null,
        action_category: CATEGORY,
        created_at: T0.toISOString(),
        approving_supervisor_id: null,
        payload: { reason: 'forbidden' },
      },
    ]);
  });

  it('no grant body field or name reaches an audit event or a log line', () => {
    admitBoth();
    invalidate({ reason: 'refused', user_id: USER });
    invalidate({ reason: 'active_elsewhere', user_id: USER_2 });
    admit();
    invalidate({ reason: 'device_unauthorized' });
    admit({ offline_grace_seconds: 0 });
    wiring.onPairingChange('repair');
    expect(audits.length).toBeGreaterThan(2);
    const audited = JSON.stringify(audits.map((a) => a.payload));
    const envelopes = JSON.stringify(audits);
    for (const v of [DISPLAY_NAME, USER, USER_2, 'adm-SENTINEL-0d42', '2026-10-05T08:00:00.000Z']) {
      expect(envelopes).not.toContain(v);
    }
    for (const a of audits) expect(Object.keys(a.payload)).toEqual(['reason']);
    expect(audited).not.toContain(OPERATOR);
    const logged = JSON.stringify(logCalls);
    for (const v of [...SENSITIVE_VALUES, USER_2, OPERATOR_2]) expect(logged).not.toContain(v);
  });
});

describe('fail closed: a throwing store leaves a tombstone that evaluate consults (10871)', () => {
  let b: ReturnType<typeof breakable>;

  beforeEach(() => {
    admitBoth();
    b = breakable();
    wiring = makeWiring({ store: b.store });
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
    clock = at(T0_MS + HOUR_MS);
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

describe('scopeFromPairingStatus', () => {
  it('takes the scope and epoch from a paired status, null otherwise', () => {
    expect(
      scopeFromPairingStatus({
        kind: 'paired',
        tenant_id: TENANT,
        branch_id: BRANCH,
        terminal_id: TERMINAL,
        terminal_label: 'Till 1',
        paired_at: EPOCH,
      }),
    ).toEqual(scope());
    expect(scopeFromPairingStatus({ kind: 'unpaired' })).toBeNull();
    expect(scopeFromPairingStatus({ kind: 'invalid', reason: 'decrypt_failed' })).toBeNull();
  });
});

// ── The pairing purge (OD4) and a new epoch on every re-pair (F4) ───────────

const TOKEN_KEY: SecretKey = makeSecretKey('terminal.device-token');

function memorySecretStore(): SecretStore {
  const m = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(m.get(k) ?? null),
    set: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      m.delete(k);
      return Promise.resolve();
    },
    isProductionBacked: () => false,
  };
}

function pairInput(over: Partial<PersistInput> = {}): PersistInput {
  return {
    device_token: 'device-token-SECRET',
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    terminal_label: 'Till 1',
    paired_at: Math.floor(T0_MS / 1000),
    branch_name: null,
    branch_address: null,
    tenant_tax_registration_id: null,
    printer_vendor_id: null,
    printer_product_id: null,
    printer_com_port: null,
    ...over,
  };
}

describe('withOfflineGrantPairing — purge on every pairing change (OD4) and a new epoch (F4)', () => {
  let inner: PairingStore;
  let pairing: PairingStore;

  async function currentEpoch(): Promise<number> {
    const s = await pairing.getStatus();
    if (s.kind !== 'paired') throw new Error('not paired');
    return s.paired_at;
  }

  beforeEach(() => {
    inner = createPairingStore({
      secretStore: memorySecretStore(),
      db: bindPairingStoreDb(g.handle),
      deviceTokenKey: TOKEN_KEY,
    });
    pairing = withOfflineGrantPairing(inner, wiring);
    wiring.setScope(null);
  });

  it('persist purges every grant, audits each grant of the old scope (repair) and binds the new scope', async () => {
    await pairing.persist(pairInput());
    admitBoth();
    store.upsertFromAdmitted(scope({ terminal_id: 'terminal-old' }), admitted());
    expect(rows(g.raw, 'cashier_offline_grants')).toHaveLength(3);

    await pairing.persist(pairInput({ terminal_id: 'terminal-new' }));
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(audits.map(auditOf)).toEqual(
      expect.arrayContaining([
        { reason: 'repair', operator: OPERATOR },
        { reason: 'repair', operator: OPERATOR_2 },
      ]),
    );
    expect(audits).toHaveLength(2);
    admit();
    expect(body()).toMatchObject({
      terminal_id: 'terminal-new',
      pairing_epoch: await currentEpoch(),
    });
  });

  it('clear purges every grant, audits unpair and unbinds the scope', async () => {
    await pairing.persist(pairInput());
    admitBoth();
    await pairing.clear();
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(audits.map((a) => a.payload['reason'])).toEqual(['unpair', 'unpair']);
    expect((await pairing.getStatus()).kind).toBe('unpaired');
    admit();
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
  });

  it('every re-pair gets a new epoch, even with the same paired_at second', async () => {
    await pairing.persist(pairInput());
    const first = await currentEpoch();
    await pairing.clear();
    await pairing.persist(pairInput());
    const second = await currentEpoch();
    await pairing.persist(pairInput());
    const third = await currentEpoch();
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('F4: purge, re-pair with the same paired_at, and an old body written back is not admissible', async () => {
    await pairing.persist(pairInput());
    admit();
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
    const oldBody = grantBlob(g.raw);

    await pairing.clear();
    await pairing.persist(pairInput()); // the same paired_at second
    g.raw.run(
      `INSERT INTO cashier_offline_grants (tenant_id, branch_id, terminal_id, user_id, sealed_body, sealed_at)
       VALUES (?, ?, ?, ?, ?, 'x')`,
      [TENANT, BRANCH, TERMINAL, USER, oldBody],
    );
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('scope_mismatch'));
    expect(wiring.consumeOfflineUse(USER, T0)).toEqual(refusal('scope_mismatch'));
  });

  it('Codex P1 4181552529: a deleted mark, then unpair and a same-second re-pair: an old body written back is no proof', async () => {
    await pairing.persist(pairInput());
    admit();
    const oldBody = grantBlob(g.raw);
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    await pairing.clear();
    await pairing.persist(pairInput()); // the same paired_at second
    g.raw.run(
      `INSERT INTO cashier_offline_grants (tenant_id, branch_id, terminal_id, user_id, sealed_body, sealed_at)
       VALUES (?, ?, ?, ?, ?, 'x')`,
      [TENANT, BRANCH, TERMINAL, USER, oldBody],
    );
    expect(wiring.evaluate(USER, T0).admissible).toBe(false);
    expect(wiring.consumeOfflineUse(USER, T0).admissible).toBe(false);
  });

  it('Codex P1 4181552529: a deleted mark, then a same-second re-pair over the old pairing', async () => {
    await pairing.persist(pairInput());
    admit();
    const oldBody = grantBlob(g.raw);
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    await pairing.persist(pairInput());
    g.raw.run(
      `INSERT INTO cashier_offline_grants (tenant_id, branch_id, terminal_id, user_id, sealed_body, sealed_at)
       VALUES (?, ?, ?, ?, ?, 'x')`,
      [TENANT, BRANCH, TERMINAL, USER, oldBody],
    );
    expect(wiring.evaluate(USER, T0).admissible).toBe(false);
  });

  it('F4 without a clear: a re-pair over the old pairing in the same second', async () => {
    await pairing.persist(pairInput());
    admit();
    const oldBody = grantBlob(g.raw);
    await pairing.persist(pairInput());
    g.raw.run(
      `INSERT INTO cashier_offline_grants (tenant_id, branch_id, terminal_id, user_id, sealed_body, sealed_at)
       VALUES (?, ?, ?, ?, ?, 'x')`,
      [TENANT, BRANCH, TERMINAL, USER, oldBody],
    );
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('scope_mismatch'));
  });

  it('a failed purge refuses every user until the tick retries it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await pairing.persist(pairInput());
    admit();
    const b = breakable();
    b.broken.add('purgeAll');
    const w = makeWiring({ store: b.store });
    const p = withOfflineGrantPairing(inner, w);
    await p.persist(pairInput());
    w.start();
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    w.seam.onCashierAdmitted(current(w));
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    b.broken.clear();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    // The retried purge lifts the tombstone (and, fail closed, takes the fresh grant too).
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    w.seam.onCashierAdmitted(current(w));
    expect(w.evaluate(USER, T0).admissible).toBe(true);
    w.stop();
  });

  it('a failed persist rethrows and re-reads the scope from the pairing store', async () => {
    await pairing.persist(pairInput());
    const failing: PairingStore = {
      ...inner,
      persist: () => Promise.reject(new Error('disk full')),
    };
    const p = withOfflineGrantPairing(failing, wiring);
    await expect(p.persist(pairInput({ terminal_id: 'terminal-new' }))).rejects.toThrow(
      'disk full',
    );
    admit();
    expect(body()).toMatchObject({ terminal_id: TERMINAL });
  });

  it('passes every other method through to the pairing store', async () => {
    await pairing.persist(pairInput());
    expect(pairing.getCurrentTerminalId()).toBe(TERMINAL);
    expect(await pairing.getStatus()).toEqual(await inner.getStatus());
  });
});
