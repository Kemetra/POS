/**
 * POS-SYNC-LAB-001 — headless sale-sync WIRE smoke.
 *
 * Question this proves: *Can a valid finalized sale envelope enter the
 * production outbox/drain path and reach Data-Pulse successfully WITHOUT GUI
 * involvement?*
 *
 * This is NOT a parallel sync implementation. It wires the SAME production
 * composition the main-process boots in `src/main/index.ts` (~L1314–1369):
 *
 *     createSaleSyncStateRepo  +  bindSalesRepository  +  bindSaleSyncOutboxRepository
 *       →  createSaleSyncClient (the LIVE HTTP client — payload transform +
 *          Authorization: Bearer <envelope> + Idempotency-Key + classifyStatus)
 *       →  createSaleSyncEngine (FIFO drain, single-flight, FR-3 envelope gate,
 *          ok→synced · divergent(409)→dead-letter · transient/no_connection→retry ·
 *          permanent→dead-letter)
 *       →  engine.runTickOnce()  (exactly the call the main interval makes)
 *
 * The ONLY seam replaced is `fetch` — the network boundary. The existing
 * engine suite (`sale-sync-engine.test.ts`) drives the engine against the
 * `createFakeSaleSyncClient` DI fake; this harness instead wires the REAL
 * `createSaleSyncClient` so the production payload-transform + auth-header +
 * HTTP-classifier + drain + state-persistence chain is exercised end-to-end.
 * Per the repo's established HTTP-mock pattern (see create-sale-sync-client.test.ts),
 * `fetch` is captured so we can assert the on-wire request shape (NOT secrets).
 *
 * Trust-boundary note: `getOperatorToken` is read IN-PROCESS (mirroring the
 * `operatorEnvelopeHolder.get(...)` closures at the composition root) and is
 * NEVER bridged. The engine is driven directly via `runTickOnce()` — there is
 * no `ipcMain`, no preload, and no renderer in this loop. That is the point:
 * the GUI/renderer wiring is deliberately ISOLATED and therefore NOT exercised
 * by this smoke; only the headless sync core is proven.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { createSaleSyncEngine, type SaleSyncEngine } from '../sale-sync-engine.js';
import { createSaleSyncClient } from '../create-sale-sync-client.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { bindSaleSyncOutboxRepository } from '../../sync-outbox/sale-sync-outbox.repository.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

// Device-principal scope (from the pairingStore at the composition root).
const TENANT_ID = 'tenant-1';
const BRANCH_ID = 'branch-1';
const TERMINAL_ID = 'term-1';
const SCOPE = { tenantId: TENANT_ID, branchId: BRANCH_ID };

const BASE = 'https://example.invalid';
const SALES_PATH = '/api/pos/v1/sales';
// 016 (D5): the sale-wire credential is the opaque pos_operator ENVELOPE
// (NOT the Clerk JWT, NOT the device token). Held in-process; read per-POST.
const ENVELOPE = 'opaque-pos-operator-envelope-headless-smoke';

const FIXED_NOW = '2026-06-19T10:00:00.000Z';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** Repo's established fetch-mock pattern (create-sale-sync-client.test.ts). */
function captureFetch(status: number | 'reject'): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: stringifyInput(input), init: init ?? {} });
    if (status === 'reject') return Promise.reject(new Error('network down'));
    return Promise.resolve(new Response(null, { status }));
  };
  return { fetchImpl, captured };
}

/** Normalise the `fetch` first argument (string / URL / Request) to its URL string. */
function stringifyInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Read a single header off a captured `RequestInit` (case-sensitive), or null. */
function headerValue(init: RequestInit, name: string): string | null {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name] ?? null;
}

/**
 * Wire the production sale-sync composition (minus GUI). The DB is sql.js with
 * the full migration stack (`sales`, `sale_sync_outbox`, `sale_sync_state`
 * exactly as production sees them); the only injected seam is `fetch` (the
 * network) and an in-process `getOperatorToken`.
 */
function wireProductionSyncPath(opts: {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getOperatorToken: () => string | null;
  now?: () => string;
}) {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);

  // Production factories — the same ones index.ts constructs at boot.
  const stateRepo = createSaleSyncStateRepo(handle);
  const salesRepo = bindSalesRepository(handle);
  const outboxRepo = bindSaleSyncOutboxRepository(handle);
  const client = createSaleSyncClient({
    baseUrl: BASE,
    fetch: opts.fetchImpl,
    getOperatorToken: opts.getOperatorToken,
  });
  const deadLetters: string[] = [];
  const engine = createSaleSyncEngine({
    client,
    stateRepo,
    salesRepo,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    getOperatorToken: opts.getOperatorToken,
    now: opts.now ?? (() => FIXED_NOW),
    backoff: { baseMs: 1_000, maxMs: 5 * 60 * 1_000 },
    onDeadLetter: (saleId) => deadLetters.push(saleId),
  });

  return { db, handle, stateRepo, salesRepo, outboxRepo, client, engine, deadLetters };
}

/** Drive one drain exactly as the main-process interval does (index.ts L1362). */
async function tick(engine: SaleSyncEngine): Promise<void> {
  const admission = engine.runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

/**
 * Stage a finalized sale + its enqueue-only outbox row.
 *
 * (1) sale/envelope creation: the durable Sale is the payload source. Seeded
 *     via the fixture (production `sales` schema); 008's finalize-transaction is
 *     the real writer in prod, fixtured here per the allowed GUI-input mock.
 * (2) outbox insertion: done through the PRODUCTION outbox repository
 *     (`bindSaleSyncOutboxRepository().insert`), not raw SQL — so the real
 *     enqueue path is exercised.
 */
function stageFinalizedSale(
  h: ReturnType<typeof wireProductionSyncPath>,
  saleId: string,
  opts: { enqueued_at?: string } = {},
): void {
  seedSale(h.db, {
    sale_id: saleId,
    tenant_id: TENANT_ID,
    branch_id: BRANCH_ID,
    terminal_id: TERMINAL_ID,
  });
  h.outboxRepo.insert({
    outbox_row_id: `ob-${saleId}`,
    sale_id: saleId,
    envelope_handoff_action_id: `handoff-${saleId}`,
    tenant_id: TENANT_ID,
    branch_id: BRANCH_ID,
    terminal_id: TERMINAL_ID,
    state: 'pending',
    enqueued_at: opts.enqueued_at ?? '2026-06-19T09:59:59.000Z',
  });
}

describe('POS-SYNC-LAB-001 — headless sale-sync wire smoke', () => {
  it('a finalized sale reaches DP2 (201) through the production drain → synced, no GUI', async () => {
    const SALE_ID = 'sale-headless-1';
    const EXPECTED_EXTERNAL_ID = `pos-pulse:handoff-${SALE_ID}`;
    const { fetchImpl, captured } = captureFetch(201);
    const h = wireProductionSyncPath({ fetchImpl, getOperatorToken: () => ENVELOPE });

    // ---- phase 1+2: sale/envelope creation + outbox insertion (production) ----
    stageFinalizedSale(h, SALE_ID);

    const outbox = nn(h.outboxRepo.readBySale(SALE_ID));
    const sale = nn(h.salesRepo.readById(SALE_ID));
    // Pre-drain: an outbox row exists, NO sale_sync_state row yet (first drain).
    expect(h.stateRepo.read(SALE_ID)).toBeNull();
    expect(h.stateRepo.eligible(SCOPE, FIXED_NOW).map((e) => e.sale_id)).toEqual([SALE_ID]);

    // ---- phase 3: drain execution (real engine + real live client) ----
    await tick(h.engine);

    // ---- phase 4: HTTP result classification (201 → ok) ----
    expect(captured).toHaveLength(1);
    const req = nn(captured[0]);
    expect(req.url).toBe(`${BASE}${SALES_PATH}`);
    expect(req.init.method).toBe('POST');

    // operator/session presence is proven ON THE WIRE: the opaque envelope rides
    // in the Authorization header (operatorAuthorization scheme), NEVER the body.
    expect(headerValue(req.init, 'Authorization')).toBe(`Bearer ${ENVELOPE}`);
    // 016 (D7): X-Device-Attestation is retired from the sale wire — assert absent.
    expect(headerValue(req.init, 'X-Device-Attestation')).toBeNull();
    expect(headerValue(req.init, 'Idempotency-Key')).toBe(EXPECTED_EXTERNAL_ID);
    expect(headerValue(req.init, 'Content-Type')).toBe('application/json');

    const bodyStr = req.init.body as string;
    // No secret in the body: the envelope must never be serialised into the payload.
    expect(bodyStr).not.toContain(ENVELOPE);
    const body = JSON.parse(bodyStr) as {
      sourceSystem: string;
      externalId: string;
      currencyCode: string;
      posTotal: string;
      occurredAt: string;
      lines: Array<Record<string, unknown>>;
    };
    expect(body.sourceSystem).toBe('pos-pulse');
    expect(body.externalId).toBe(EXPECTED_EXTERNAL_ID);
    expect(body.currencyCode).toBe('EGP');
    expect(body.posTotal).toBe('15.00'); // 1500 minor → exact-decimal string (no float)
    expect(body.lines[0]?.['lineName']).toBe('Panadol');
    // No tender / payment fields on the v1 capture wire (gate A.5).
    expect('tender' in body).toBe(false);
    expect('payment' in body).toBe(false);

    // ---- phase 5: ack/retry/dead-letter persistence (ok → synced) ----
    const state = nn(h.stateRepo.read(SALE_ID));
    expect(state.sync_status).toBe('synced');
    expect(state.attempt_count).toBe(0);
    expect(state.synced_at).toBe(FIXED_NOW);
    // The outbox is enqueue-only (008 AD-3): the row is untouched by the drain.
    expect(nn(h.outboxRepo.readBySale(SALE_ID)).state).toBe('pending');
    // No longer eligible — terminal state.
    expect(h.stateRepo.eligible(SCOPE, '2026-07-01T00:00:00.000Z')).toEqual([]);

    // ---- evidence (non-secret) for the smoke report ----
    const evidence = {
      sale_id: SALE_ID,
      outbox_id: outbox.outbox_row_id,
      terminal_id: sale.terminal_id,
      operator_session_present: true,
      external_id: body.externalId,
      // request body shape/hash — NOT secrets (envelope asserted absent above).
      request_body_sha256: createHash('sha256').update(bodyStr).digest('hex'),
      http_status: 201,
      retry_classification: 'ok',
      final_sync_status: state.sync_status,
    };
    expect(evidence.outbox_id).toBe(`ob-${SALE_ID}`);
    expect(evidence.terminal_id).toBe(TERMINAL_ID);
    expect(evidence.request_body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.final_sync_status).toBe('synced');

    h.db.close();
  });

  it('FR-3 gate: the operator session/envelope MUST be present at drain time — absent ⇒ NO POST', async () => {
    // The trust boundary is enforced by PRODUCTION code (the engine's
    // envelope-present gate), not weakened to make the smoke pass. The holder
    // normalises an absent envelope to '' (sign-in/takeover), so both null and
    // '' must pause the drain identically.
    for (const absentEnvelope of [null, ''] as Array<string | null>) {
      const { fetchImpl, captured } = captureFetch(201);
      const h = wireProductionSyncPath({ fetchImpl, getOperatorToken: () => absentEnvelope });
      stageFinalizedSale(h, 'sale-1');

      await tick(h.engine);

      // No POST left the terminal; nothing attempted; sale stays eligible.
      expect(captured).toHaveLength(0);
      expect(h.stateRepo.read('sale-1')).toBeNull();
      expect(h.stateRepo.eligible(SCOPE, '2026-07-01T00:00:00.000Z').map((e) => e.sale_id)).toEqual(
        ['sale-1'],
      );
      h.db.close();
    }
  });

  it('classification: a 503 from DP2 stays pending and is scheduled for retry (no loss)', async () => {
    const { fetchImpl, captured } = captureFetch(503);
    const h = wireProductionSyncPath({ fetchImpl, getOperatorToken: () => ENVELOPE });
    stageFinalizedSale(h, 'sale-1');

    await tick(h.engine);

    expect(captured).toHaveLength(1);
    const state = nn(h.stateRepo.read('sale-1'));
    expect(state.sync_status).toBe('pending');
    expect(state.attempt_count).toBe(1);
    expect(state.last_error_category).toBe('transient');
    expect(state.next_retry_at).not.toBeNull();
    expect(nn(state.next_retry_at) > FIXED_NOW).toBe(true);
    h.db.close();
  });

  it('classification: a transport fault (no_connection) stays pending, no count loss', async () => {
    const { fetchImpl } = captureFetch('reject');
    const h = wireProductionSyncPath({ fetchImpl, getOperatorToken: () => ENVELOPE });
    stageFinalizedSale(h, 'sale-1');

    await tick(h.engine);

    const state = nn(h.stateRepo.read('sale-1'));
    expect(state.sync_status).toBe('pending');
    expect(state.last_error_category).toBe('no_connection');
    // Still eligible for the next tick.
    expect(h.stateRepo.eligible(SCOPE, '2026-07-01T00:00:00.000Z').map((e) => e.sale_id)).toEqual([
      'sale-1',
    ]);
    h.db.close();
  });

  it('classification: a 400 (genuine contract defect) → dead_letter + operator notification', async () => {
    const { fetchImpl } = captureFetch(400);
    const h = wireProductionSyncPath({ fetchImpl, getOperatorToken: () => ENVELOPE });
    stageFinalizedSale(h, 'sale-1');

    await tick(h.engine);

    expect(nn(h.stateRepo.read('sale-1')).sync_status).toBe('dead_letter');
    expect(h.deadLetters).toEqual(['sale-1']);
    h.db.close();
  });

  it('headless drive path mirrors the main interval: single-flight admission, no IPC/preload', async () => {
    // The main process drains by calling `engine.runTickOnce()` on an interval
    // (index.ts L1362). This harness uses the SAME admission — and the same
    // single-flight coalescing the interval relies on — with no bridge in the
    // loop. This documents that GUI wiring is isolated (not under test here).
    const { fetchImpl } = captureFetch(201);
    const h = wireProductionSyncPath({ fetchImpl, getOperatorToken: () => ENVELOPE });
    stageFinalizedSale(h, 'sale-1');

    const first = h.engine.runTickOnce();
    const second = h.engine.runTickOnce();
    expect(first.kind).toBe('started');
    expect(second.kind).toBe('already_running');
    if (first.kind === 'started') await first.completed;
    expect(nn(h.stateRepo.read('sale-1')).sync_status).toBe('synced');
    h.db.close();
  });
});
