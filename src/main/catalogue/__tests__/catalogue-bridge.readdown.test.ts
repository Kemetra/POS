import { describe, expect, it } from 'vitest';

import type { OperatorSessionForCatalogue } from '../require-catalogue-session.js';
import { createCatalogueBridge } from '../catalogue-bridge.js';
import type { TickAdmission } from '../read-down/read-down-driver.js';
import type { CatalogueSyncStateRow } from '../catalogue-sync-state-repo.js';

/**
 * 010 T040 (RED) — `catalogue:refresh` / `catalogue:freshness` bridge contract.
 *
 * The §A4 required-controls matrix (security-review/s4-review.md §4) as binding
 * acceptance criteria. Both additions:
 *   • AD-1: session gate is the FIRST step (a refusal short-circuits before any
 *     driver call / DB read).
 *   • AD-2: generic refusal — `{ kind:'refused', reason:'no_session'|'tenant_isolation' }`.
 *   • refresh (Addition 1): `started` | `already_running` | `refused`; returns a
 *     STATUS only (WR-2, no catalogue data); does NOT await the read-down (P9-2 —
 *     returns `started`, not "done").
 *   • freshness (Addition 2): `ok{ last_success_at, is_empty }` | `refused`; the
 *     three truthful states (P9-1): never-synced (null), synced-with-products
 *     (non-null + is_empty=false), synced-but-EMPTY (non-null + is_empty=true).
 *   • P17-1: freshness is tenant-scoped (reads the session tenant's row + a
 *     tenant-scoped products-has-rows check).
 *
 * The driver + sync-state reads are INJECTED (fakes) so the bridge contract is
 * tested without a real read-down / DB.
 */

const SESSION: OperatorSessionForCatalogue = {
  role: 'cashier',
  operator_id: 'op-1',
  operator_session_id: 'sess-1',
  tenant_id: 'tenant-A',
  branch_id: 'branch-1',
};

/** A fake driver whose admission is scripted. */
function fakeDriver(admission: TickAdmission): {
  runTickOnce: () => TickAdmission;
  calls: () => number;
} {
  let calls = 0;
  return {
    runTickOnce: () => {
      calls += 1;
      return admission;
    },
    calls: () => calls,
  };
}

const startedAdmission: TickAdmission = {
  kind: 'started',
  completed: Promise.resolve({
    outcome: 'succeeded',
    productsWritten: 1,
    recordsRejected: 0,
    failureCategory: null,
  }),
};

/** A fake freshness source: the sync-state row + a tenant-scoped product count. */
function fakeFreshness(row: CatalogueSyncStateRow | null, productCount: number) {
  return {
    readSyncState: (tenantId: string) => (row && row.tenant_id === tenantId ? row : null),
    countProducts: (tenantId: string) => (row && row.tenant_id === tenantId ? productCount : 0),
  };
}

describe('T040 — catalogue:refresh bridge contract (§A4 Addition 1)', () => {
  it('refuses no_session before touching the driver (AD-1/AD-2)', async () => {
    const driver = fakeDriver(startedAdmission);
    const bridge = createCatalogueBridge({
      getCurrentSession: () => null,
      readDownDriver: driver,
    });
    await expect(bridge.refresh({})).resolves.toEqual({ kind: 'refused', reason: 'no_session' });
    expect(driver.calls()).toBe(0); // gate short-circuits — driver never called
  });

  it('a valid session kicks off a tick and returns started (status only, WR-2)', async () => {
    const driver = fakeDriver(startedAdmission);
    const bridge = createCatalogueBridge({
      getCurrentSession: () => SESSION,
      readDownDriver: driver,
    });
    const r = await bridge.refresh({});
    expect(r).toEqual({ kind: 'started' });
    expect(driver.calls()).toBe(1);
  });

  it('maps single-flight already_running through (FR-14)', async () => {
    const driver = fakeDriver({ kind: 'already_running' });
    const bridge = createCatalogueBridge({
      getCurrentSession: () => SESSION,
      readDownDriver: driver,
    });
    await expect(bridge.refresh({})).resolves.toEqual({ kind: 'already_running' });
  });

  it('refuses when the driver is not wired (no fake "done")', async () => {
    const bridge = createCatalogueBridge({ getCurrentSession: () => SESSION });
    // With no driver wired, refresh cannot start a tick — it must NOT claim success.
    const r = await bridge.refresh({});
    expect(r.kind).not.toBe('started');
  });
});

describe('T040 — catalogue:freshness bridge contract (§A4 Addition 2)', () => {
  it('refuses no_session (AD-1)', async () => {
    const bridge = createCatalogueBridge({
      getCurrentSession: () => null,
      freshness: fakeFreshness(null, 0),
    });
    await expect(bridge.freshness({})).resolves.toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it('never-synced → ok with last_success_at null (state 1)', async () => {
    const bridge = createCatalogueBridge({
      getCurrentSession: () => SESSION,
      freshness: fakeFreshness(null, 0),
    });
    await expect(bridge.freshness({})).resolves.toEqual({
      kind: 'ok',
      last_success_at: null,
      is_empty: true,
    });
  });

  it('synced-with-products → ok, non-null timestamp, is_empty false (state 2)', async () => {
    const row: CatalogueSyncStateRow = {
      tenant_id: 'tenant-A',
      branch_id: 'branch-1',
      last_success_at: '2026-06-07T10:00:00.000Z',
      source_snapshot_id: 'snap-1',
      last_attempt_at: '2026-06-07T10:00:00.000Z',
      last_outcome: 'succeeded',
    };
    const bridge = createCatalogueBridge({
      getCurrentSession: () => SESSION,
      freshness: fakeFreshness(row, 42),
    });
    await expect(bridge.freshness({})).resolves.toEqual({
      kind: 'ok',
      last_success_at: '2026-06-07T10:00:00.000Z',
      is_empty: false,
    });
  });

  it('synced-but-EMPTY → ok, non-null timestamp, is_empty true (state 3 — SC-10 truthfulness)', async () => {
    const row: CatalogueSyncStateRow = {
      tenant_id: 'tenant-A',
      branch_id: 'branch-1',
      last_success_at: '2026-06-07T10:00:00.000Z',
      source_snapshot_id: 'snap-empty',
      last_attempt_at: '2026-06-07T10:00:00.000Z',
      last_outcome: 'succeeded',
    };
    const bridge = createCatalogueBridge({
      getCurrentSession: () => SESSION,
      freshness: fakeFreshness(row, 0), // committed promote, zero products
    });
    await expect(bridge.freshness({})).resolves.toEqual({
      kind: 'ok',
      last_success_at: '2026-06-07T10:00:00.000Z',
      is_empty: true,
    });
  });

  it('freshness is tenant-scoped: a foreign-tenant row never leaks (P17-1)', async () => {
    const foreignRow: CatalogueSyncStateRow = {
      tenant_id: 'tenant-OTHER',
      branch_id: 'branch-9',
      last_success_at: '2026-06-07T10:00:00.000Z',
      source_snapshot_id: 'snap-x',
      last_attempt_at: '2026-06-07T10:00:00.000Z',
      last_outcome: 'succeeded',
    };
    const bridge = createCatalogueBridge({
      getCurrentSession: () => SESSION, // tenant-A
      freshness: fakeFreshness(foreignRow, 99),
    });
    // The session tenant (A) has no row → never-synced, NOT the foreign row.
    await expect(bridge.freshness({})).resolves.toEqual({
      kind: 'ok',
      last_success_at: null,
      is_empty: true,
    });
  });

  it('refuses (not throws) when the freshness source is not wired', async () => {
    const bridge = createCatalogueBridge({ getCurrentSession: () => SESSION });
    const r = await bridge.freshness({});
    // No freshness source → cannot read truthfully; must refuse, never throw/leak.
    expect(r.kind).toBe('refused');
  });
});

describe('RT-202 — catalogue:refresh resolves the driver lazily', () => {
  it('refuses while the driver does not exist yet, then admits once it does (in-process pairing)', async () => {
    const driver = fakeDriver(startedAdmission);
    const holder: { live?: ReturnType<typeof fakeDriver> } = {};
    const bridge = createCatalogueBridge({
      getCurrentSession: () => SESSION,
      getReadDownDriver: () => holder.live,
    });

    // Terminal not paired yet: no driver → honest refusal, never a fake "started".
    await expect(bridge.refresh({})).resolves.toEqual({ kind: 'refused', reason: 'no_session' });
    expect(driver.calls()).toBe(0);

    // Pairing completed in-process: the driver now exists.
    holder.live = driver;
    await expect(bridge.refresh({})).resolves.toEqual({ kind: 'started' });
    expect(driver.calls()).toBe(1);
  });

  it('still honours a driver passed directly (paired-at-boot shape is unchanged)', async () => {
    const driver = fakeDriver(startedAdmission);
    const bridge = createCatalogueBridge({
      getCurrentSession: () => SESSION,
      readDownDriver: driver,
    });
    await expect(bridge.refresh({})).resolves.toEqual({ kind: 'started' });
  });

  it('keeps the session gate first even when a lazy driver exists', async () => {
    const driver = fakeDriver(startedAdmission);
    const bridge = createCatalogueBridge({
      getCurrentSession: () => null,
      getReadDownDriver: () => driver,
    });
    await expect(bridge.refresh({})).resolves.toEqual({ kind: 'refused', reason: 'no_session' });
    expect(driver.calls()).toBe(0);
  });
});
