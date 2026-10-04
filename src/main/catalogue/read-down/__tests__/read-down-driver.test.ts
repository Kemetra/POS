import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  freshCatalogueDb,
  nn,
  handleFor,
  initCatalogueSql,
} from '../../__tests__/__helpers__/catalogue-fixture.js';
import { createCatalogueSyncStateRepo } from '../../catalogue-sync-state-repo.js';
import { createProductRepo } from '../../product-repo.js';
import { createReadDownWriter } from '../read-down-writer.js';
import { createReadDownDriver } from '../read-down-driver.js';
import type { ReadDownClient, ReadDownFetchResult } from '../read-down-client-types.js';
import type { SellableCatalogRow } from '../map-sellable-row.js';
import type { DatabaseHandle } from '../../../db/client.js';

/**
 * 010 T037 (RED) — read-down driver (US2, R8 / FR-12 / FR-14).
 *
 * The driver orchestrates one read-down tick: fetch via the injected client →
 * (on `ok`) writer.run → result; (on transport failure) record a failed attempt
 * WITHOUT calling the writer, so a working catalogue is preserved and the
 * freshness clock never advances on a fetch that didn't land.
 *
 * Two load-bearing behaviours under test:
 *   1. ASYNC SINGLE-FLIGHT (FR-14). `runTickOnce()` ADMITS synchronously —
 *      returning `{ kind: 'started', completed }` for the first call and
 *      `{ kind: 'already_running' }` for a concurrent call — but the read-down
 *      itself completes on the `completed` promise. The bridge maps on `kind`
 *      immediately (FR-12 non-blocking, contract Addition 1); the test awaits
 *      `completed` to assert the write landed.
 *   2. TRANSPORT-FAILURE PATH (the driver's own responsibility — the writer only
 *      sees writer-side failures). A client `no_connection` / `failed` → the
 *      writer is NOT called, `recordAttempt('failed')` is recorded, and any prior
 *      catalogue is preserved (SC-5 / FR-7 at the fetch boundary).
 *
 * The real HTTP `createReadDownClient` (T020/T021) is BLOCKED on D-DEPLOY (#349),
 * so the driver depends on the `ReadDownClient` INTERFACE and the test injects a
 * controllable fake — the canonical DI seam (mirrors finalize-listener).
 */

beforeAll(async () => {
  await initCatalogueSql();
});

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';

function good(id: string): SellableCatalogRow {
  return {
    product_id: id,
    sku: `SKU-${id}`,
    name: `Name ${id}`,
    aliases: [],
    price: { amount: '10.00', currency_code: 'EGP' },
    tax_category: 'standard',
    active: true,
    row_cursor: `cur-${id}`,
  };
}

function countRows(handle: DatabaseHandle, table: string): number {
  const stmt = handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`) as {
    get(): { n: number } | undefined;
  };
  return stmt.get()?.n ?? 0;
}

/** A controllable fake client: each call resolves the next queued result. */
function fakeClient(results: ReadDownFetchResult[]): {
  client: ReadDownClient;
  calls: () => number;
} {
  let i = 0;
  let calls = 0;
  return {
    client: {
      fetchSnapshot(): Promise<ReadDownFetchResult> {
        calls += 1;
        const idx = Math.min(i, results.length - 1);
        const r = results[idx] ?? { kind: 'failed' };
        i += 1;
        return Promise.resolve(r);
      },
    },
    calls: () => calls,
  };
}

/** A fake client whose fetch is gated on a manually-resolved promise (hold a tick in-flight). */
function gatedClient(result: ReadDownFetchResult): {
  client: ReadDownClient;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  return {
    client: {
      async fetchSnapshot(): Promise<ReadDownFetchResult> {
        await gate;
        return result;
      },
    },
    release,
  };
}

describe('T037 — read-down driver', () => {
  it('a successful tick fetches then writes; completed resolves with the outcome', async () => {
    const db = freshCatalogueDb();
    const handle = handleFor(db);
    const syncStateRepo = createCatalogueSyncStateRepo(handle);
    const writer = createReadDownWriter({ db: handle, syncStateRepo });
    const { client } = fakeClient([
      { kind: 'ok', sourceSnapshotId: 'snap-1', rows: [good('p-1'), good('p-2')] },
    ]);

    const driver = createReadDownDriver({
      client,
      writer,
      tenantId: TENANT,
      branchId: BRANCH,
      now: () => '2026-06-07T10:00:00.000Z',
      tickIntervalMs: 60_000,
    });

    const admission = driver.runTickOnce();
    expect(admission.kind).toBe('started');
    const outcome = await nn(admission.kind === 'started' ? admission.completed : null);

    expect(outcome.outcome).toBe('succeeded');
    expect(outcome.productsWritten).toBe(2);
    expect(countRows(handle, 'products')).toBe(2);

    // Freshness advanced inside the promote tx.
    const state = nn(syncStateRepo.read(TENANT));
    expect(state.last_success_at).toBe('2026-06-07T10:00:00.000Z');
    db.close();
  });

  it('single-flight: a concurrent call while a tick is in-flight is refused as already_running', async () => {
    const db = freshCatalogueDb();
    const handle = handleFor(db);
    const syncStateRepo = createCatalogueSyncStateRepo(handle);
    const writer = createReadDownWriter({ db: handle, syncStateRepo });
    const { client, release } = gatedClient({
      kind: 'ok',
      sourceSnapshotId: 'snap-1',
      rows: [good('p-1')],
    });

    const driver = createReadDownDriver({
      client,
      writer,
      tenantId: TENANT,
      branchId: BRANCH,
      now: () => '2026-06-07T10:00:00.000Z',
      tickIntervalMs: 60_000,
    });

    const first = driver.runTickOnce();
    expect(first.kind).toBe('started');

    // Second call WHILE the first is gated mid-fetch → already_running.
    const second = driver.runTickOnce();
    expect(second.kind).toBe('already_running');

    // Release the gate; the first tick completes and writes.
    release();
    const outcome = await nn(first.kind === 'started' ? first.completed : null);
    expect(outcome.outcome).toBe('succeeded');
    expect(countRows(handle, 'products')).toBe(1);

    // After completion a fresh tick is admitted again.
    const third = driver.runTickOnce();
    expect(third.kind).toBe('started');
    await nn(third.kind === 'started' ? third.completed : null);
    db.close();
  });

  it('transport failure: the writer is NOT called, a failed attempt is recorded, prior catalogue preserved', async () => {
    const db = freshCatalogueDb();
    const handle = handleFor(db);
    const syncStateRepo = createCatalogueSyncStateRepo(handle);
    const writer = createReadDownWriter({ db: handle, syncStateRepo });

    // Seed a working catalogue with a successful first tick.
    {
      const { client } = fakeClient([
        { kind: 'ok', sourceSnapshotId: 'snap-1', rows: [good('p-1')] },
      ]);
      const seedDriver = createReadDownDriver({
        client,
        writer,
        tenantId: TENANT,
        branchId: BRANCH,
        now: () => '2026-06-07T09:00:00.000Z',
        tickIntervalMs: 60_000,
      });
      const a = seedDriver.runTickOnce();
      await nn(a.kind === 'started' ? a.completed : null);
    }
    expect(countRows(handle, 'products')).toBe(1);

    // Now a transport failure. The writer must NOT run; the prior catalogue stays.
    const { client: failing, calls } = fakeClient([{ kind: 'no_connection' }]);
    const driver = createReadDownDriver({
      client: failing,
      writer,
      tenantId: TENANT,
      branchId: BRANCH,
      now: () => '2026-06-07T10:00:00.000Z',
      tickIntervalMs: 60_000,
    });

    const admission = driver.runTickOnce();
    expect(admission.kind).toBe('started');
    const outcome = await nn(admission.kind === 'started' ? admission.completed : null);

    expect(outcome.outcome).toBe('failed');
    expect(outcome.failureCategory).toBe('transport');
    expect(calls()).toBe(1);

    // Prior catalogue intact + still resolvable.
    const repo = createProductRepo(handle);
    expect(repo.lookupBySku(TENANT, 'SKU-p-1').kind).toBe('one');
    expect(countRows(handle, 'products')).toBe(1);

    // Freshness clock NOT advanced; failure recorded for diagnostics.
    const state = nn(syncStateRepo.read(TENANT));
    expect(state.last_success_at).toBe('2026-06-07T09:00:00.000Z');
    expect(state.last_outcome).toBe('failed');
    expect(state.last_attempt_at).toBe('2026-06-07T10:00:00.000Z');
    db.close();
  });
});

describe('T038 — driver lifecycle (start/stop)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start installs an interval and stop clears it (idempotent)', async () => {
    vi.useFakeTimers();
    const db = freshCatalogueDb();
    const handle = handleFor(db);
    const syncStateRepo = createCatalogueSyncStateRepo(handle);
    const writer = createReadDownWriter({ db: handle, syncStateRepo });
    const { client } = fakeClient([{ kind: 'ok', sourceSnapshotId: 's', rows: [] }]);

    const driver = createReadDownDriver({
      client,
      writer,
      tenantId: TENANT,
      branchId: BRANCH,
      now: () => '2026-06-07T10:00:00.000Z',
      tickIntervalMs: 60_000,
    });

    const handle1 = driver.start();
    // Calling start again returns the same handle (no second interval).
    expect(driver.start()).toBe(handle1);
    expect(vi.getTimerCount()).toBe(1);
    driver.stop();
    expect(vi.getTimerCount()).toBe(0);
    // stop is safe to call again.
    driver.stop();
    // Let the initial tick settle before closing the DB.
    await vi.advanceTimersByTimeAsync(0);
    db.close();
  });
});

/**
 * RT-41 — immediate first sync after paired startup. `start()` admits ONE
 * initial tick through the same single-flight gate as the interval and the
 * manual `catalogue:refresh`, then the hourly cadence continues unchanged.
 */
describe('RT-41 — initial read-down on start', () => {
  const INTERVAL_MS = 60 * 60 * 1_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(client: ReadDownClient): {
    db: ReturnType<typeof freshCatalogueDb>;
    handle: DatabaseHandle;
    syncStateRepo: ReturnType<typeof createCatalogueSyncStateRepo>;
    driver: ReturnType<typeof createReadDownDriver>;
  } {
    const db = freshCatalogueDb();
    const handle = handleFor(db);
    const syncStateRepo = createCatalogueSyncStateRepo(handle);
    const writer = createReadDownWriter({ db: handle, syncStateRepo });
    const driver = createReadDownDriver({
      client,
      writer,
      tenantId: TENANT,
      branchId: BRANCH,
      now: () => new Date(Date.now()).toISOString(),
      tickIntervalMs: INTERVAL_MS,
    });
    return { db, handle, syncStateRepo, driver };
  }

  it('start performs exactly one initial sync without waiting for the interval', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-07T10:00:00.000Z') });
    const { client, calls } = fakeClient([
      { kind: 'ok', sourceSnapshotId: 'snap-1', rows: [good('p-1'), good('p-2')] },
    ]);
    const { db, handle, syncStateRepo, driver } = setup(client);

    driver.start();
    // The initial fetch is admitted synchronously inside start() — no timer advance.
    expect(calls()).toBe(1);

    // Settle the in-flight tick (microtasks only; the clock does not move).
    await vi.advanceTimersByTimeAsync(0);
    expect(countRows(handle, 'products')).toBe(2);
    expect(nn(syncStateRepo.read(TENANT)).last_success_at).toBe('2026-06-07T10:00:00.000Z');

    // A repeat start() neither re-ticks nor installs a second interval.
    driver.start();
    expect(calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    // Nothing else fires before the interval elapses.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(calls()).toBe(1);

    driver.stop();
    db.close();
  });

  it('periodic cadence continues after the initial sync, one tick per interval', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-07T10:00:00.000Z') });
    const { client, calls } = fakeClient([
      { kind: 'ok', sourceSnapshotId: 'snap-1', rows: [good('p-1')] },
    ]);
    const { db, driver } = setup(client);

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(calls()).toBe(3);

    // After stop, the cadence ends — no further pulls.
    driver.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(calls()).toBe(3);
    db.close();
  });

  it('no overlap: while the initial tick is in flight, interval ticks and manual refresh are coalesced', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-07T10:00:00.000Z') });
    const { client: gated, release } = gatedClient({
      kind: 'ok',
      sourceSnapshotId: 'snap-1',
      rows: [good('p-1')],
    });
    let fetches = 0;
    const counting: ReadDownClient = {
      fetchSnapshot(): Promise<ReadDownFetchResult> {
        fetches += 1;
        return gated.fetchSnapshot();
      },
    };
    const { db, handle, driver } = setup(counting);

    driver.start();
    expect(fetches).toBe(1);

    // Manual refresh while the initial pull is in flight → already_running.
    expect(driver.runTickOnce().kind).toBe('already_running');
    // Interval elapses while the initial pull is still in flight → coalesced.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetches).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(countRows(handle, 'products')).toBe(1);

    // Once settled, a manual refresh is admitted again.
    const manual = driver.runTickOnce();
    expect(manual.kind).toBe('started');
    await nn(manual.kind === 'started' ? manual.completed : null);
    expect(fetches).toBe(2);

    driver.stop();
    db.close();
  });

  it('offline backend at startup: safe (no catalogue change, failure recorded) and retried by the next tick', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-07T10:00:00.000Z') });
    const { client, calls } = fakeClient([
      { kind: 'no_connection' },
      { kind: 'ok', sourceSnapshotId: 'snap-2', rows: [good('p-1')] },
    ]);
    const { db, handle, syncStateRepo, driver } = setup(client);

    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);

    // Safe: nothing written, freshness clock not advanced, failure recorded.
    expect(countRows(handle, 'products')).toBe(0);
    const failed = nn(syncStateRepo.read(TENANT));
    expect(failed.last_outcome).toBe('failed');
    expect(failed.last_success_at).toBeNull();
    expect(failed.last_attempt_at).toBe('2026-06-07T10:00:00.000Z');

    // Retryable: the single-flight gate is released, so the next interval tick
    // (or a manual refresh) runs and lands the catalogue.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(calls()).toBe(2);
    expect(countRows(handle, 'products')).toBe(1);
    expect(nn(syncStateRepo.read(TENANT)).last_success_at).toBe('2026-06-07T11:00:00.000Z');

    driver.stop();
    db.close();
  });
});
