/**
 * RT-17 (comments 10941 item 4 / 10948) — the sale-sync engine's shutdown latch
 * (RT-198 pattern, as the shift sync engine and the returns resolver).
 *
 * The worker stop is synchronous and the DB handle closes right after it, but a
 * tick can have a send in flight. Once `isStopped()` is true a tick must read
 * and write NOTHING more: it is checked before the tick's first read and again
 * whenever an await resumes, so a send in flight at stop settles without
 * `markSynced` / `recordTransient` / `markDeadLetter` (or any other store call)
 * on the closing DB. The sale stays `pending` with its stored bytes and key; the
 * next launch re-sends it (an idempotent replay if the server recorded it).
 * `drain(timeoutMs)` settles once the tick in flight has settled, or after
 * `timeoutMs`, whichever comes first.
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
import { createSaleSyncEngine, type SaleSyncEngineDeps } from '../sale-sync-engine.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const TERMINAL_ID = 'term-1';
const OK: SaleSyncResult = { kind: 'ok', saleRef: null };

/** The shutdown latch plus a store wrapper that records any call made after it. */
function stopLatch() {
  const latch = { stopped: false, touchedAfterStop: [] as string[] };
  return latch;
}

/** The state repo, every method of which records a call made once the latch is set. */
function watchedRepo(
  repo: SaleSyncStateRepo,
  latch: ReturnType<typeof stopLatch>,
): SaleSyncStateRepo {
  const watched: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(repo)) {
    watched[name] =
      typeof member === 'function'
        ? (...args: unknown[]): unknown => {
            if (latch.stopped) latch.touchedAfterStop.push(name);
            return (member as (...a: unknown[]) => unknown)(...args);
          }
        : member;
  }
  return watched as unknown as SaleSyncStateRepo;
}

/** A client whose send waits for `release`; `sent` once a request is on the wire. */
function gatedClient() {
  const gate: { sent: number; release: (result: SaleSyncResult) => void } = {
    sent: 0,
    release: () => undefined,
  };
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

interface Harness {
  db: SqlJsDatabase;
  repo: SaleSyncStateRepo;
  latch: ReturnType<typeof stopLatch>;
  hooks: {
    onDeadLetter: ReturnType<typeof vi.fn>;
    onPayloadDivergence: ReturnType<typeof vi.fn>;
    onSaleRefMismatch: ReturnType<typeof vi.fn>;
    onDependencyFailure: ReturnType<typeof vi.fn>;
  };
  deps: SaleSyncEngineDeps;
}

let db: SqlJsDatabase;

function harness(
  overrides: Partial<SaleSyncEngineDeps> = {},
  sales: readonly string[] = ['sale-1'],
): Harness {
  const handle = handleFor(db);
  const repo = createSaleSyncStateRepo(handle);
  const latch = stopLatch();
  for (const saleId of sales) {
    seedSale(db, { sale_id: saleId });
    seedOutbox(db, { sale_id: saleId });
  }
  const hooks = {
    onDeadLetter: vi.fn(),
    onPayloadDivergence: vi.fn(),
    onSaleRefMismatch: vi.fn(),
    onDependencyFailure: vi.fn(),
  };
  const deps: SaleSyncEngineDeps = {
    client: createFakeSaleSyncClient([OK]),
    stateRepo: watchedRepo(repo, latch),
    salesRepo: bindSalesRepository(handle),
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    resolveTerminalId: () => TERMINAL_ID,
    getOperatorToken: () => 'tok-1',
    now: () => '2026-06-07T10:05:00.000Z',
    backoff: { baseMs: 1000, maxMs: 300_000 },
    isStopped: () => latch.stopped,
    ...hooks,
    ...overrides,
  };
  return { db, repo, latch, hooks, deps };
}

async function runTick(deps: SaleSyncEngineDeps): Promise<void> {
  const admission = createSaleSyncEngine(deps).runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

/** The sale has no sync state (never answered) and is still due to be drained. */
function expectStillDue(h: Harness, saleId: string): void {
  expect(h.repo.read(saleId)).toBeNull();
  const due = h.repo.eligible(
    { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL_ID },
    '2026-06-07T10:05:00.000Z',
  );
  expect(due.map((row) => row.sale_id)).toContain(saleId);
}

function expectUntouched(h: Harness, saleId = 'sale-1'): void {
  expectStillDue(h, saleId);
  expect(h.latch.touchedAfterStop).toEqual([]);
  expect(h.hooks.onDeadLetter).not.toHaveBeenCalled();
  expect(h.hooks.onPayloadDivergence).not.toHaveBeenCalled();
  expect(h.hooks.onSaleRefMismatch).not.toHaveBeenCalled();
  expect(h.hooks.onDependencyFailure).not.toHaveBeenCalled();
}

beforeEach(() => {
  db = freshSalesSyncDb();
});

afterEach(() => {
  db.close();
});

describe('createSaleSyncEngine — stop latch (RT-198)', () => {
  it.each<[string, SaleSyncResult]>([
    ['ok', { kind: 'ok', saleRef: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6' }],
    ['transient', { kind: 'transient' }],
    ['transient with Retry-After', { kind: 'transient', retryAfterMs: 2_000 }],
    ['no_connection', { kind: 'no_connection' }],
    ['permanent', { kind: 'permanent' }],
    ['divergent', { kind: 'divergent', errorCode: 'idempotency_key_conflict' }],
  ])('a send answered %s after stop settles without any local write', async (_name, answer) => {
    const { client, gate } = gatedClient();
    const h = harness({ client });
    const completed = runTick(h.deps);
    await vi.waitFor(() => {
      expect(gate.sent).toBe(1);
    });
    h.latch.stopped = true;
    gate.release(answer);
    await completed;
    expectUntouched(h);
  });

  it('a send in flight at stop leaves the sale due, so the next start re-sends it', async () => {
    const { client, gate } = gatedClient();
    const h = harness({ client });
    const completed = runTick(h.deps);
    await vi.waitFor(() => {
      expect(gate.sent).toBe(1);
    });
    h.latch.stopped = true;
    gate.release(OK);
    await completed;

    // The next launch: a fresh engine, not stopped, the same sale, an ok answer.
    const next = createFakeSaleSyncClient([OK]);
    h.latch.stopped = false;
    await runTick({ ...h.deps, client: next });
    expect(next.calls).toHaveLength(1);
    expect(nn(h.repo.read('sale-1')).sync_status).toBe('synced');
  });

  it('a tick admitted after stop reads and sends nothing', async () => {
    const resolveTerminalId = vi.fn(() => TERMINAL_ID);
    const getOperatorToken = vi.fn(() => 'tok-1');
    const hasDeviceCredential = vi.fn(() => true);
    const client = createFakeSaleSyncClient([OK]);
    const h = harness({ client, resolveTerminalId, getOperatorToken, hasDeviceCredential });
    h.latch.stopped = true;
    await runTick(h.deps);
    expect(resolveTerminalId).not.toHaveBeenCalled();
    expect(getOperatorToken).not.toHaveBeenCalled();
    expect(hasDeviceCredential).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);
    expect(client.cashierCalls).toEqual([]);
    expect(h.latch.touchedAfterStop).toEqual([]);
    expect(h.hooks.onDependencyFailure).not.toHaveBeenCalled();
  });

  it('a tick admitted after stop still resolves and frees the single-flight slot', async () => {
    const h = harness();
    h.latch.stopped = true;
    const engine = createSaleSyncEngine(h.deps);
    const first = engine.runTickOnce();
    expect(first.kind).toBe('started');
    if (first.kind === 'started') await expect(first.completed).resolves.toBeUndefined();
    expect(engine.runTickOnce().kind).toBe('started');
  });

  it('stop while the device credential is read: nothing more is read or sent', async () => {
    const h = harness();
    const resolveTerminalId = vi.fn(() => TERMINAL_ID);
    const client = createFakeSaleSyncClient([OK]);
    const hasDeviceCredential = (): Promise<boolean> => {
      h.latch.stopped = true;
      return Promise.resolve(false);
    };
    await runTick({ ...h.deps, client, resolveTerminalId, hasDeviceCredential });
    expect(resolveTerminalId).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);
    expectUntouched(h);
  });

  it('stop while the terminal is resolved: the queue is not read, nothing is sent', async () => {
    const h = harness();
    const client = createFakeSaleSyncClient([OK]);
    const resolveTerminalId = (): Promise<string> => {
      h.latch.stopped = true;
      return Promise.resolve(TERMINAL_ID);
    };
    await runTick({ ...h.deps, client, resolveTerminalId });
    expect(client.calls).toEqual([]);
    expectUntouched(h);
  });

  it('stop between two sales: the second is neither read nor sent', async () => {
    const h = harness({}, ['sale-1', 'sale-2']);
    const client = createFakeSaleSyncClient([OK]);
    const resolveTerminalId = vi.fn(() => TERMINAL_ID);
    // The credential reads of the tick: start (1), report gate (2), then one per
    // sale. Stop lands in the second sale's gate (4th read).
    let reads = 0;
    const getOperatorToken = (): string => {
      reads += 1;
      if (reads === 4) h.latch.stopped = true;
      return 'tok-1';
    };
    await runTick({ ...h.deps, client, getOperatorToken, resolveTerminalId });
    expect(client.calls).toHaveLength(1);
    expect(nn(h.repo.read('sale-1')).sync_status).toBe('synced');
    expectStillDue(h, 'sale-2');
    // Tick start and the first sale's POST only: nothing is re-resolved after stop.
    expect(resolveTerminalId).toHaveBeenCalledTimes(2);
    expect(h.latch.touchedAfterStop).toEqual([]);
  });

  it('stop between two sales, after the first is persisted: no credential is read again', async () => {
    const h = harness({}, ['sale-1', 'sale-2']);
    const client = createFakeSaleSyncClient([{ kind: 'permanent' }, OK]);
    const hasDeviceCredential = vi.fn(() => false);
    // The first sale dead-letters; its notification hook is where the stop lands,
    // after the sale is persisted and before the next sale's credential check.
    const onDeadLetter = (): void => {
      h.latch.stopped = true;
    };
    await runTick({ ...h.deps, client, hasDeviceCredential, onDeadLetter });
    expect(client.calls).toHaveLength(1);
    expect(nn(h.repo.read('sale-1')).sync_status).toBe('dead_letter');
    expectStillDue(h, 'sale-2');
    // Tick start and the first sale's gate (and the report gate) only.
    expect(hasDeviceCredential).toHaveBeenCalledTimes(3);
    expect(h.latch.touchedAfterStop).toEqual([]);
  });

  it('stop while the terminal is re-resolved before a POST: that sale is not sent', async () => {
    const h = harness({}, ['sale-1', 'sale-2']);
    const client = createFakeSaleSyncClient([OK]);
    // Resolutions: tick start (1), then one per sale. Stop lands before sale 2's POST.
    let resolutions = 0;
    const resolveTerminalId = (): Promise<string> => {
      resolutions += 1;
      if (resolutions === 3) h.latch.stopped = true;
      return Promise.resolve(TERMINAL_ID);
    };
    await runTick({ ...h.deps, client, resolveTerminalId });
    expect(client.calls).toHaveLength(1);
    expectStillDue(h, 'sale-2');
    expect(h.latch.touchedAfterStop).toEqual([]);
  });

  it('stop while a pause transition is counted: nothing is read from the store', async () => {
    const h = harness();
    const onPauseTransition = vi.fn();
    const client = createFakeSaleSyncClient([OK]);
    // No credential at all → the tick reports a pause, counting the unsent sales
    // after the terminal resolves. Stop lands during that resolve.
    const resolveTerminalId = (): Promise<string> => {
      h.latch.stopped = true;
      return Promise.resolve(TERMINAL_ID);
    };
    await runTick({
      ...h.deps,
      client,
      getOperatorToken: () => null,
      resolveTerminalId,
      onPauseTransition,
    });
    expect(client.calls).toEqual([]);
    expect(onPauseTransition).not.toHaveBeenCalled();
    expect(h.latch.touchedAfterStop).toEqual([]);
  });

  it('never latched: a tick runs and persists as before', async () => {
    const h = harness();
    await runTick(h.deps);
    expect(nn(h.repo.read('sale-1')).sync_status).toBe('synced');
    expect(h.latch.touchedAfterStop).toEqual([]);
  });

  it('without an isStopped dep a tick runs and persists as before', async () => {
    const h = harness();
    const deps: SaleSyncEngineDeps = { ...h.deps };
    delete deps.isStopped;
    await runTick(deps);
    expect(nn(h.repo.read('sale-1')).sync_status).toBe('synced');
  });
});

describe('createSaleSyncEngine — drain (RT-198)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function watch(promise: Promise<void>): { done: boolean } {
    const state = { done: false };
    void promise.then(() => {
      state.done = true;
    });
    return state;
  }

  it('resolves at once with no tick in flight', async () => {
    const drained = watch(createSaleSyncEngine(harness().deps).drain(1_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(drained.done).toBe(true);
  });

  it('waits for the tick in flight to settle', async () => {
    const { client, gate } = gatedClient();
    const h = harness({ client });
    const engine = createSaleSyncEngine(h.deps);
    engine.runTickOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.sent).toBe(1);
    h.latch.stopped = true;
    const drained = watch(engine.drain(1_000));
    await vi.advanceTimersByTimeAsync(10);
    expect(drained.done).toBe(false);
    gate.release(OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(drained.done).toBe(true);
    expectUntouched(h);
  });

  it('gives up waiting at its timeout', async () => {
    const { client, gate } = gatedClient();
    const engine = createSaleSyncEngine(harness({ client }).deps);
    engine.runTickOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.sent).toBe(1);
    const drained = watch(engine.drain(1_000));
    await vi.advanceTimersByTimeAsync(999);
    expect(drained.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(drained.done).toBe(true);
  });

  it('resolves at once once the tick has settled', async () => {
    const engine = createSaleSyncEngine(harness().deps);
    const admission = engine.runTickOnce();
    if (admission.kind === 'started') await admission.completed;
    const drained = watch(engine.drain(1_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(drained.done).toBe(true);
  });
});
