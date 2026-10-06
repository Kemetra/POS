/**
 * RT-17 (comments 10941 item 4 / 10948) — `scheduleSaleSync`: the sale-sync
 * interval and its worker stop.
 *
 * The stop is registered in the worker registry, which runs it synchronously
 * right before the DB handle closes. It clears the interval and latches the
 * engine stopped (RT-198), so a send in flight settles without any local write
 * (the sale stays pending and is re-sent, same bytes and key, on the next
 * start). It also returns the engine's drain, bounded by the client's request
 * timeout; the registry does not await it — the latch is what makes closing the
 * DB right after safe.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedOutbox,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { createSaleSyncStateRepo, type SaleSyncStateRepo } from '../sale-sync-state-repo.js';
import {
  createFakeSaleSyncClient,
  type SaleSyncClient,
  type SaleSyncResult,
} from '../sale-sync-client-types.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createSaleSyncEngine, type SaleSyncEngine } from '../sale-sync-engine.js';
import { scheduleSaleSync } from '../schedule-sale-sync.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const INTERVAL_MS = 5_000;
const DRAIN_TIMEOUT_MS = 15_000;
const OK: SaleSyncResult = { kind: 'ok', saleRef: null };

describe('scheduleSaleSync', () => {
  let db: SqlJsDatabase;
  let repo: SaleSyncStateRepo;
  let error: ReturnType<typeof vi.fn>;
  let stopped: boolean;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    db = freshSalesSyncDb();
    repo = createSaleSyncStateRepo(handleFor(db));
    error = vi.fn();
    stopped = false;
    stop = undefined;
    seedSale(db, { sale_id: 'sale-1' });
    seedOutbox(db, { sale_id: 'sale-1' });
  });

  afterEach(() => {
    void stop?.();
    vi.useRealTimers();
    db.close();
  });

  /** The engine as `index.ts` composes it: the latch is read through `isStopped`. */
  function engineFor(client: SaleSyncClient): SaleSyncEngine {
    const handle = handleFor(db);
    return createSaleSyncEngine({
      client,
      stateRepo: repo,
      salesRepo: bindSalesRepository(handle),
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      resolveTerminalId: () => 'term-1',
      getOperatorToken: () => 'tok-1',
      now: () => '2026-06-07T10:05:00.000Z',
      backoff: { baseMs: 1000, maxMs: 300_000 },
      isStopped: () => stopped,
    });
  }

  function schedule(engine: SaleSyncEngine, latchStopped?: () => void): void {
    stop = scheduleSaleSync({
      engine,
      latchStopped:
        latchStopped ??
        ((): void => {
          stopped = true;
        }),
      intervalMs: INTERVAL_MS,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
      logger: { error },
    });
  }

  /** A client whose send waits for `release`; `sent` once it is on the wire. */
  function gatedClient() {
    const gate = { sent: 0, release: (_result: SaleSyncResult): void => undefined };
    const client: SaleSyncClient = {
      postSale: () => {
        gate.sent += 1;
        return new Promise<SaleSyncResult>((resolve) => {
          gate.release = resolve;
        });
      },
      postSaleAsCashier: () => Promise.reject(new Error('device path is not used here')),
    };
    return { client, gate };
  }

  it('ticks on the 5 s cadence: nothing before the first interval, then the queued sale', async () => {
    const client = createFakeSaleSyncClient([OK]);
    schedule(engineFor(client));
    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(client.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toHaveLength(1);
    expect(nn(repo.read('sale-1')).sync_status).toBe('synced');
  });

  it('never ticks again once stopped', async () => {
    const client = createFakeSaleSyncClient([OK]);
    schedule(engineFor(client));
    void stop?.();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(client.calls).toEqual([]);
  });

  it('latches the engine stopped, synchronously, when stopped', () => {
    const latchStopped = vi.fn();
    schedule(engineFor(createFakeSaleSyncClient([OK])), latchStopped);
    expect(latchStopped).not.toHaveBeenCalled();
    void stop?.();
    expect(latchStopped).toHaveBeenCalledTimes(1);
  });

  it('a send in flight at stop writes nothing locally when it settles', async () => {
    const { client, gate } = gatedClient();
    schedule(engineFor(client));
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(gate.sent).toBe(1);
    const drained = stop?.();
    gate.release({ kind: 'ok', saleRef: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6' });
    // The drain settles once the tick in flight has settled.
    await expect(drained).resolves.toBeUndefined();
    expect(nn(repo.read('sale-1'))).toMatchObject({
      sync_status: 'pending',
      attempt_count: 0,
      synced_at: null,
      server_sale_ref: null,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('the stop waits for a send in flight at most the client request timeout', async () => {
    const { client, gate } = gatedClient();
    schedule(engineFor(client));
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(gate.sent).toBe(1);
    let drained = false;
    void stop?.().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS - 1);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe(true);
  });

  it('resolves the stop at once with no tick in flight', async () => {
    schedule(engineFor(createFakeSaleSyncClient([OK])));
    await expect(stop?.()).resolves.toBeUndefined();
  });

  it('logs an unexpected tick rejection as a closed-set line and keeps ticking', async () => {
    const boom = new Error('boom');
    const runTickOnce = vi
      .fn<SaleSyncEngine['runTickOnce']>()
      .mockReturnValueOnce({ kind: 'started', completed: Promise.reject(boom) })
      .mockReturnValue({ kind: 'already_running' });
    schedule({ runTickOnce, drain: () => Promise.resolve() });
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(error).toHaveBeenCalledWith({ err: boom }, 'sale_sync:tick_unexpected');
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runTickOnce).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
