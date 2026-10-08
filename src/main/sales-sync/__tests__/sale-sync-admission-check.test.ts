/**
 * RT-225 step 2 — the drain sends `admissionCheckAt` on the device path, and a
 * support reset re-queues `cashier_claim_refused` dead-letters.
 *
 * Backend-Core #710 (`sales.yaml` 1.6.0-draft): on the device path the body may
 * carry `admissionCheckAt` (the sale's settled time); the server then checks the
 * cashier admission window against it instead of `occurredAt` (= `finalized_at`,
 * which boot recovery stamps late). The field is part of the idempotency
 * fingerprint, so it is decided from the stored sale alone — every retry under
 * the same Idempotency-Key sends the same body.
 *
 * Driven through the real engine, the real state repo and the real selling-user
 * resolver on sql.js; only the HTTP client is the fake.
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
import { seedSettled } from './__helpers__/settled-audit-fixture.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { createFakeSaleSyncClient, type SaleSyncResult } from '../sale-sync-client-types.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createSaleSyncEngine, type SaleSyncEngine } from '../sale-sync-engine.js';
import { createSellingUserIdResolver } from '../selling-user-id.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';
const TERMINAL = 'term-1';
const SCOPE = { tenantId: TENANT, branchId: BRANCH, terminalId: TERMINAL };
const USER = '0190a3c4-0000-7000-8000-00000000000a';
const SETTLED = '2026-06-07T10:00:00.000Z';
/** Boot recovery finalized the sale two hours after the cashier settled it. */
const LATE_FINALIZE = '2026-06-07T12:00:00.000Z';

interface Queued {
  id: string;
  finalizedAt: string;
  /** The stored cashier; omitted = a manager/legacy sale (envelope path). */
  user?: string;
}

function harness(opts: { sales: Queued[]; script: SaleSyncResult[]; envelope?: string | null }) {
  const db = freshSalesSyncDb();
  opts.sales.forEach((s, i) => {
    seedSale(db, { sale_id: s.id, settled_at: SETTLED, finalized_at: s.finalizedAt });
    seedOutbox(db, { sale_id: s.id, enqueued_at: `2026-06-07T12:00:0${String(i)}.000Z` });
    seedSettled(db, {
      sale_id: s.id,
      ...(s.user === undefined ? {} : { selling_user_id: s.user }),
    });
  });
  const handle = handleFor(db);
  const stateRepo = createSaleSyncStateRepo(handle);
  const client = createFakeSaleSyncClient(opts.script);
  let clock = Date.parse('2026-06-07T12:05:00.000Z');
  const engine = createSaleSyncEngine({
    client,
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: TENANT,
    branchId: BRANCH,
    resolveTerminalId: () => TERMINAL,
    getOperatorToken: () => opts.envelope ?? null,
    hasDeviceCredential: () => Promise.resolve(true),
    sellingUsers: createSellingUserIdResolver({ db: handle }),
    // Each read moves the clock an hour on, so every backoff is due by the next tick.
    now: () => {
      clock += 60 * 60 * 1_000;
      return new Date(clock).toISOString();
    },
    backoff: { baseMs: 1_000, maxMs: 300_000 },
  });
  return { db, engine, client, stateRepo };
}

async function tick(engine: SaleSyncEngine): Promise<void> {
  const admission = engine.runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

describe('RT-225 step 2 — admissionCheckAt on the device path', () => {
  it('a cashier sale finalized late by boot recovery is sent with its settled time', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', finalizedAt: LATE_FINALIZE, user: USER }],
      script: [{ kind: 'ok', saleRef: null }],
    });
    await tick(h.engine);
    const call = nn(h.client.cashierCalls[0]);
    expect(call.operatorUserId).toBe(USER);
    expect(call.payload.admissionCheckAt).toBe(SETTLED);
    expect(call.payload.occurredAt).toBe(LATE_FINALIZE);
    h.db.close();
  });

  it('an ordinary cashier sale (finalized at settle) carries no admissionCheckAt', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', finalizedAt: SETTLED, user: USER }],
      script: [{ kind: 'ok', saleRef: null }],
    });
    await tick(h.engine);
    expect('admissionCheckAt' in nn(h.client.cashierCalls[0]).payload).toBe(false);
    h.db.close();
  });

  it('every retry under the same key sends the identical payload (never added on a retry)', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', finalizedAt: LATE_FINALIZE, user: USER }],
      script: [{ kind: 'transient' }, { kind: 'no_connection' }, { kind: 'ok', saleRef: null }],
    });
    await tick(h.engine);
    await tick(h.engine);
    await tick(h.engine);
    expect(h.client.cashierCalls).toHaveLength(3);
    const [first, ...retries] = h.client.cashierCalls.map((c) => JSON.stringify(c.payload));
    for (const retry of retries) expect(retry).toBe(first);
    expect(nn(h.stateRepo.read('sale-1')).sync_status).toBe('synced');
    h.db.close();
  });
});

describe('RT-225 step 3 — a reset cashier_claim_refused sale is re-sent', () => {
  it('a dead-letter left by an earlier build is re-sent with admissionCheckAt and syncs', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', finalizedAt: LATE_FINALIZE, user: USER }],
      script: [{ kind: 'ok', saleRef: null }],
    });
    // The pre-RT-225 build sent it without the field and got the device-path 403.
    h.stateRepo.markDeadLetter({
      saleId: 'sale-1',
      tenantId: TENANT,
      branchId: BRANCH,
      now: '2026-06-07T12:01:00.000Z',
      reason: 'cashier_claim_refused',
    });
    await tick(h.engine);
    expect(h.client.cashierCalls).toHaveLength(0);

    expect(h.stateRepo.resetCashierClaimRefused(SCOPE, '2026-06-08T09:00:00.000Z')).toBe(1);
    await tick(h.engine);

    const resent = nn(h.client.cashierCalls[0]);
    expect(resent.operatorUserId).toBe(USER);
    expect(resent.payload.admissionCheckAt).toBe(SETTLED);
    expect(nn(h.stateRepo.read('sale-1')).sync_status).toBe('synced');
    h.db.close();
  });

  it('refused again after a reset: dead-lettered again, never retried on its own', async () => {
    const h = harness({
      sales: [{ id: 'sale-1', finalizedAt: LATE_FINALIZE, user: USER }],
      script: [{ kind: 'refused' }],
    });
    await tick(h.engine);
    expect(h.stateRepo.resetCashierClaimRefused(SCOPE, '2026-06-08T09:00:00.000Z')).toBe(1);
    await tick(h.engine);
    await tick(h.engine);
    expect(h.client.cashierCalls).toHaveLength(2);
    const [first, second] = h.client.cashierCalls.map((c) => JSON.stringify(c.payload));
    expect(second).toBe(first);
    const row = nn(h.stateRepo.read('sale-1'));
    expect(row.sync_status).toBe('dead_letter');
    expect(row.last_error_category).toBe('cashier_claim_refused');
    h.db.close();
  });
});
