/**
 * RT-17 slice 3 part 3 — the shift sync engine's composition-root wiring.
 *
 *   • `registerShiftSync`: with `POS_PULSE_FEATURE_SHIFT_CASHUP` off (default)
 *     nothing is registered, so the engine never starts and nothing is
 *     scheduled. With it on, the engine is a paired-only worker (it starts when
 *     the terminal is paired, like sale sync) and its interval is registered
 *     for shutdown as `shift-sync interval`.
 *   • `startShiftSync`: the same cadence as sale sync (one tick every 5 s,
 *     first tick after one interval), the device token and current terminal
 *     sources, and the RT-215 detector on every answer. Its stop clears the
 *     interval and latches the engine (RT-198): no tick after shutdown, and a
 *     send in flight at shutdown writes nothing locally when it settles (the
 *     DB closes right after). The stop returns the engine's drain, bounded by
 *     the client's request timeout.
 *   • Engine hooks become closed-set log lines (never a token, a body or PII).
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { PairedTerminal } from '../../app/paired-workers.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  SHIFT_SYNC_DRAIN_TIMEOUT_MS,
  SHIFT_SYNC_INTERVAL_MS,
  composeShiftCashupService,
  registerShiftSync,
  startShiftSync,
  type StartShiftSyncDeps,
} from '../compose-shift-cashup.js';
import { createShiftCashupRepo, type ShiftCashupRepo } from '../shift-cashup-repo.js';
import { cashierSession, storedBody } from './__helpers__/shift-cashup-service-fixture.js';
import { NOW, OPEN, PAY_IN, SCOPE, stateOf } from './__helpers__/shift-sync-fixture.js';

const TOKEN = 'device-token-secret';
const BASE_URL = 'https://backend.example';
const TERMINAL: PairedTerminal = {
  tenant_id: SCOPE.tenantId,
  branch_id: SCOPE.branchId,
  terminal_id: SCOPE.terminalId,
};

describe('registerShiftSync — the feature flag gate', () => {
  function registry(stop: () => Promise<void> = () => Promise.resolve()) {
    return {
      pairedWorkers: { register: vi.fn() },
      workers: { register: vi.fn<(name: string, stop: () => void) => void>() },
      start: vi.fn(() => stop),
    };
  }

  it('registers nothing and starts nothing with the flag OFF', () => {
    const deps = registry();
    registerShiftSync({ enabled: false, ...deps });
    expect(deps.pairedWorkers.register).not.toHaveBeenCalled();
    expect(deps.workers.register).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it('with the flag ON, starts the engine once paired and registers its stop', () => {
    const stop = vi.fn(() => Promise.resolve());
    const deps = registry(stop);
    registerShiftSync({ enabled: true, ...deps });
    expect(deps.pairedWorkers.register).toHaveBeenCalledWith(
      'shift-sync engine',
      expect.any(Function),
    );
    expect(deps.start).not.toHaveBeenCalled();

    const starter = deps.pairedWorkers.register.mock.calls[0]?.[1] as (t: PairedTerminal) => void;
    starter(TERMINAL);
    expect(deps.start).toHaveBeenCalledWith(TERMINAL);
    expect(deps.workers.register).toHaveBeenCalledWith('shift-sync interval', expect.any(Function));
    expect(stop).not.toHaveBeenCalled();
    deps.workers.register.mock.calls[0]?.[1]();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('composeShiftCashupService — defaults', () => {
  beforeAll(async () => {
    await initSalesSyncSql();
  });

  it('opens with a fresh UUIDv7 shift id in the capture currency (EGP)', () => {
    const db = freshSalesSyncDb();
    const service = composeShiftCashupService({
      db: handleFor(db),
      isEnabled: () => true,
      getSession: () => cashierSession(),
      isSessionLocked: () => false,
      pairedScope: () => Promise.resolve(SCOPE),
      now: () => NOW,
    });
    const { shiftId } = service.openShift({ openingFloatMinor: 0 });
    expect(shiftId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(storedBody(db, 1)['currencyCode']).toBe('EGP');
    db.close();
  });
});

describe('startShiftSync — scheduling, sources and RT-215', () => {
  let db: SqlJsDatabase;
  let repo: ShiftCashupRepo;
  let fetch: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
  let observe: Mock<(source: string, status: number) => void>;
  let warn: Mock<(payload: Record<string, unknown>, message: string) => void>;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    await initSalesSyncSql();
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse(NOW) });
    db = freshSalesSyncDb();
    repo = createShiftCashupRepo(handleFor(db));
    fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 201 })));
    observe = vi.fn<(source: string, status: number) => void>();
    warn = vi.fn<(payload: Record<string, unknown>, message: string) => void>();
    stop = undefined;
  });

  afterEach(() => {
    void stop?.();
    vi.useRealTimers();
    db.close();
  });

  function start(overrides: Partial<StartShiftSyncDeps> = {}): void {
    stop = startShiftSync({
      db: handleFor(db),
      terminal: TERMINAL,
      client: {
        baseUrl: BASE_URL,
        fetch,
        detector: { observe },
        getDeviceToken: () => Promise.resolve(TOKEN),
        currentTerminalId: () => SCOPE.terminalId,
      },
      resolveTerminalId: () => Promise.resolve(SCOPE.terminalId),
      logger: { warn },
      ...overrides,
    });
  }

  it('ticks on the sale-sync cadence: nothing before 5 s, then the queued fact', async () => {
    expect(SHIFT_SYNC_INTERVAL_MS).toBe(5_000);
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    start();
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_INTERVAL_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/pos/v1/shifts`);
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'Idempotency-Key': `pos-pulse-shift-open:${OPEN.shiftId}`,
    });
    expect(observe).toHaveBeenCalledWith('sale_sync', 201);
    expect(stateOf({ db, seq: 1 })['sync_status']).toBe('synced');
  });

  it('keeps draining on later ticks', async () => {
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    start();
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_INTERVAL_MS);
    repo.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW });
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never ticks again once stopped', async () => {
    start();
    void stop?.();
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_INTERVAL_MS * 3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a send in flight at stop writes nothing locally when it settles (RT-198)', async () => {
    let answer: (response: Response) => void = () => undefined;
    fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    start();
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    const drained = stop?.();
    answer(new Response('{}', { status: 201 }));
    // The drain settles once the tick in flight has settled.
    await expect(drained).resolves.toBeUndefined();
    expect(stateOf({ db, seq: 1 })).toMatchObject({ sync_status: 'pending', attempt_count: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('the stop waits for a send in flight at most the client request timeout', async () => {
    expect(SHIFT_SYNC_DRAIN_TIMEOUT_MS).toBe(15_000);
    fetch.mockImplementation(() => new Promise<Response>(() => undefined));
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    start();
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_INTERVAL_MS);
    let drained = false;
    void stop?.().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_DRAIN_TIMEOUT_MS - 1);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe(true);
  });

  it('drains only the paired tenant / branch', async () => {
    repo.recordOpen({ scope: { ...SCOPE, branchId: 'branch-2' }, fact: OPEN, now: NOW });
    start();
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_INTERVAL_MS);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drains only the current terminal (read live)', async () => {
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    start({ resolveTerminalId: () => Promise.resolve('term-9') });
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_INTERVAL_MS);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each<[string, () => Response, string, Record<string, unknown>]>([
    [
      'a dead letter',
      () => new Response(JSON.stringify({ error: { code: 'shift_closed' } }), { status: 409 }),
      'shift_sync:dead_letter',
      { seq: 1, fact_kind: 'open', reason: 'shift_closed' },
    ],
    ['a device 401', () => new Response('', { status: 401 }), 'shift_sync:device_unauthorized', {}],
  ])('logs %s as a closed-set line', async (_name, response, message, payload) => {
    fetch.mockImplementation(() => Promise.resolve(response()));
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    start();
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_INTERVAL_MS);
    expect(warn).toHaveBeenCalledWith(payload, message);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it('logs a dependency failure as a closed-set line', async () => {
    start({ resolveTerminalId: () => Promise.reject(new Error('boom')) });
    await vi.advanceTimersByTimeAsync(SHIFT_SYNC_INTERVAL_MS);
    expect(warn).toHaveBeenCalledWith({}, 'shift_sync:dependency_failure');
  });
});
