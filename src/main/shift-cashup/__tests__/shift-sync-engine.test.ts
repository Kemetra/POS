/**
 * RT-17 slice 3 part 2 — `createShiftSyncEngine`: the single-flight drain of
 * the shift outbox, over the real repository (migration 0043, sql.js).
 *
 *   • One tick drains the CURRENT terminal's facts (RT-221) one at a time, in
 *     causal order, through the client method of each fact's kind.
 *   • It stops on what `nextFact` says (idle / waiting / blocked), on an
 *     envelope repair head (never sent with the device bearer), and on a fact
 *     the client could not send (no state change).
 *   • Outcomes: ok → synced; transient / no_connection / device_unauthorized →
 *     a retry with bounded backoff, at least `Retry-After`; rejected → dead
 *     letter with its closed-set reason. A device 401 never dead-letters.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createShiftCashupRepo, type ShiftCashupRepo } from '../shift-cashup-repo.js';
import type { ShiftSyncClient, ShiftSyncResult, ShiftSyncSend } from '../shift-sync-client.js';
import {
  createShiftSyncEngine,
  type ShiftDrainReport,
  type ShiftSyncEngine,
  type ShiftSyncEngineDeps,
} from '../shift-sync-engine.js';
import {
  NOW,
  OPEN,
  OTHER_TERMINAL,
  S2,
  SCOPE,
  recordWholeShift,
  stateOf,
  stateRows,
} from './__helpers__/shift-sync-fixture.js';

const OK: ShiftSyncResult = { kind: 'ok' };
const BACKOFF = { baseMs: 1_000, maxMs: 60_000 };

interface FakeCall {
  method: keyof ShiftSyncClient;
  seq: number;
  terminalId: string;
}

interface FakeClient extends ShiftSyncClient {
  calls: FakeCall[];
}

/** Answers `script` in order, then repeats the last answer. */
function fakeClient(script: ReadonlyArray<ShiftSyncResult | Error> = [OK]): FakeClient {
  const queue = [...script];
  let last = script[script.length - 1] ?? OK;
  const calls: FakeCall[] = [];
  const answer = (method: keyof ShiftSyncClient) => (input: ShiftSyncSend) => {
    calls.push({ method, seq: input.fact.seq, terminalId: input.terminalId });
    last = queue.shift() ?? last;
    return last instanceof Error ? Promise.reject(last) : Promise.resolve(last);
  };
  return {
    calls,
    openShift: answer('openShift'),
    recordCashMovement: answer('recordCashMovement'),
    closeShift: answer('closeShift'),
  };
}

let db: SqlJsDatabase;
let repo: ShiftCashupRepo;
let clock: string;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  repo = createShiftCashupRepo(handleFor(db));
  clock = NOW;
});

afterEach(() => {
  db.close();
});

function engineWith(
  client: ShiftSyncClient,
  deps: Partial<ShiftSyncEngineDeps> = {},
): ShiftSyncEngine {
  return createShiftSyncEngine({
    client,
    repo,
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => SCOPE.terminalId,
    now: () => clock,
    backoff: BACKOFF,
    ...deps,
  });
}

async function tick(engine: ShiftSyncEngine): Promise<ShiftDrainReport> {
  const admission = engine.runTickOnce();
  if (admission.kind !== 'started') throw new Error('tick was not admitted');
  return admission.completed;
}

function later(ms: number): string {
  return new Date(Date.parse(clock) + ms).toISOString();
}

describe('createShiftSyncEngine — the drain', () => {
  it('sends a whole shift in causal order through the method of each kind', async () => {
    recordWholeShift({ repo });
    const client = fakeClient();
    const report = await tick(engineWith(client));
    expect(client.calls).toEqual([
      { method: 'openShift', seq: 1, terminalId: SCOPE.terminalId },
      { method: 'recordCashMovement', seq: 2, terminalId: SCOPE.terminalId },
      { method: 'closeShift', seq: 3, terminalId: SCOPE.terminalId },
    ]);
    expect(report).toEqual({ sent: 3, stop: { kind: 'idle' } });
    expect(stateRows(db).map((r) => [r['sync_status'], r['attempt_count']])).toEqual([
      ['synced', 1],
      ['synced', 1],
      ['synced', 1],
    ]);
  });

  it('an empty outbox is idle and sends nothing', async () => {
    const client = fakeClient();
    await expect(tick(engineWith(client))).resolves.toEqual({ sent: 0, stop: { kind: 'idle' } });
    expect(client.calls).toEqual([]);
  });
});

describe('createShiftSyncEngine — single flight', () => {
  it('admits one tick at a time', async () => {
    recordWholeShift({ repo });
    let release: (r: ShiftSyncResult) => void = () => undefined;
    const gate = new Promise<ShiftSyncResult>((resolve) => {
      release = resolve;
    });
    const client = fakeClient();
    client.openShift = () => gate;
    const engine = engineWith(client);
    const first = engine.runTickOnce();
    expect(engine.runTickOnce()).toEqual({ kind: 'already_running' });
    release(OK);
    if (first.kind !== 'started') throw new Error('first tick not admitted');
    await first.completed;
    expect(engine.runTickOnce().kind).toBe('started');
  });

  it('re-admits after a tick that failed', async () => {
    recordWholeShift({ repo });
    const engine = engineWith(fakeClient([new Error('client'), OK]));
    await expect(tick(engine)).resolves.toMatchObject({ stop: { kind: 'dependency_failure' } });
    await expect(tick(engine)).resolves.toMatchObject({ sent: 3 });
  });
});

describe('createShiftSyncEngine — terminal scoping (RT-221)', () => {
  it('drains only the current terminal; another pairing’s facts are held', async () => {
    repo.recordOpen({ scope: OTHER_TERMINAL, fact: { ...OPEN, shiftId: S2 }, now: NOW });
    recordWholeShift({ repo });
    const client = fakeClient();
    await tick(engineWith(client));
    expect(client.calls.map((c) => c.seq)).toEqual([2, 3, 4]);
    expect(stateRows(db).map((r) => r['sync_status'])).toEqual([
      'pending',
      'synced',
      'synced',
      'synced',
    ]);
  });

  const failingRead = (): string | null => {
    throw new Error('pairing');
  };

  it.each([
    ['unpaired', (): string | null => null, { kind: 'unpaired' }],
    ['a failing pairing read', failingRead, { kind: 'dependency_failure' }],
  ] as const)('%s → nothing is sent', async (_n, resolveTerminalId, stop) => {
    recordWholeShift({ repo });
    const client = fakeClient();
    const report = await tick(engineWith(client, { resolveTerminalId }));
    expect(report).toEqual({ sent: 0, stop });
    expect(client.calls).toEqual([]);
  });

  it('accepts an async terminal resolver', async () => {
    recordWholeShift({ repo });
    const client = fakeClient();
    await tick(engineWith(client, { resolveTerminalId: () => Promise.resolve(SCOPE.terminalId) }));
    expect(client.calls).toHaveLength(3);
  });
});

describe('createShiftSyncEngine — retried outcomes', () => {
  it.each([
    ['transient', { kind: 'transient' }, 'transient', 1_000],
    ['no_connection', { kind: 'no_connection' }, 'no_connection', 1_000],
    ['device_unauthorized', { kind: 'device_unauthorized' }, 'device_unauthorized', 1_000],
    [
      'Retry-After above the backoff',
      { kind: 'transient', retryAfterMs: 30_000 },
      'transient',
      30_000,
    ],
    ['Retry-After below the backoff', { kind: 'transient', retryAfterMs: 200 }, 'transient', 1_000],
  ] as const)('%s → pending retry, the head waits', async (_n, result, category, delayMs) => {
    recordWholeShift({ repo });
    const client = fakeClient([result]);
    const report = await tick(engineWith(client));
    expect(client.calls.map((c) => c.seq)).toEqual([1]);
    expect(report).toEqual({
      sent: 1,
      stop: { kind: 'waiting', seq: 1, nextRetryAt: later(delayMs) },
    });
    expect(stateOf({ db, seq: 1 })).toMatchObject({
      sync_status: 'pending',
      attempt_count: 1,
      last_error_category: category,
      next_retry_at: later(delayMs),
      dead_letter_reason: null,
    });
  });

  it('backs off exponentially per attempt, bounded by the policy maximum', async () => {
    recordWholeShift({ repo });
    const engine = engineWith(fakeClient([{ kind: 'transient' }]), {
      backoff: { baseMs: 1_000, maxMs: 3_000 },
    });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const report = await tick(engine);
      if (report.stop.kind !== 'waiting') throw new Error('expected waiting');
      delays.push(Date.parse(report.stop.nextRetryAt) - Date.parse(clock));
      clock = report.stop.nextRetryAt;
    }
    expect(delays).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  it('a head in backoff is not sent before its retry time', async () => {
    recordWholeShift({ repo });
    const client = fakeClient([{ kind: 'no_connection' }, OK]);
    const engine = engineWith(client);
    await tick(engine);
    clock = later(999);
    await expect(tick(engine)).resolves.toMatchObject({ sent: 0, stop: { kind: 'waiting' } });
    clock = later(1);
    await expect(tick(engine)).resolves.toEqual({ sent: 3, stop: { kind: 'idle' } });
  });

  it('a device 401 never dead-letters, however often it repeats', async () => {
    recordWholeShift({ repo });
    const engine = engineWith(fakeClient([{ kind: 'device_unauthorized' }]));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const report = await tick(engine);
      if (report.stop.kind !== 'waiting') throw new Error('expected waiting');
      clock = report.stop.nextRetryAt;
    }
    expect(stateOf({ db, seq: 1 })).toMatchObject({ sync_status: 'pending', attempt_count: 5 });
  });

  it('reports a device 401 once per episode, re-armed by any other answer', async () => {
    recordWholeShift({ repo });
    const onDeviceUnauthorized = vi.fn();
    const unauthorized: ShiftSyncResult = { kind: 'device_unauthorized' };
    const client = fakeClient([unauthorized, unauthorized, { kind: 'transient' }, unauthorized]);
    const engine = engineWith(client, { onDeviceUnauthorized });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const report = await tick(engine);
      if (report.stop.kind !== 'waiting') throw new Error('expected waiting');
      clock = report.stop.nextRetryAt;
    }
    expect(onDeviceUnauthorized).toHaveBeenCalledTimes(2);
    expect(onDeviceUnauthorized.mock.calls).toEqual([[], []]);
  });
});

describe('createShiftSyncEngine — dead letters', () => {
  it.each([
    'cashier_claim_refused',
    'shift_already_open',
    'shift_cashup_inconsistent',
    'rejected',
  ] as const)('rejected %s → dead letter; the facts behind it are blocked', async (reason) => {
    recordWholeShift({ repo });
    const onDeadLetter = vi.fn();
    const client = fakeClient([{ kind: 'rejected', reason }]);
    const report = await tick(engineWith(client, { onDeadLetter }));
    expect(report).toEqual({ sent: 1, stop: { kind: 'blocked', seq: 1, reason } });
    expect(client.calls).toHaveLength(1);
    expect(stateOf({ db, seq: 1 })).toMatchObject({
      sync_status: 'dead_letter',
      dead_letter_reason: reason,
      attempt_count: 1,
    });
    expect(onDeadLetter).toHaveBeenCalledExactlyOnceWith({ seq: 1, factKind: 'open', reason });
  });

  it('a later tick stays blocked and sends nothing', async () => {
    recordWholeShift({ repo });
    const client = fakeClient([{ kind: 'rejected', reason: 'cashier_claim_refused' }]);
    const engine = engineWith(client);
    await tick(engine);
    await expect(tick(engine)).resolves.toMatchObject({ sent: 0, stop: { kind: 'blocked' } });
    expect(client.calls).toHaveLength(1);
  });
});

describe('createShiftSyncEngine — never sent', () => {
  it('an envelope repair head is never sent with the device bearer', async () => {
    recordWholeShift({ repo });
    await tick(engineWith(fakeClient([{ kind: 'rejected', reason: 'cashier_claim_refused' }])));
    const repair = repo.recordEnvelopeRepair({ seq: 1, now: clock });
    const client = fakeClient();
    const report = await tick(engineWith(client));
    expect(report).toEqual({ sent: 0, stop: { kind: 'envelope_pending', seq: repair.seq } });
    expect(client.calls).toEqual([]);
    expect(stateOf({ db, seq: repair.seq })).toMatchObject({
      sync_status: 'pending',
      attempt_count: 0,
    });
  });

  it.each(['no_device_credential', 'terminal_changed', 'envelope_path', 'kind_mismatch'] as const)(
    'not_sent %s → held, no state change',
    async (reason) => {
      recordWholeShift({ repo });
      const client = fakeClient([{ kind: 'not_sent', reason }]);
      const report = await tick(engineWith(client));
      expect(report).toEqual({ sent: 0, stop: { kind: 'held', reason } });
      expect(client.calls).toHaveLength(1);
      expect(stateOf({ db, seq: 1 })).toMatchObject({
        sync_status: 'pending',
        attempt_count: 0,
        next_retry_at: null,
      });
    },
  );
});

describe('createShiftSyncEngine — failure containment', () => {
  it('a client that throws ends the tick with no state change, reported once per episode', async () => {
    recordWholeShift({ repo });
    const onDependencyFailure = vi.fn();
    const script = [new Error('a'), new Error('b'), OK, OK, OK, new Error('c')];
    const engine = engineWith(fakeClient(script), { onDependencyFailure });
    await tick(engine);
    await tick(engine);
    expect(onDependencyFailure).toHaveBeenCalledTimes(1);
    expect(stateOf({ db, seq: 1 })).toMatchObject({ sync_status: 'pending', attempt_count: 0 });
    await tick(engine);
    expect(stateRows(db).every((r) => r['sync_status'] === 'synced')).toBe(true);
    repo.recordOpen({ scope: SCOPE, fact: { ...OPEN, shiftId: S2 }, now: clock });
    await tick(engine);
    expect(onDependencyFailure).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['markSynced', OK],
    ['markDeadLetter', { kind: 'rejected', reason: 'rejected' }],
    ['recordRetry', { kind: 'transient' }],
  ] as const)('a %s that does not apply stops the tick, unreported', async (method, result) => {
    recordWholeShift({ repo });
    const onDeadLetter = vi.fn();
    const stale: ShiftCashupRepo = { ...repo, [method]: () => false };
    const client = fakeClient([result]);
    const report = await tick(engineWith(client, { repo: stale, onDeadLetter }));
    expect(report).toEqual({ sent: 1, stop: { kind: 'dependency_failure' } });
    expect(client.calls).toHaveLength(1);
    expect(onDeadLetter).not.toHaveBeenCalled();
  });

  it.each([
    ['onDeviceUnauthorized', { kind: 'device_unauthorized' }, 'waiting'],
    ['onDeadLetter', { kind: 'rejected', reason: 'rejected' }, 'blocked'],
    ['onDependencyFailure', new Error('client'), 'dependency_failure'],
  ] as const)('a throwing %s hook never breaks the tick', async (hook, answer, stop) => {
    recordWholeShift({ repo });
    const boom = (): never => {
      throw new Error('hook');
    };
    const engine = engineWith(fakeClient([answer]), { [hook]: boom });
    await expect(tick(engine)).resolves.toMatchObject({ stop: { kind: stop } });
  });
});
