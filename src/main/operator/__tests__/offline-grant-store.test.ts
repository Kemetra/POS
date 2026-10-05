/**
 * RT-113 P1.1 — the sealed offline grant store (10763 D3/D4/D5/D10; plan 10871
 * §"PR P1.1"; owner approval 10874). Test-first.
 *
 * The store is pure and unwired: an injected `SafeStorageLike`, DB handle and
 * clock. These tests run it on the real migration stack (sql.js) with an
 * authenticated fake seal, and cover the 10871 P1.1 list:
 *   seal round-trip · expiry at exactly issued + min(ttl, 72 h) · the clamp ·
 *   grace 0 · the 9th use refused · clock rollback > 5 min · every scope field
 *   and the epoch mismatched · an unseal failure · a swapped body · an edited
 *   counter · a NULL body · no grant field in any log line.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseHandle } from '../../db/client.js';
import type { SafeStorageLike } from '../../secrets/safe-storage.js';
import {
  OFFLINE_CLOCK_TOLERANCE_MS,
  OFFLINE_GRANT_INVALIDATION_REASONS,
  OFFLINE_GRANT_MAX_TTL_MS,
  OFFLINE_GRANT_MAX_USES,
  OfflineGrantStoreError,
  createOfflineGrantStore,
  type OfflineGrantEvaluation,
  type OfflineGrantInvalidationReason,
  type OfflineGrantStore,
} from '../offline-grant-store.js';
import {
  ADMISSION,
  BRANCH,
  DISPLAY_NAME,
  EPOCH,
  HOUR_MS,
  MIN_MS,
  OPERATOR,
  SENSITIVE_VALUES,
  SERVER_TIME,
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
  setGrantBlob,
  type AeadSafeStorage,
  type GrantDb,
} from './__helpers__/offline-grant-fixture.js';

let g: GrantDb;
let ss: AeadSafeStorage;
let clock: Date;
let logCalls: unknown[][];

const logger = {
  info: (...args: unknown[]): void => {
    logCalls.push(['info', ...args]);
  },
  warn: (...args: unknown[]): void => {
    logCalls.push(['warn', ...args]);
  },
};

function makeStore(
  over: { safeStorage?: SafeStorageLike; handle?: DatabaseHandle } = {},
): OfflineGrantStore {
  return createOfflineGrantStore({
    db: over.handle ?? g.handle,
    safeStorage: over.safeStorage ?? ss,
    now: () => clock,
    logger,
  });
}

function throwing(): never {
  throw new Error('injected failure');
}

/** The seal fails (DPAPI unavailable mid-run). */
function failingSealStore(): OfflineGrantStore {
  return makeStore({ safeStorage: { ...ss, encryptString: throwing } });
}

/** The unseal fails. */
function failingUnsealStore(): OfflineGrantStore {
  return makeStore({ safeStorage: { ...ss, decryptString: throwing } });
}

/** Every statement fails to prepare (disk or I/O error). */
function deadDbStore(): OfflineGrantStore {
  return makeStore({ handle: { ...g.handle, prepare: throwing } });
}

let store: OfflineGrantStore;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  g = grantDb();
  ss = aeadSafeStorage();
  clock = T0;
  logCalls = [];
  store = makeStore();
});

afterEach(() => {
  g.raw.close();
});

function refusal(category: string): OfflineGrantEvaluation {
  return { admissible: false, category } as OfflineGrantEvaluation;
}

function categoryOf(e: OfflineGrantEvaluation): string {
  return e.admissible ? 'admissible' : e.category;
}

/** Unseal a grant row's body with the test seal (the fake is ours, so we may). */
function openBody(user = USER): Record<string, unknown> {
  return JSON.parse(ss.decryptString(grantBlob(g.raw, user))) as Record<string, unknown>;
}

/**
 * Re-seal an edited body with the SAME seal: the body is authentic, so this
 * isolates the store's own checks (binding, strict parse, clamp) from DPAPI's.
 */
function forgeBody(edit: (b: Record<string, unknown>) => void, user = USER): void {
  const body = openBody(user);
  edit(body);
  setGrantBlob(g.raw, ss.encryptString(JSON.stringify(body)), user);
}

function grantCount(): number {
  return rows(g.raw, 'cashier_offline_grants').length;
}

function hwmCount(): number {
  return rows(g.raw, 'cashier_offline_clock_hwm').length;
}

/** Write an authentic (correctly sealed) clock mark: an older mark written back. */
function setHwm(hwm_ms: number): void {
  const blob = ss.encryptString(
    JSON.stringify({ v: 1, kind: 'cashier_offline_clock_hwm', hwm_ms }),
  );
  g.raw.run('UPDATE cashier_offline_clock_hwm SET sealed_body = ? WHERE id = 1', [blob]);
}

/** Re-create the grant table WITHOUT its NOT NULL / CHECKs: a hand-edited file. */
function relaxGrantSchema(): void {
  g.raw.exec(`DROP TABLE cashier_offline_grants;
    CREATE TABLE cashier_offline_grants (tenant_id TEXT, branch_id TEXT, terminal_id TEXT,
      user_id TEXT, sealed_body, sealed_at TEXT,
      PRIMARY KEY (tenant_id, branch_id, terminal_id, user_id));`);
}

function insertRaw(body: unknown, user = USER): void {
  g.raw.run(
    `INSERT INTO cashier_offline_grants (tenant_id, branch_id, terminal_id, user_id, sealed_body, sealed_at)
     VALUES (?, ?, ?, ?, ?, 'x')`,
    [TENANT, BRANCH, TERMINAL, user, body as Uint8Array | string | null],
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('constants (10763 D4)', () => {
  it('fixes the bounds: 72 h ceiling, 8 uses, 5 min clock tolerance', () => {
    expect(OFFLINE_GRANT_MAX_TTL_MS).toBe(72 * HOUR_MS);
    expect(OFFLINE_GRANT_MAX_USES).toBe(8);
    expect(OFFLINE_CLOCK_TOLERANCE_MS).toBe(5 * MIN_MS);
  });

  it('closes the invalidation reasons (OD6 superseded, OD8 grace_disabled)', () => {
    expect([...OFFLINE_GRANT_INVALIDATION_REASONS].sort()).toEqual(
      [
        'device_unauthorized',
        'forbidden',
        'grace_disabled',
        'refresh_failed',
        'repair',
        'superseded',
        'unpair',
      ].sort(),
    );
  });
});

describe('upsertFromAdmitted — seal round-trip', () => {
  it('writes a grant that evaluates admissible with the admitted identity', () => {
    expect(store.upsertFromAdmitted(scope(), admitted())).toEqual({ kind: 'written' });
    expect(store.evaluate(scope(), USER, T0)).toEqual({
      admissible: true,
      grant: {
        user_id: USER,
        operator_id: OPERATOR,
        display_name: DISPLAY_NAME,
        admission_id: ADMISSION,
        issued_at_local_ms: T0_MS,
        expires_at_local_ms: T0_MS + 24 * HOUR_MS,
        offline_admissions_used: 0,
        offline_admissions_remaining: 8,
      },
    });
  });

  it('stores every grant field under the seal, none in plain text', () => {
    store.upsertFromAdmitted(scope(), admitted());
    const [row] = rows(g.raw, 'cashier_offline_grants');
    const plainColumns = JSON.stringify({ ...row, sealed_body: undefined });
    const blobText = grantBlob(g.raw).toString('latin1');
    for (const v of [OPERATOR, DISPLAY_NAME, ADMISSION, SERVER_TIME]) {
      expect(blobText).not.toContain(v);
      expect(plainColumns).not.toContain(v);
    }
    expect(openBody()).toEqual({
      v: 1,
      kind: 'cashier_offline_grant',
      tenant_id: TENANT,
      branch_id: BRANCH,
      terminal_id: TERMINAL,
      user_id: USER,
      pairing_epoch: EPOCH,
      admission_id: ADMISSION,
      operator_id: OPERATOR,
      display_name: DISPLAY_NAME,
      issued_at_local: T0_MS,
      ttl_ms: 24 * HOUR_MS,
      server_time_at_issue: SERVER_TIME,
      offline_admissions_used: 0,
      last_used_at_local: null,
      invalidated: null,
    });
  });

  it('takes issued_at_local from the local receipt time, not server_time (D4)', () => {
    store.upsertFromAdmitted(
      scope(),
      admitted({ server_time: '2020-01-01T00:00:00.000Z', received_at: T0.toISOString() }),
    );
    expect(openBody()['issued_at_local']).toBe(T0_MS);
  });

  it('a refresh resets the counter and clears an invalidation', () => {
    store.upsertFromAdmitted(scope(), admitted());
    store.consumeOfflineUse(scope(), USER, T0);
    store.consumeOfflineUse(scope(), USER, T0);
    store.invalidate(scope(), USER, 'forbidden');
    expect(categoryOf(store.evaluate(scope(), USER, T0))).toBe('grant_invalidated');

    store.upsertFromAdmitted(scope(), admitted({ admission_id: 'adm-2' }));
    const e = store.evaluate(scope(), USER, T0);
    expect(e.admissible && e.grant.offline_admissions_used).toBe(0);
    expect(e.admissible && e.grant.admission_id).toBe('adm-2');
    expect(openBody()['invalidated']).toBeNull();
  });

  // Codex P2 4180957481: the contract types display_name as any string, and
  // the admission client accepts "". Writing and re-reading use the same rule.
  it('accepts an empty display name: the grant is written and admissible', () => {
    store.upsertFromAdmitted(scope(), admitted());
    expect(store.upsertFromAdmitted(scope(), admitted({ display_name: '' }))).toEqual({
      kind: 'written',
    });
    const e = store.evaluate(scope(), USER, T0);
    expect(e.admissible && e.grant.display_name).toBe('');
    expect(store.consumeOfflineUse(scope(), USER, T0).admissible).toBe(true);
  });

  it('still rejects a non-string display name', () => {
    store.upsertFromAdmitted(scope(), admitted());
    expect(
      store.upsertFromAdmitted(scope(), admitted({ display_name: 7 as unknown as string })).kind,
    ).toBe('rejected');
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_invalidated'));
  });

  it('keeps one row per (scope, user)', () => {
    store.upsertFromAdmitted(scope(), admitted());
    store.upsertFromAdmitted(scope(), admitted());
    store.upsertFromAdmitted(scope(), admitted({ user_id: 'user-2' }));
    expect(grantCount()).toBe(2);
  });

  it('raises the clock high-water mark on a write (OD7)', () => {
    clock = at(T0_MS + 10 * HOUR_MS);
    store.upsertFromAdmitted(scope(), admitted());
    expect(hwmCount()).toBe(1);
    expect(categoryOf(store.evaluate(scope(), USER, at(T0_MS + 9 * HOUR_MS)))).toBe(
      'clock_suspect',
    );
  });
});

describe('upsertFromAdmitted — the 72 h clamp and grace 0 (D4, OD8)', () => {
  it('clamps a longer server grace to 72 h', () => {
    store.upsertFromAdmitted(scope(), admitted({ offline_grace_seconds: 100 * 3600 }));
    expect(openBody()['ttl_ms']).toBe(OFFLINE_GRANT_MAX_TTL_MS);
    expect(store.evaluate(scope(), USER, at(T0_MS + 72 * HOUR_MS - 1)).admissible).toBe(true);
    expect(categoryOf(store.evaluate(scope(), USER, at(T0_MS + 72 * HOUR_MS)))).toBe(
      'grant_expired',
    );
  });

  it('keeps a grace at or under 72 h as given', () => {
    store.upsertFromAdmitted(scope(), admitted({ offline_grace_seconds: 72 * 3600 }));
    expect(openBody()['ttl_ms']).toBe(72 * HOUR_MS);
    store.upsertFromAdmitted(scope(), admitted({ offline_grace_seconds: 1 }));
    expect(openBody()['ttl_ms']).toBe(1000);
  });

  // Codex P2 4180957478: the contract sets no maximum and the client accepts
  // any integer >= 0, so a huge grace is clamped (before x1000), never rejected.
  it.each([
    ['72 h + 1 s', 72 * 3600 + 1],
    ['1e13 s', 1e13],
    ['Number.MAX_SAFE_INTEGER s', Number.MAX_SAFE_INTEGER],
    ['Number.MAX_VALUE s (an integer to JS)', Number.MAX_VALUE],
  ])('clamps a grace of %s to 72 h and replaces the old grant', (_label, grace) => {
    store.upsertFromAdmitted(scope(), admitted());
    store.consumeOfflineUse(scope(), USER, T0);
    expect(
      store.upsertFromAdmitted(
        scope(),
        admitted({ offline_grace_seconds: grace, admission_id: 'adm-2' }),
      ),
    ).toEqual({ kind: 'written' });
    expect(openBody()['ttl_ms']).toBe(OFFLINE_GRANT_MAX_TTL_MS);
    const e = store.evaluate(scope(), USER, at(T0_MS + 72 * HOUR_MS - 1));
    expect(e.admissible && e.grant.admission_id).toBe('adm-2');
    expect(e.admissible && e.grant.offline_admissions_used).toBe(0);
    expect(store.evaluate(scope(), USER, at(T0_MS + 72 * HOUR_MS))).toEqual(
      refusal('grant_expired'),
    );
  });

  it('grace 0 writes nothing', () => {
    expect(store.upsertFromAdmitted(scope(), admitted({ offline_grace_seconds: 0 }))).toEqual({
      kind: 'grace_disabled',
      invalidated: [],
    });
    expect(grantCount()).toBe(0);
    expect(categoryOf(store.evaluate(scope(), USER, T0))).toBe('grant_missing');
  });

  it('grace 0 invalidates an existing grant', () => {
    store.upsertFromAdmitted(scope(), admitted());
    expect(store.upsertFromAdmitted(scope(), admitted({ offline_grace_seconds: 0 }))).toEqual({
      kind: 'grace_disabled',
      invalidated: [{ user_id: USER, operator_id: OPERATOR }],
    });
    expect(categoryOf(store.evaluate(scope(), USER, T0))).toBe('grant_invalidated');
    expect(openBody()['invalidated']).toEqual({ reason: 'grace_disabled', at_local: T0_MS });
  });
});

describe('upsertFromAdmitted — malformed input and failed writes fail closed', () => {
  it.each([
    ['a negative grace', { offline_grace_seconds: -1 }],
    ['a fractional grace', { offline_grace_seconds: 1.5 }],
    ['a NaN grace', { offline_grace_seconds: Number.NaN }],
    ['an infinite grace', { offline_grace_seconds: Number.POSITIVE_INFINITY }],
    ['an unparseable receipt time', { received_at: 'yesterday' }],
    ['an empty operator_id', { operator_id: '' }],
    ['an empty admission_id', { admission_id: '' }],
    ['a non-string server_time', { server_time: 7 as unknown as string }],
  ])('rejects %s and invalidates the existing grant', (_label, over) => {
    store.upsertFromAdmitted(scope(), admitted());
    expect(store.upsertFromAdmitted(scope(), admitted(over))).toEqual({
      kind: 'rejected',
      invalidated: [{ user_id: USER, operator_id: OPERATOR }],
    });
    expect(categoryOf(store.evaluate(scope(), USER, T0))).toBe('grant_invalidated');
    expect(openBody()['invalidated']).toMatchObject({ reason: 'refresh_failed' });
  });

  it('rejects a malformed event without writing when there is no grant', () => {
    expect(store.upsertFromAdmitted(scope(), admitted({ offline_grace_seconds: -1 }))).toEqual({
      kind: 'rejected',
      invalidated: [],
    });
    expect(grantCount()).toBe(0);
  });

  it.each([
    ['an empty user_id', scope(), admitted({ user_id: '' })],
    ['an empty tenant', scope({ tenant_id: '' }), admitted()],
    ['a fractional epoch', scope({ pairing_epoch: 1.5 }), admitted()],
    ['a negative epoch', scope({ pairing_epoch: -1 }), admitted()],
  ])('throws invalid_input for %s (nothing addressable)', (_label, sc, ev) => {
    let err: unknown;
    try {
      store.upsertFromAdmitted(sc, ev);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OfflineGrantStoreError);
    expect((err as OfflineGrantStoreError).category).toBe('invalid_input');
    expect(grantCount()).toBe(0);
  });

  it('a failed seal on refresh removes the old grant and throws storage (fail closed)', () => {
    store.upsertFromAdmitted(scope(), admitted());
    const broken = failingSealStore();
    let err: unknown;
    try {
      broken.upsertFromAdmitted(scope(), admitted({ admission_id: 'adm-2' }));
    } catch (e) {
      err = e;
    }
    expect((err as OfflineGrantStoreError).category).toBe('storage');
    expect(categoryOf(store.evaluate(scope(), USER, T0))).toBe('grant_missing');
  });

  it('refuses to write when encryption is unavailable, and removes the old grant', () => {
    store.upsertFromAdmitted(scope(), admitted());
    const off = makeStore({ safeStorage: { ...ss, isEncryptionAvailable: () => false } });
    expect(() => off.upsertFromAdmitted(scope(), admitted())).toThrow(OfflineGrantStoreError);
    expect(categoryOf(store.evaluate(scope(), USER, T0))).toBe('grant_missing');
  });
});

describe('evaluate — expiry at exactly issued_at_local + min(ttl, 72 h)', () => {
  beforeEach(() => {
    store.upsertFromAdmitted(scope(), admitted());
  });

  it('is admissible one millisecond before expiry and expired at it', () => {
    expect(store.evaluate(scope(), USER, at(T0_MS + 24 * HOUR_MS - 1)).admissible).toBe(true);
    expect(store.evaluate(scope(), USER, at(T0_MS + 24 * HOUR_MS))).toEqual(
      refusal('grant_expired'),
    );
  });

  it('clamps at read time too: an authentic body with a longer ttl still ends at 72 h', () => {
    forgeBody((b) => {
      b['ttl_ms'] = 100 * HOUR_MS;
    });
    expect(store.evaluate(scope(), USER, at(T0_MS + 72 * HOUR_MS - 1)).admissible).toBe(true);
    expect(store.evaluate(scope(), USER, at(T0_MS + 72 * HOUR_MS))).toEqual(
      refusal('grant_expired'),
    );
  });
});

describe('consumeOfflineUse — the 8-use budget', () => {
  beforeEach(() => {
    store.upsertFromAdmitted(scope(), admitted());
  });

  it('allows 8 uses and refuses the 9th', () => {
    for (let i = 1; i <= 8; i += 1) {
      const e = store.consumeOfflineUse(scope(), USER, T0);
      expect(e.admissible && e.grant.offline_admissions_used).toBe(i);
      expect(e.admissible && e.grant.offline_admissions_remaining).toBe(8 - i);
    }
    expect(store.consumeOfflineUse(scope(), USER, T0)).toEqual(refusal('count_exhausted'));
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('count_exhausted'));
  });

  it('persists the counter under the seal (a new store instance sees it)', () => {
    store.consumeOfflineUse(scope(), USER, T0);
    store.consumeOfflineUse(scope(), USER, T0);
    expect(openBody()['offline_admissions_used']).toBe(2);
    const e = makeStore().evaluate(scope(), USER, T0);
    expect(e.admissible && e.grant.offline_admissions_used).toBe(2);
  });

  it('records the use time under the seal', () => {
    store.consumeOfflineUse(scope(), USER, at(T0_MS + HOUR_MS));
    expect(openBody()['last_used_at_local']).toBe(T0_MS + HOUR_MS);
  });

  it('does not consume a refused grant', () => {
    const before = grantBlob(g.raw);
    expect(store.consumeOfflineUse(scope(), USER, at(T0_MS + 25 * HOUR_MS))).toEqual(
      refusal('grant_expired'),
    );
    expect(grantBlob(g.raw).equals(before)).toBe(true);
  });

  it('refuses (storage) and keeps the counter when the re-seal fails', () => {
    const failing = failingSealStore();
    expect(failing.consumeOfflineUse(scope(), USER, T0)).toEqual(refusal('storage'));
    expect(openBody()['offline_admissions_used']).toBe(0);
  });

  it('refuses (storage) when the row changed under it (compare-and-swap lost)', () => {
    const lossy: DatabaseHandle = {
      ...g.handle,
      prepare(sql: string): unknown {
        const stmt = g.handle.prepare(sql) as { run: (...a: unknown[]) => unknown };
        if (!/^\s*UPDATE cashier_offline_grants/i.test(sql)) return stmt;
        return { ...stmt, run: () => ({ changes: 0, lastInsertRowid: 0 }) };
      },
    };
    expect(makeStore({ handle: lossy }).consumeOfflineUse(scope(), USER, T0)).toEqual(
      refusal('storage'),
    );
    expect(openBody()['offline_admissions_used']).toBe(0);
  });
});

describe('evaluate — clock high-water mark (OD7)', () => {
  beforeEach(() => {
    store.upsertFromAdmitted(scope(), admitted());
  });

  it('refuses clock_suspect only when now < hwm − 5 min', () => {
    const hwm = T0_MS + 10 * HOUR_MS;
    expect(store.observeClock(at(hwm))).toEqual({ kind: 'raised' });
    expect(store.evaluate(scope(), USER, at(hwm - OFFLINE_CLOCK_TOLERANCE_MS)).admissible).toBe(
      true,
    );
    expect(store.evaluate(scope(), USER, at(hwm - OFFLINE_CLOCK_TOLERANCE_MS - 1))).toEqual(
      refusal('clock_suspect'),
    );
  });

  it('never lowers the mark', () => {
    store.observeClock(at(T0_MS + 10 * HOUR_MS));
    expect(store.observeClock(at(T0_MS))).toEqual({ kind: 'unchanged' });
    expect(store.evaluate(scope(), USER, at(T0_MS + HOUR_MS))).toEqual(refusal('clock_suspect'));
  });

  it('an evaluate raises the mark itself', () => {
    store.evaluate(scope(), USER, at(T0_MS + 10 * HOUR_MS));
    expect(store.evaluate(scope(), USER, at(T0_MS + HOUR_MS))).toEqual(refusal('clock_suspect'));
  });

  it('a consume raises the mark itself', () => {
    store.consumeOfflineUse(scope(), USER, at(T0_MS + 10 * HOUR_MS));
    expect(store.evaluate(scope(), USER, at(T0_MS + HOUR_MS))).toEqual(refusal('clock_suspect'));
  });

  // RT-113 P1.2 F2 (10893): P1.1 let a grant floor the clock when the mark row
  // was DELETED, so a deleted mark plus a clock rollback within the grant's own
  // floor still admitted. P1.2 reverses that: a missing mark while any grant row
  // exists is `storage`. The grant floor is still covered below, against an
  // OLDER mark written back (the mark is present, just behind the grant).
  it('F2: with the mark row deleted while a grant exists, evaluate and consume refuse storage', () => {
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('storage'));
    expect(store.consumeOfflineUse(scope(), USER, T0)).toEqual(refusal('storage'));
    expect(openBody()['offline_admissions_used']).toBe(0);
    expect(hwmCount()).toBe(0);
  });

  it('F2: a tick does not recreate a missing mark while a grant exists; an online write repairs it', () => {
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    expect(store.observeClock(at(T0_MS + HOUR_MS))).toEqual({ kind: 'unavailable' });
    expect(hwmCount()).toBe(0);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('storage'));
    store.upsertFromAdmitted(scope(), admitted());
    expect(hwmCount()).toBe(1);
    expect(store.evaluate(scope(), USER, T0).admissible).toBe(true);
  });

  it('F2: a missing mark with no grant at all is a first run: a tick creates it', () => {
    store.purgeAll();
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    expect(store.observeClock(T0)).toEqual({ kind: 'raised' });
    expect(hwmCount()).toBe(1);
  });

  it('with an older mark written back, the grant itself still floors the clock at issue time', () => {
    setHwm(T0_MS - 10 * HOUR_MS);
    expect(store.evaluate(scope(), USER, at(T0_MS - OFFLINE_CLOCK_TOLERANCE_MS)).admissible).toBe(
      true,
    );
    setHwm(T0_MS - 10 * HOUR_MS);
    expect(store.evaluate(scope(), USER, at(T0_MS - OFFLINE_CLOCK_TOLERANCE_MS - 1))).toEqual(
      refusal('clock_suspect'),
    );
  });

  it('with an older mark written back, the last use floors the clock too', () => {
    const used = T0_MS + 5 * HOUR_MS;
    store.consumeOfflineUse(scope(), USER, at(used));
    setHwm(T0_MS - 10 * HOUR_MS);
    expect(store.evaluate(scope(), USER, at(used - OFFLINE_CLOCK_TOLERANCE_MS - 1))).toEqual(
      refusal('clock_suspect'),
    );
  });

  it('an unreadable mark refuses (storage), is not overwritten by a tick, and an online write repairs it', () => {
    g.raw.run(`UPDATE cashier_offline_clock_hwm SET sealed_body = x'00010203'`);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('storage'));
    expect(store.observeClock(at(T0_MS + HOUR_MS))).toEqual({ kind: 'unavailable' });
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('storage'));
    store.upsertFromAdmitted(scope(), admitted());
    expect(store.evaluate(scope(), USER, T0).admissible).toBe(true);
  });

  it('observeClock never throws on a storage failure', () => {
    const broken = deadDbStore();
    expect(broken.observeClock(T0)).toEqual({ kind: 'unavailable' });
  });
});

describe('evaluate — scope and pairing epoch (D5, OD4)', () => {
  beforeEach(() => {
    store.upsertFromAdmitted(scope(), admitted());
  });

  it.each([
    ['tenant_id', { tenant_id: 'tenant-other' }],
    ['branch_id', { branch_id: 'branch-other' }],
    ['terminal_id', { terminal_id: 'terminal-other' }],
  ])('a different %s finds no proof', (_label, over) => {
    expect(store.evaluate(scope(over), USER, T0).admissible).toBe(false);
  });

  it('a different user finds no proof', () => {
    expect(store.evaluate(scope(), 'user-other', T0)).toEqual(refusal('grant_missing'));
  });

  it('a different pairing epoch (re-pair) finds no proof', () => {
    expect(store.evaluate(scope({ pairing_epoch: EPOCH + 1 }), USER, T0)).toEqual(
      refusal('scope_mismatch'),
    );
  });

  it.each([
    ['an empty tenant', scope({ tenant_id: '' }), USER],
    ['an empty branch', scope({ branch_id: '' }), USER],
    ['an empty terminal', scope({ terminal_id: '' }), USER],
    ['a NaN epoch', scope({ pairing_epoch: Number.NaN }), USER],
    ['an empty user', scope(), ''],
  ])('%s is no proof, never a throw', (_label, sc, user) => {
    expect(store.evaluate(sc, user, T0)).toEqual(refusal('scope_mismatch'));
  });
});

describe('evaluate — unseal and read failures are no proof (D10)', () => {
  beforeEach(() => {
    store.upsertFromAdmitted(scope(), admitted());
  });

  it('a body sealed under another key (another Windows profile) is storage', () => {
    expect(makeStore({ safeStorage: aeadSafeStorage() }).evaluate(scope(), USER, T0)).toEqual(
      refusal('storage'),
    );
  });

  it('a throwing decrypt is storage', () => {
    const failing = failingUnsealStore();
    expect(failing.evaluate(scope(), USER, T0)).toEqual(refusal('storage'));
    expect(failing.consumeOfflineUse(scope(), USER, T0)).toEqual(refusal('storage'));
  });

  it('a failing read is storage, never a throw', () => {
    const broken = deadDbStore();
    expect(broken.evaluate(scope(), USER, T0)).toEqual(refusal('storage'));
    expect(broken.consumeOfflineUse(scope(), USER, T0)).toEqual(refusal('storage'));
  });
});

describe('evaluate — tampering is no proof (OD2, OD3)', () => {
  beforeEach(() => {
    store.upsertFromAdmitted(scope(), admitted());
  });

  it('a body swapped in from another user row is tampered', () => {
    store.upsertFromAdmitted(scope(), admitted({ user_id: 'user-2', operator_id: 'op-2' }));
    setGrantBlob(g.raw, grantBlob(g.raw, 'user-2'), USER);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('tampered'));
  });

  it.each([
    ['tenant_id', 'tenant-moved', { tenant_id: 'tenant-moved' }],
    ['branch_id', 'branch-moved', { branch_id: 'branch-moved' }],
    ['terminal_id', 'terminal-moved', { terminal_id: 'terminal-moved' }],
  ])('a row whose %s was edited is tampered', (col, value, over) => {
    g.raw.run(`UPDATE cashier_offline_grants SET ${col} = ?`, [value]);
    expect(store.evaluate(scope(over), USER, T0)).toEqual(refusal('tampered'));
  });

  it('a row whose user_id was edited is tampered', () => {
    g.raw.run(`UPDATE cashier_offline_grants SET user_id = 'user-moved'`);
    expect(store.evaluate(scope(), 'user-moved', T0)).toEqual(refusal('tampered'));
  });

  it('an edited ciphertext byte (counter or invalidation edited in place) is storage', () => {
    const blob = grantBlob(g.raw);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0x01;
    setGrantBlob(g.raw, blob);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('storage'));
  });

  it.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['a string', '0'],
    ['null', null],
  ])('an authentic body with a %s counter is tampered', (_label, value) => {
    forgeBody((b) => {
      b['offline_admissions_used'] = value;
    });
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('tampered'));
  });

  it('an authentic body without its counter is tampered (never a fresh budget)', () => {
    forgeBody((b) => {
      delete b['offline_admissions_used'];
    });
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('tampered'));
  });

  it('an authentic body without its invalidation field is tampered', () => {
    forgeBody((b) => {
      delete b['invalidated'];
    });
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('tampered'));
  });

  it.each([
    ['an unknown reason', { reason: 'bogus', at_local: T0_MS }],
    ['no time', { reason: 'forbidden' }],
    ['a scalar', 'forbidden'],
  ])('an authentic body whose invalidation is %s is tampered', (_label, value) => {
    forgeBody((b) => {
      b['invalidated'] = value;
    });
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('tampered'));
  });

  it.each([
    ['an extra field', (b: Record<string, unknown>) => (b['admin'] = true)],
    ['another version', (b: Record<string, unknown>) => (b['v'] = 2)],
    ['another kind', (b: Record<string, unknown>) => (b['kind'] = 'cashier_offline_clock_hwm')],
    ['an empty operator_id', (b: Record<string, unknown>) => (b['operator_id'] = '')],
    ['a zero ttl', (b: Record<string, unknown>) => (b['ttl_ms'] = 0)],
    ['a string issue time', (b: Record<string, unknown>) => (b['issued_at_local'] = 'now')],
    ['a string epoch', (b: Record<string, unknown>) => (b['pairing_epoch'] = String(EPOCH))],
    ['a string last use', (b: Record<string, unknown>) => (b['last_used_at_local'] = 'x')],
  ])('an authentic body with %s is tampered', (_label, edit) => {
    forgeBody(edit);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('tampered'));
  });

  it('an authentic body that is not JSON is tampered', () => {
    setGrantBlob(g.raw, ss.encryptString('not json'));
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('tampered'));
    setGrantBlob(g.raw, ss.encryptString('[1,2]'));
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('tampered'));
  });
});

describe('evaluate — rows not written from an online admitted event (OD2)', () => {
  // F2 (P1.2): a grant row with no clock mark is refused `storage` before the
  // row is read. Seed the mark so these tests still reach the row checks.
  beforeEach(() => {
    store.observeClock(T0);
  });

  it('a NULL-body row (provisioning-only) is no grant', () => {
    relaxGrantSchema();
    insertRaw(null);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_missing'));
    expect(store.consumeOfflineUse(scope(), USER, T0)).toEqual(refusal('grant_missing'));
  });

  it('an empty or text body is no grant', () => {
    relaxGrantSchema();
    insertRaw(new Uint8Array([]));
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_missing'));
    g.raw.run('DELETE FROM cashier_offline_grants');
    insertRaw('{"display_name":"x"}');
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_missing'));
  });

  it('a manually inserted plaintext grant body is no proof', () => {
    store.upsertFromAdmitted(scope(), admitted());
    const body = openBody();
    g.raw.run('DELETE FROM cashier_offline_grants');
    insertRaw(Buffer.from(JSON.stringify(body), 'utf8'));
    expect(store.evaluate(scope(), USER, T0).admissible).toBe(false);
  });
});

describe('invalidate (D4, OD6)', () => {
  beforeEach(() => {
    store.upsertFromAdmitted(scope(), admitted());
    store.upsertFromAdmitted(scope(), admitted({ user_id: 'user-2', operator_id: 'op-2' }));
  });

  it.each(OFFLINE_GRANT_INVALIDATION_REASONS)('reason %s invalidates that user only', (reason) => {
    expect(store.invalidate(scope(), USER, reason)).toEqual({
      invalidated: [{ user_id: USER, operator_id: OPERATOR }],
      removed_unreadable: 0,
    });
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(store.evaluate(scope(), 'user-2', T0).admissible).toBe(true);
    expect(openBody()['invalidated']).toEqual({ reason, at_local: T0_MS });
  });

  it('keeps the invalidation under the seal and leaves the row in place', () => {
    store.invalidate(scope(), USER, 'superseded');
    expect(grantCount()).toBe(2);
    expect(JSON.stringify(rows(g.raw, 'cashier_offline_grants'))).not.toContain('superseded');
  });

  it('is idempotent: a second invalidation reports nothing and keeps the first reason', () => {
    store.invalidate(scope(), USER, 'forbidden');
    expect(store.invalidate(scope(), USER, 'superseded').invalidated).toEqual([]);
    expect(openBody()['invalidated']).toMatchObject({ reason: 'forbidden' });
  });

  it('an absent grant is a no-op', () => {
    expect(store.invalidate(scope(), 'user-none', 'forbidden')).toEqual({
      invalidated: [],
      removed_unreadable: 0,
    });
  });

  it('an unreadable row is removed', () => {
    setGrantBlob(g.raw, Buffer.from([9, 9, 9]));
    expect(store.invalidate(scope(), USER, 'forbidden')).toEqual({
      invalidated: [],
      removed_unreadable: 1,
    });
    expect(grantCount()).toBe(1);
  });

  it('a body of another user row is removed, never re-sealed as this user', () => {
    setGrantBlob(g.raw, grantBlob(g.raw, 'user-2'), USER);
    expect(store.invalidate(scope(), USER, 'forbidden').removed_unreadable).toBe(1);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_missing'));
  });

  it('a failed re-seal falls back to deleting the grant (fail closed)', () => {
    const failing = failingSealStore();
    expect(failing.invalidate(scope(), USER, 'forbidden').invalidated).toEqual([
      { user_id: USER, operator_id: OPERATOR },
    ]);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_missing'));
  });

  it('throws storage when even the delete fails', () => {
    const dead = deadDbStore();
    expect(() => dead.invalidate(scope(), USER, 'forbidden')).toThrow(OfflineGrantStoreError);
  });

  it('refuses a reason outside the closed set', () => {
    expect(() =>
      store.invalidate(scope(), USER, 'because' as OfflineGrantInvalidationReason),
    ).toThrow(OfflineGrantStoreError);
    expect(store.evaluate(scope(), USER, T0).admissible).toBe(true);
  });

  it('refuses an unaddressable scope or user', () => {
    expect(() => store.invalidate(scope({ terminal_id: '' }), USER, 'forbidden')).toThrow(
      OfflineGrantStoreError,
    );
    expect(() => store.invalidate(scope(), '', 'forbidden')).toThrow(OfflineGrantStoreError);
  });
});

describe('invalidateAll and purgeAll (D4 device 401, OD4 re-pair)', () => {
  beforeEach(() => {
    store.upsertFromAdmitted(scope(), admitted());
    store.upsertFromAdmitted(scope(), admitted({ user_id: 'user-2', operator_id: 'op-2' }));
    store.upsertFromAdmitted(scope({ terminal_id: 'terminal-old' }), admitted());
  });

  it('invalidates every grant of the scope and reports each for attribution (OD10)', () => {
    const r = store.invalidateAll(scope(), 'device_unauthorized');
    expect(r.invalidated).toEqual(
      expect.arrayContaining([
        { user_id: USER, operator_id: OPERATOR },
        { user_id: 'user-2', operator_id: 'op-2' },
      ]),
    );
    expect(r.invalidated).toHaveLength(2);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(store.evaluate(scope(), 'user-2', T0)).toEqual(refusal('grant_invalidated'));
  });

  it('removes unreadable rows of the scope', () => {
    setGrantBlob(g.raw, Buffer.from([1]), 'user-2');
    expect(store.invalidateAll(scope(), 'repair')).toMatchObject({ removed_unreadable: 1 });
  });

  it('refuses a reason outside the closed set', () => {
    expect(() => store.invalidateAll(scope(), 'because' as OfflineGrantInvalidationReason)).toThrow(
      OfflineGrantStoreError,
    );
  });

  it('throws storage when the scope cannot be read', () => {
    const dead = deadDbStore();
    expect(() => dead.invalidateAll(scope(), 'unpair')).toThrow(OfflineGrantStoreError);
  });

  it('purgeAll deletes every grant on the device and keeps the clock mark', () => {
    expect(store.purgeAll()).toEqual({ removed: 3 });
    expect(grantCount()).toBe(0);
    expect(hwmCount()).toBe(1);
  });

  it('purgeAll throws storage when the delete fails', () => {
    const dead = deadDbStore();
    expect(() => dead.purgeAll()).toThrow(OfflineGrantStoreError);
  });
});

describe('nextPairingEpoch — every re-pair gets a new epoch (F4)', () => {
  it('keeps a candidate above the mark and raises the mark to it', () => {
    store.observeClock(T0);
    const candidate = Math.floor(T0_MS / 1000) + 60;
    expect(store.nextPairingEpoch(candidate)).toBe(candidate);
    expect(store.observeClock(at(candidate * 1000 - 1))).toEqual({ kind: 'unchanged' });
  });

  it('a repeated paired_at (1 s granularity) still gets a strictly greater epoch', () => {
    const candidate = Math.floor(T0_MS / 1000);
    const first = store.nextPairingEpoch(candidate);
    const second = store.nextPairingEpoch(candidate);
    const third = store.nextPairingEpoch(candidate);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('is above the epoch of every grant written on this device', () => {
    store.upsertFromAdmitted(scope({ pairing_epoch: Math.floor(T0_MS / 1000) }), admitted());
    expect(store.nextPairingEpoch(Math.floor(T0_MS / 1000))).toBeGreaterThan(
      Math.floor(T0_MS / 1000),
    );
  });

  it('F4: purge, re-pair with the same paired_at, and an old body written back is no proof', () => {
    const pairedAt = Math.floor(T0_MS / 1000);
    const epoch1 = store.nextPairingEpoch(pairedAt);
    store.upsertFromAdmitted(scope({ pairing_epoch: epoch1 }), admitted());
    const oldBody = grantBlob(g.raw);
    expect(store.evaluate(scope({ pairing_epoch: epoch1 }), USER, T0).admissible).toBe(true);

    store.purgeAll();
    const epoch2 = store.nextPairingEpoch(pairedAt);
    expect(epoch2).not.toBe(epoch1);
    insertRaw(oldBody);
    expect(store.evaluate(scope({ pairing_epoch: epoch2 }), USER, T0)).toEqual(
      refusal('scope_mismatch'),
    );
    expect(store.consumeOfflineUse(scope({ pairing_epoch: epoch2 }), USER, T0)).toEqual(
      refusal('scope_mismatch'),
    );
  });

  it('an unreadable mark is not overwritten: the candidate is kept and offline stays refused', () => {
    store.upsertFromAdmitted(scope(), admitted());
    g.raw.run(`UPDATE cashier_offline_clock_hwm SET sealed_body = x'00010203'`);
    expect(store.nextPairingEpoch(EPOCH + 5)).toBe(EPOCH + 5);
    expect(store.evaluate(scope(), USER, T0)).toEqual(refusal('storage'));
  });

  it('never throws: a storage failure keeps the candidate', () => {
    expect(deadDbStore().nextPairingEpoch(EPOCH)).toBe(EPOCH);
  });
});

describe('a throwing logger never escapes (F3)', () => {
  const throwingLogger = {
    info: (): void => {
      throw new Error('logger down');
    },
    warn: (): void => {
      throw new Error('logger down');
    },
  };

  function loudStore(over: { safeStorage?: SafeStorageLike } = {}): OfflineGrantStore {
    return createOfflineGrantStore({
      db: g.handle,
      safeStorage: over.safeStorage ?? ss,
      now: () => clock,
      logger: throwingLogger,
    });
  }

  it('consumeOfflineUse returns the use it burned (never burns a use without returning)', () => {
    const loud = loudStore();
    loud.upsertFromAdmitted(scope(), admitted());
    const e = loud.consumeOfflineUse(scope(), USER, T0);
    expect(e.admissible && e.grant.offline_admissions_used).toBe(1);
    expect(openBody()['offline_admissions_used']).toBe(1);
  });

  it('evaluate and consume refuse without throwing', () => {
    const loud = loudStore();
    expect(loud.evaluate(scope(), USER, T0)).toEqual(refusal('grant_missing'));
    expect(loud.consumeOfflineUse(scope(), USER, T0)).toEqual(refusal('grant_missing'));
    expect(loud.evaluate(scope({ tenant_id: '' }), USER, T0)).toEqual(refusal('scope_mismatch'));
  });

  it('the writes and the clock never throw on account of the logger', () => {
    const loud = loudStore();
    expect(loud.upsertFromAdmitted(scope(), admitted())).toEqual({ kind: 'written' });
    expect(loud.invalidate(scope(), USER, 'forbidden').invalidated).toHaveLength(1);
    expect(loud.invalidateAll(scope(), 'device_unauthorized').invalidated).toEqual([]);
    expect(loud.observeClock(at(T0_MS + HOUR_MS))).toEqual({ kind: 'raised' });
    expect(loud.purgeAll()).toEqual({ removed: 1 });
    expect(loud.nextPairingEpoch(EPOCH)).toBeGreaterThan(0);
  });

  it('a failing re-seal inside an invalidation still deletes the grant', () => {
    store.upsertFromAdmitted(scope(), admitted());
    const loud = loudStore({ safeStorage: { ...ss, encryptString: throwing } });
    expect(loud.invalidate(scope(), USER, 'forbidden').invalidated).toHaveLength(1);
    expect(grantCount()).toBe(0);
  });
});

describe('logging — categories only, never a grant field', () => {
  it('no grant field reaches a logger or an error message, on any path', () => {
    const errors: string[] = [];
    const attempt = (fn: () => unknown): void => {
      try {
        fn();
      } catch (e) {
        errors.push(e instanceof Error ? `${e.name} ${e.message} ${String(e.stack)}` : String(e));
      }
    };
    const failingSeal = failingSealStore();

    attempt(() => store.upsertFromAdmitted(scope(), admitted()));
    attempt(() => store.evaluate(scope(), USER, T0));
    attempt(() => store.consumeOfflineUse(scope(), USER, T0));
    attempt(() => store.evaluate(scope(), USER, at(T0_MS + 30 * HOUR_MS)));
    attempt(() => store.evaluate(scope({ pairing_epoch: 1 }), USER, T0));
    attempt(() => store.observeClock(at(T0_MS + 40 * HOUR_MS)));
    attempt(() => store.evaluate(scope(), USER, T0));
    attempt(() => store.invalidate(scope(), USER, 'superseded'));
    attempt(() => store.upsertFromAdmitted(scope(), admitted({ offline_grace_seconds: 0 })));
    attempt(() => store.upsertFromAdmitted(scope(), admitted({ received_at: 'bad' })));
    attempt(() => failingSeal.upsertFromAdmitted(scope(), admitted()));
    attempt(() => store.upsertFromAdmitted(scope({ tenant_id: '' }), admitted()));
    attempt(() => store.invalidateAll(scope(), 'device_unauthorized'));
    attempt(() => store.purgeAll());
    attempt(() => store.nextPairingEpoch(EPOCH));
    attempt(() => deadDbStore().nextPairingEpoch(EPOCH));

    expect(logCalls.length).toBeGreaterThan(5);
    expect(errors.length).toBeGreaterThan(0);
    const logged = JSON.stringify(logCalls);
    for (const v of SENSITIVE_VALUES) {
      expect(logged).not.toContain(v);
      for (const e of errors) expect(e).not.toContain(v);
    }
    for (const call of logCalls) {
      const fields = call[1] as Record<string, unknown>;
      expect(
        Object.keys(fields).every((k) =>
          ['event', 'category', 'reason', 'op', 'count'].includes(k),
        ),
      ).toBe(true);
      expect(String(fields['event'])).toMatch(/^operator\.offline_grant\./);
    }
  });

  it.each([
    [
      'the refusal category',
      (): unknown => store.evaluate(scope(), USER, at(T0_MS + 30 * HOUR_MS)),
      { event: 'operator.offline_grant.refused', category: 'grant_expired' },
    ],
    [
      'the invalidation reason and count',
      (): unknown => store.invalidate(scope(), USER, 'superseded'),
      { event: 'operator.offline_grant.invalidated', reason: 'superseded', count: 1 },
    ],
  ])('logs %s', (_label, act, fields) => {
    store.upsertFromAdmitted(scope(), admitted());
    logCalls = [];
    act();
    expect(logCalls).toContainEqual(['info', fields, expect.any(String)]);
  });

  it('works without a logger', () => {
    const quiet = createOfflineGrantStore({ db: g.handle, safeStorage: ss, now: () => clock });
    expect(quiet.upsertFromAdmitted(scope(), admitted())).toEqual({ kind: 'written' });
    expect(quiet.evaluate(scope(), USER, at(T0_MS + 30 * HOUR_MS)).admissible).toBe(false);
  });
});

describe('purity', () => {
  it('reads no ambient clock: every time comes from the injected clock or the caller', () => {
    // The system clock sits 10 years in the future. Were the store to read it,
    // the write-time mark would refuse T0 (clock_suspect) and the stamps would differ.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2036-01-01T00:00:00.000Z'));
    try {
      store.upsertFromAdmitted(scope(), admitted());
      expect(store.evaluate(scope(), USER, T0).admissible).toBe(true);
      expect(store.consumeOfflineUse(scope(), USER, T0).admissible).toBe(true);
      expect(store.observeClock(T0)).toEqual({ kind: 'unchanged' });
      store.invalidate(scope(), USER, 'forbidden');
      expect(openBody()['invalidated']).toEqual({ reason: 'forbidden', at_local: T0_MS });
      expect(rows(g.raw, 'cashier_offline_grants')[0]?.['sealed_at']).toBe(T0.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });
});
