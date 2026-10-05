/**
 * RT-194 — a 425 `idempotency_in_progress` never dead-letters a good sale.
 *
 * Scenario (found during RT-190): a capture runs longer than the client timeout;
 * the retry reaches Backend-Core while the original request still holds the
 * in-flight idempotency marker, so the server answers 425 + `Retry-After: 2`.
 * The sale is being captured, not rejected.
 *
 * Locks down:
 *   • `retryDelayMs`: the next attempt waits max(backoff, Retry-After);
 *   • engine: a 425 stays `pending` and its `next_retry_at` is not before
 *     `Retry-After`; it is not drained earlier;
 *   • end-to-end through the live client: timeout → 425 → wait → 201 replay →
 *     `synced` with its saleRef, with the SAME Idempotency-Key and payload on
 *     every attempt;
 *   • a 425 storm never dead-letters: there is no max-attempts cap, the sale
 *     stays pending (backoff capped at `maxMs`) and syncs once the answer comes.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedOutbox,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import {
  createFakeSaleSyncClient,
  type SaleSyncClient,
  type SaleSyncResult,
} from '../sale-sync-client-types.js';
import { createSaleSyncClient } from '../create-sale-sync-client.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import {
  createSaleSyncEngine,
  retryDelayMs,
  type BackoffPolicy,
  type SaleSyncEngineDeps,
} from '../sale-sync-engine.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const SALE_ID = 'sale-1';
const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const T0_MS = Date.parse('2026-10-04T10:00:00.000Z');
const BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 300_000 };

const at = (offsetMs: number): string => new Date(T0_MS + offsetMs).toISOString();

describe('retryDelayMs (RT-194)', () => {
  it.each<[string, number, SaleSyncResult, number]>([
    ['transient without Retry-After → backoff', 1, { kind: 'transient' }, 1_000],
    ['no_connection → backoff', 3, { kind: 'no_connection' }, 4_000],
    ['Retry-After longer than backoff wins', 1, { kind: 'transient', retryAfterMs: 2_000 }, 2_000],
    ['backoff longer than Retry-After wins', 4, { kind: 'transient', retryAfterMs: 2_000 }, 8_000],
    ['Retry-After 0 → backoff', 1, { kind: 'transient', retryAfterMs: 0 }, 1_000],
  ])('%s', (_label, attempt, result, expected) => {
    if (result.kind !== 'transient' && result.kind !== 'no_connection') throw new Error('bad row');
    expect(retryDelayMs(BACKOFF, attempt, result)).toBe(expected);
  });
});

interface Harness {
  deps: SaleSyncEngineDeps;
  setClock: (offsetMs: number) => void;
  tick: () => Promise<void>;
  close: () => void;
}

/** SALE_ID finalized + enqueued; an engine over `client` with a settable clock. */
function harness(client: SaleSyncClient, backoff: BackoffPolicy = BACKOFF): Harness {
  const db = freshSalesSyncDb();
  seedSale(db, { sale_id: SALE_ID });
  seedOutbox(db, { sale_id: SALE_ID });
  const handle = handleFor(db);
  let clock = at(0);
  const deps: SaleSyncEngineDeps = {
    client,
    stateRepo: createSaleSyncStateRepo(handle),
    salesRepo: bindSalesRepository(handle),
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    resolveTerminalId: () => 'term-1',
    getOperatorToken: () => 'tok-1',
    now: () => clock,
    backoff,
    onDeadLetter: () => {
      throw new Error('a 425 must never dead-letter');
    },
  };
  const engine = createSaleSyncEngine(deps);
  return {
    deps,
    setClock: (offsetMs) => {
      clock = at(offsetMs);
    },
    tick: async () => {
      const admission = engine.runTickOnce();
      if (admission.kind === 'started') await admission.completed;
    },
    close: () => {
      db.close();
    },
  };
}

describe('sale-sync-engine — 425 is transient and waits for Retry-After (RT-194)', () => {
  it('a 425 keeps the sale pending, next_retry_at honours Retry-After, and it is not re-sent earlier', async () => {
    const fake = createFakeSaleSyncClient([
      { kind: 'transient', retryAfterMs: 10_000 },
      { kind: 'ok', saleRef: SALE_REF },
    ]);
    const h = harness(fake);
    try {
      await h.tick();
      const row = nn(h.deps.stateRepo.read(SALE_ID));
      expect(row.sync_status).toBe('pending');
      expect(row.last_error_category).toBe('transient');
      // backoff(1) = 1 s, Retry-After = 10 s → the later one.
      expect(row.next_retry_at).toBe(at(10_000));

      h.setClock(9_999);
      await h.tick();
      expect(fake.calls).toHaveLength(1);

      h.setClock(10_000);
      await h.tick();
      expect(fake.calls).toHaveLength(2);
      expect(nn(h.deps.stateRepo.read(SALE_ID)).sync_status).toBe('synced');
    } finally {
      h.close();
    }
  });
});

interface WireCall {
  key: string | null;
  body: string;
}

/**
 * A live-client `fetch` that plays Backend-Core: the first request is slow (it
 * outlives the client timeout and is aborted), the next gets the real
 * `replyInProgress` 425, the last gets the 201 same-key replay.
 */
function slowThenInProgressThenReplay(calls: WireCall[]): SaleSyncClient {
  const answers: ((signal: AbortSignal | null | undefined) => Promise<Response>)[] = [
    (signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        });
      }),
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'idempotency_in_progress', retryAfterSec: 2 }), {
          status: 425,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '2' },
        }),
      ),
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ saleRef: SALE_REF, voided: false, lines: [] }), {
          status: 201,
          headers: { 'Content-Type': 'application/json', 'Idempotent-Replayed': 'true' },
        }),
      ),
  ];
  return createSaleSyncClient({
    baseUrl: 'https://example.invalid',
    timeoutMs: 5,
    fetch: (_input, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({
        key: headers?.['Idempotency-Key'] ?? null,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return nn(answers.shift())(init?.signal);
    },
    getOperatorToken: () => 'tok-1',
  });
}

describe('sale-sync — slow capture → 425 → replay ends synced with saleRef (RT-194)', () => {
  it('timeout → 425 → waits Retry-After → 201 replay → synced + saleRef, same key and payload throughout', async () => {
    const calls: WireCall[] = [];
    // A small backoff base so the 2 s Retry-After, not the backoff, sets the wait.
    const h = harness(slowThenInProgressThenReplay(calls), { baseMs: 250, maxMs: 300_000 });
    try {
      await h.tick(); // attempt 1: the client times out → no_connection
      expect(nn(h.deps.stateRepo.read(SALE_ID)).last_error_category).toBe('no_connection');

      h.setClock(1_000);
      await h.tick(); // attempt 2: the original is still in flight → 425
      const afterInProgress = nn(h.deps.stateRepo.read(SALE_ID));
      expect(afterInProgress.sync_status).toBe('pending');
      expect(afterInProgress.last_error_category).toBe('transient');
      expect(afterInProgress.next_retry_at).toBe(at(3_000)); // 1 s + Retry-After 2 s

      h.setClock(2_999);
      await h.tick(); // still inside Retry-After: no request
      expect(calls).toHaveLength(2);

      h.setClock(3_000);
      await h.tick(); // attempt 3: the original committed → 201 same-key replay
      const row = nn(h.deps.stateRepo.read(SALE_ID));
      expect(row.sync_status).toBe('synced');
      expect(row.server_sale_ref).toBe(SALE_REF);
      expect(
        h.deps.stateRepo.findServerSaleRefBySaleId(
          { tenantId: 'tenant-1', branchId: 'branch-1' },
          SALE_ID,
        ),
      ).toBe(SALE_REF);

      expect(calls).toHaveLength(3);
      const [first] = calls;
      expect(nn(first).key).not.toBeNull();
      expect(nn(first).body).toContain(SALE_ID);
      for (const call of calls) {
        expect(call.key).toBe(nn(first).key);
        expect(call.body).toBe(nn(first).body);
      }
    } finally {
      h.close();
    }
  });
});

describe('sale-sync-engine — a 425 storm never dead-letters (RT-194)', () => {
  it('60 consecutive 425s stay pending (no attempt cap; backoff capped at maxMs), then the replay syncs', async () => {
    const STORM = 60;
    const script: SaleSyncResult[] = [
      ...Array.from(
        { length: STORM },
        (): SaleSyncResult => ({
          kind: 'transient',
          retryAfterMs: 2_000,
        }),
      ),
      { kind: 'ok', saleRef: SALE_REF },
    ];
    const fake = createFakeSaleSyncClient(script);
    const h = harness(fake);
    try {
      let offset = 0;
      for (let i = 0; i < STORM; i += 1) {
        h.setClock(offset);
        await h.tick();
        const row = nn(h.deps.stateRepo.read(SALE_ID));
        expect(row.sync_status).toBe('pending');
        offset = Date.parse(nn(row.next_retry_at)) - T0_MS;
      }
      const stormed = nn(h.deps.stateRepo.read(SALE_ID));
      expect(stormed.attempt_count).toBe(STORM);
      expect(stormed.last_error_category).toBe('transient');
      // The wait between attempts never exceeds the backoff ceiling.
      expect(Date.parse(nn(stormed.next_retry_at)) - Date.parse(nn(stormed.last_attempt_at))).toBe(
        BACKOFF.maxMs,
      );
      expect(
        h.deps.stateRepo.readSyncStatus({
          tenantId: 'tenant-1',
          branchId: 'branch-1',
          terminalId: 'term-1',
        }),
      ).toMatchObject({ pending: 1, deadLetter: 0 });

      h.setClock(offset);
      await h.tick();
      const row = nn(h.deps.stateRepo.read(SALE_ID));
      expect(row.sync_status).toBe('synced');
      expect(row.server_sale_ref).toBe(SALE_REF);
      expect(fake.calls).toHaveLength(STORM + 1);
    } finally {
      h.close();
    }
  });
});
