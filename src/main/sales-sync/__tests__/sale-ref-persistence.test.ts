/**
 * RT-15 S1 — the server `saleRef` is persisted on `sale_sync_state` (0038).
 *
 *   • repo: `markSynced` stores `serverSaleRef`; FIRST WRITE WINS — a later write
 *     without one (malformed body, transient, dead-letter) never
 *     clears it, and a different non-null value never replaces it (reported as
 *     `saleRefMismatch`); `findServerSaleRefBySaleId` is tenant/branch-scoped and
 *     only answers for a synced sale.
 *   • engine: `ok` persists the saleRef with the synced transition; a 409
 *     (`divergent`, RT-190) dead-letters and stores none; a retry that ends in a replayed 200 stores it; a mismatch
 *     keeps the stored value and fires `onSaleRefMismatch` with the externalId.
 *   • live client: a 201 whose body read fails is retried with the same
 *     Idempotency-Key and the 200 replay's saleRef is stored.
 *   • a pre-S1 row (written without the column) reads NULL.
 *   • end-to-end through the live client: a 201 `Sale` body lands in the row.
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
import {
  createSaleSyncStateRepo,
  type MarkSyncedResult,
  type SaleSyncStateRepo,
} from '../sale-sync-state-repo.js';
import {
  createFakeSaleSyncClient,
  type SaleSyncClient,
  type SaleSyncResult,
} from '../sale-sync-client-types.js';
import { createSaleSyncClient } from '../create-sale-sync-client.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createSaleSyncEngine, type SaleSyncEngineDeps } from '../sale-sync-engine.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

type SalesSyncDb = ReturnType<typeof freshSalesSyncDb>;

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };
const SALE_ID = 'sale-1';
const REF_A = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const REF_B = '0190f5a2-7b3c-7d4e-8f90-0000000000bb';
const T0 = '2026-10-04T10:00:00.000Z';

interface RepoHarness {
  db: SalesSyncDb;
  repo: SaleSyncStateRepo;
}

/** Fresh DB with the given parent sales seeded; runs `body`, then closes the DB. */
function withRepo(options: { saleIds?: readonly string[] }, body: (h: RepoHarness) => void): void {
  const db = freshSalesSyncDb();
  for (const saleId of options.saleIds ?? [SALE_ID]) seedSale(db, { sale_id: saleId });
  try {
    body({ db, repo: createSaleSyncStateRepo(handleFor(db)) });
  } finally {
    db.close();
  }
}

/** `markSynced` for SALE_ID in SCOPE; omit `serverSaleRef` to model an answer with no usable saleRef. */
function syncSale(
  repo: SaleSyncStateRepo,
  options: { now?: string; serverSaleRef?: string | null } = {},
): MarkSyncedResult {
  return repo.markSynced({ saleId: SALE_ID, ...SCOPE, now: options.now ?? T0, ...options });
}

describe('sale-sync-state-repo — server_sale_ref (RT-15 S1)', () => {
  it.each<{ label: string; write: { serverSaleRef?: string | null }; expectedRef: string | null }>([
    { label: 'stores the serverSaleRef', write: { serverSaleRef: REF_A }, expectedRef: REF_A },
    {
      label: 'without a saleRef (e.g. a malformed 200/201 body) stores NULL',
      write: {},
      expectedRef: null,
    },
    {
      label: 'with an explicit null stores NULL',
      write: { serverSaleRef: null },
      expectedRef: null,
    },
  ])('markSynced $label; read() and the lookup agree', ({ write, expectedRef }) => {
    withRepo({}, ({ repo }) => {
      syncSale(repo, write);
      expect(nn(repo.read(SALE_ID)).server_sale_ref).toBe(expectedRef);
      expect(repo.findServerSaleRefBySaleId(SCOPE, SALE_ID)).toBe(expectedRef);
    });
  });

  it('a re-sync is idempotent and first write wins: same value kept; null never clears; a different value is refused and reported', () => {
    withRepo({}, ({ repo }) => {
      const noMismatch: MarkSyncedResult = { saleRefMismatch: false };
      expect(syncSale(repo, { now: '2026-10-04T10:00:00.000Z', serverSaleRef: REF_A })).toEqual(
        noMismatch,
      );
      expect(syncSale(repo, { now: '2026-10-04T10:01:00.000Z', serverSaleRef: REF_A })).toEqual(
        noMismatch,
      );
      expect(repo.findServerSaleRefBySaleId(SCOPE, SALE_ID)).toBe(REF_A);
      expect(syncSale(repo, { now: '2026-10-04T10:02:00.000Z', serverSaleRef: null })).toEqual(
        noMismatch,
      );
      expect(syncSale(repo, { now: '2026-10-04T10:03:00.000Z' })).toEqual(noMismatch);
      expect(repo.findServerSaleRefBySaleId(SCOPE, SALE_ID)).toBe(REF_A);
      expect(syncSale(repo, { now: '2026-10-04T10:04:00.000Z', serverSaleRef: REF_B })).toEqual({
        saleRefMismatch: true,
      });
      expect(repo.findServerSaleRefBySaleId(SCOPE, SALE_ID)).toBe(REF_A);
    });
  });

  it('a first reference after an earlier NULL sync is stored, not a mismatch', () => {
    withRepo({}, ({ repo }) => {
      expect(syncSale(repo, { serverSaleRef: null })).toEqual({ saleRefMismatch: false });
      expect(syncSale(repo, { serverSaleRef: REF_A })).toEqual({ saleRefMismatch: false });
      expect(repo.findServerSaleRefBySaleId(SCOPE, SALE_ID)).toBe(REF_A);
    });
  });

  it('transient and dead-letter writes keep a stored reference (never clear it)', () => {
    withRepo({}, ({ repo }) => {
      syncSale(repo, { serverSaleRef: REF_A });
      repo.recordTransient({
        saleId: SALE_ID,
        ...SCOPE,
        now: '2026-10-04T10:01:00.000Z',
        nextRetryAt: '2026-10-04T10:02:00.000Z',
        errorCategory: 'transient',
      });
      expect(nn(repo.read(SALE_ID)).server_sale_ref).toBe(REF_A);
      repo.markDeadLetter({ saleId: SALE_ID, ...SCOPE, now: '2026-10-04T10:03:00.000Z' });
      expect(nn(repo.read(SALE_ID)).server_sale_ref).toBe(REF_A);
    });
  });

  it('findServerSaleRefBySaleId is tenant/branch-scoped and synced-only', () => {
    withRepo({ saleIds: [SALE_ID, 'sale-2'] }, ({ repo }) => {
      syncSale(repo, { serverSaleRef: REF_A });
      expect(
        repo.findServerSaleRefBySaleId({ tenantId: 'tenant-2', branchId: 'branch-1' }, SALE_ID),
      ).toBeNull();
      expect(
        repo.findServerSaleRefBySaleId({ tenantId: 'tenant-1', branchId: 'branch-2' }, SALE_ID),
      ).toBeNull();
      expect(repo.findServerSaleRefBySaleId(SCOPE, 'unknown-sale')).toBeNull();
      // A pending sale has no usable reference yet.
      repo.recordTransient({
        saleId: 'sale-2',
        ...SCOPE,
        now: T0,
        nextRetryAt: '2026-10-04T10:01:00.000Z',
        errorCategory: 'no_connection',
      });
      expect(repo.findServerSaleRefBySaleId(SCOPE, 'sale-2')).toBeNull();
    });
  });

  it('a pre-S1 synced row (written without the column) stays NULL', () => {
    withRepo({ saleIds: ['sale-old'] }, ({ db, repo }) => {
      // Exactly the INSERT shape the pre-S1 repo issued (no server_sale_ref column).
      db.run(
        `INSERT INTO sale_sync_state
           (sale_id, tenant_id, branch_id, sync_status, attempt_count, next_retry_at,
            last_error_category, last_attempt_at, synced_at, created_at, updated_at)
         VALUES ('sale-old', 'tenant-1', 'branch-1', 'synced', 0, NULL, NULL,
                 '2026-06-07T10:00:00.000Z', '2026-06-07T10:00:00.000Z',
                 '2026-06-07T10:00:00.000Z', '2026-06-07T10:00:00.000Z')`,
      );
      expect(nn(repo.read('sale-old')).server_sale_ref).toBeNull();
      expect(repo.findServerSaleRefBySaleId(SCOPE, 'sale-old')).toBeNull();
    });
  });

  it('the storage CHECK refuses a non-UUID reference', () => {
    withRepo({}, ({ repo }) => {
      expect(() => {
        syncSale(repo, { serverSaleRef: 'nope' });
      }).toThrow(/CHECK constraint failed/);
    });
  });
});

interface EngineHarness {
  db: SalesSyncDb;
  deps: SaleSyncEngineDeps;
}

/** Fresh DB with SALE_ID finalized + enqueued, and an engine over `client`. */
interface EngineHarnessOptions {
  client: SaleSyncClient;
  now?: () => string;
  onSaleRefMismatch?: SaleSyncEngineDeps['onSaleRefMismatch'];
}

function engineHarness(options: EngineHarnessOptions): EngineHarness {
  const db = freshSalesSyncDb();
  seedSale(db, { sale_id: SALE_ID });
  seedOutbox(db, { sale_id: SALE_ID });
  const handle = handleFor(db);
  const deps: SaleSyncEngineDeps = {
    client: options.client,
    stateRepo: createSaleSyncStateRepo(handle),
    salesRepo: bindSalesRepository(handle),
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => SCOPE.terminalId,
    getOperatorToken: () => 'tok-1',
    now: options.now ?? (() => '2026-10-04T10:05:00.000Z'),
    backoff: { baseMs: 1000, maxMs: 300_000 },
    ...(options.onSaleRefMismatch === undefined
      ? {}
      : { onSaleRefMismatch: options.onSaleRefMismatch }),
  };
  return { db, deps };
}

async function runOnce(deps: SaleSyncEngineDeps): Promise<void> {
  const admission = createSaleSyncEngine(deps).runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

describe('sale-sync-engine — persists saleRef (RT-15 S1)', () => {
  it.each<{ label: string; outcome: SaleSyncResult; expectedRef: string | null }>([
    {
      label: 'ok with a saleRef → stored',
      outcome: { kind: 'ok', saleRef: REF_A },
      expectedRef: REF_A,
    },
    {
      label: 'ok with saleRef null → NULL (captured, not returnable)',
      outcome: { kind: 'ok', saleRef: null },
      expectedRef: null,
    },
  ])('$label; the row is synced', async ({ outcome, expectedRef }) => {
    const { db, deps } = engineHarness({ client: createFakeSaleSyncClient([outcome]) });
    try {
      await runOnce(deps);
      const row = nn(deps.stateRepo.read(SALE_ID));
      expect(row.sync_status).toBe('synced');
      expect(row.server_sale_ref).toBe(expectedRef);
    } finally {
      db.close();
    }
  });

  it('RT-190: divergent (409) → dead_letter, no saleRef (not returnable)', async () => {
    const { db, deps } = engineHarness({
      client: createFakeSaleSyncClient([
        { kind: 'divergent', errorCode: 'idempotency_key_conflict' },
      ]),
    });
    try {
      await runOnce(deps);
      const row = nn(deps.stateRepo.read(SALE_ID));
      expect(row.sync_status).toBe('dead_letter');
      expect(row.server_sale_ref).toBeNull();
      expect(deps.stateRepo.findServerSaleRefBySaleId(SCOPE, SALE_ID)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('a retry that ends in a replayed 200 stores the saleRef', async () => {
    const script: SaleSyncResult[] = [{ kind: 'transient' }, { kind: 'ok', saleRef: REF_A }];
    let clock = '2026-10-04T10:05:00.000Z';
    const { db, deps } = engineHarness({
      client: createFakeSaleSyncClient(script),
      now: () => clock,
    });
    try {
      await runOnce(deps);
      expect(nn(deps.stateRepo.read(SALE_ID)).server_sale_ref).toBeNull();
      clock = '2026-10-04T11:00:00.000Z'; // past the backoff
      await runOnce(deps);
      const row = nn(deps.stateRepo.read(SALE_ID));
      expect(row.sync_status).toBe('synced');
      expect(row.attempt_count).toBe(1);
      expect(row.server_sale_ref).toBe(REF_A);
    } finally {
      db.close();
    }
  });

  it('end-to-end through the live client: a 201 Sale body lands in the row', async () => {
    const live = createSaleSyncClient({
      baseUrl: 'https://example.invalid',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ saleRef: REF_A, voided: false, lines: [] }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      getOperatorToken: () => 'tok-1',
    });
    const { db, deps } = engineHarness({ client: live });
    try {
      await runOnce(deps);
      expect(deps.stateRepo.findServerSaleRefBySaleId(SCOPE, SALE_ID)).toBe(REF_A);
    } finally {
      db.close();
    }
  });

  it.each<{ label: string; incoming: string; expectedMismatches: number }>([
    { label: 'the same saleRef → no warning', incoming: REF_A, expectedMismatches: 0 },
    { label: 'a different saleRef → kept out + warning', incoming: REF_B, expectedMismatches: 1 },
  ])(
    'a stored reference wins over the capture answer: $label',
    async ({ incoming, expectedMismatches }) => {
      const mismatches: { externalId: string }[] = [];
      const { db, deps } = engineHarness({
        client: createFakeSaleSyncClient([{ kind: 'ok', saleRef: incoming }]),
        onSaleRefMismatch: (info) => mismatches.push(info),
      });
      try {
        // An anomalous pending row that already holds a reference (still drainable).
        db.run(
          `INSERT INTO sale_sync_state
             (sale_id, tenant_id, branch_id, sync_status, attempt_count, created_at, updated_at,
              server_sale_ref)
           VALUES (?, 'tenant-1', 'branch-1', 'pending', 1, ?, ?, ?)`,
          [SALE_ID, T0, T0, REF_A],
        );
        await runOnce(deps);
        const row = nn(deps.stateRepo.read(SALE_ID));
        expect(row.sync_status).toBe('synced');
        expect(row.server_sale_ref).toBe(REF_A);
        expect(mismatches).toHaveLength(expectedMismatches);
        for (const m of mismatches) {
          // Only the opaque externalId — never either reference value.
          expect(Object.keys(m)).toEqual(['externalId']);
          expect(m.externalId).toContain(SALE_ID);
          expect(JSON.stringify(m)).not.toContain(REF_A);
          expect(JSON.stringify(m)).not.toContain(REF_B);
        }
      } finally {
        db.close();
      }
    },
  );

  it('live client: a 201 whose body read fails is retried with the same key and the 200 replay saleRef is stored', async () => {
    const keys: (string | null)[] = [];
    const answers = [
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('connection reset mid-body'));
            },
          }),
          { status: 201 },
        ),
      () =>
        new Response(JSON.stringify({ saleRef: REF_A, voided: false, lines: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Idempotent-Replayed': 'true' },
        }),
    ];
    const live = createSaleSyncClient({
      baseUrl: 'https://example.invalid',
      fetch: (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        keys.push(headers?.['Idempotency-Key'] ?? null);
        const answer = nn(answers.shift());
        return Promise.resolve(answer());
      },
      getOperatorToken: () => 'tok-1',
    });
    let clock = '2026-10-04T10:05:00.000Z';
    const { db, deps } = engineHarness({ client: live, now: () => clock });
    try {
      await runOnce(deps);
      const afterLostAnswer = nn(deps.stateRepo.read(SALE_ID));
      expect(afterLostAnswer.sync_status).toBe('pending');
      expect(afterLostAnswer.last_error_category).toBe('transient');
      expect(afterLostAnswer.server_sale_ref).toBeNull();

      clock = '2026-10-04T11:00:00.000Z'; // past the backoff
      await runOnce(deps);
      expect(deps.stateRepo.findServerSaleRefBySaleId(SCOPE, SALE_ID)).toBe(REF_A);
      // Same Idempotency-Key on both sends: the server replays, never re-captures.
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBeNull();
      expect(keys[1]).toBe(keys[0]);
    } finally {
      db.close();
    }
  });
});
