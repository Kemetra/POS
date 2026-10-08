/**
 * RT-190 — a capture 409 is a terminal payload divergence, end to end.
 *
 * Wires the SAME production composition as `index.ts` (state repo + sales repo
 * + outbox repo + the LIVE `createSaleSyncClient` + the engine) on the full
 * migration stack; only `fetch` is replaced. Proves:
 *   • a 409 `idempotency_key_conflict` never yields `synced`: the sale is
 *     dead-lettered with reason `payload_divergence` and never POSTed again;
 *   • a 409 with a malformed body is dead-lettered the same way (fail closed);
 *   • 200/201 replays (`Idempotent-Replayed`) still count as success;
 *   • the sync-status counts include the divergence;
 *   • the divergence notification carries only the opaque externalId and the
 *     closed-set error code — no PII, no server message, no credential (P7).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { createSaleSyncStateRepo } from '../sale-sync-state-repo.js';
import { createSaleSyncEngine } from '../sale-sync-engine.js';
import { createSaleSyncClient } from '../create-sale-sync-client.js';
import type { CaptureConflictCode } from '../sale-sync-client-types.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { bindSaleSyncOutboxRepository } from '../../sync-outbox/sale-sync-outbox.repository.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const TENANT_ID = 'tenant-1';
const BRANCH_ID = 'branch-1';
const TERMINAL_ID = 'term-1';
const SCOPE = { tenantId: TENANT_ID, branchId: BRANCH_ID, terminalId: TERMINAL_ID };
const ENVELOPE = 'opaque-pos-operator-envelope-rt190';
const NOW = '2026-10-04T10:00:00.000Z';
const LATER = '2027-01-01T00:00:00.000Z';
const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6';
const SERVER_MESSAGE = 'sale already captured with different tenders';

interface Reply {
  status: number;
  body: string | null;
  headers?: Record<string, string>;
}

interface DivergenceInfo {
  externalId: string;
  errorCode: CaptureConflictCode;
}

function wire(replies: Reply[]) {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);
  const stateRepo = createSaleSyncStateRepo(handle);
  const outboxRepo = bindSaleSyncOutboxRepository(handle);
  let posts = 0;
  const fetchImpl = (): Promise<Response> => {
    const reply = nn(replies[Math.min(posts, replies.length - 1)]);
    posts += 1;
    return Promise.resolve(
      new Response(reply.body, {
        status: reply.status,
        headers: { 'Content-Type': 'application/json', ...reply.headers },
      }),
    );
  };
  const divergences: DivergenceInfo[] = [];
  const deadLetters: string[] = [];
  let clock = NOW;
  const engine = createSaleSyncEngine({
    client: createSaleSyncClient({
      baseUrl: 'https://example.invalid',
      fetch: fetchImpl,
      getOperatorToken: () => ENVELOPE,
    }),
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    resolveTerminalId: () => TERMINAL_ID,
    getOperatorToken: () => ENVELOPE,
    now: () => clock,
    backoff: { baseMs: 1_000, maxMs: 5 * 60 * 1_000 },
    onDeadLetter: (saleId) => deadLetters.push(saleId),
    onPayloadDivergence: (info) => divergences.push(info),
  });

  async function tick(at: string = NOW): Promise<void> {
    clock = at;
    const admission = engine.runTickOnce();
    if (admission.kind === 'started') await admission.completed;
  }

  function stage(saleId: string): void {
    seedSale(db, {
      sale_id: saleId,
      tenant_id: TENANT_ID,
      branch_id: BRANCH_ID,
      terminal_id: TERMINAL_ID,
    });
    outboxRepo.insert({
      outbox_row_id: `ob-${saleId}`,
      sale_id: saleId,
      envelope_handoff_action_id: `handoff-${saleId}`,
      tenant_id: TENANT_ID,
      branch_id: BRANCH_ID,
      terminal_id: TERMINAL_ID,
      state: 'pending',
      enqueued_at: '2026-10-04T09:59:59.000Z',
    });
  }

  return { db, stateRepo, tick, stage, divergences, deadLetters, posts: () => posts };
}

const conflict = (body: string | null): Reply => ({ status: 409, body });
const CONFLICT_JSON = JSON.stringify({
  error: { code: 'idempotency_key_conflict', message: SERVER_MESSAGE },
});

describe('RT-190 — capture 409 is a terminal payload divergence (production wiring)', () => {
  it('409 idempotency_key_conflict → dead_letter(payload_divergence), never synced, never re-sent', async () => {
    const h = wire([conflict(CONFLICT_JSON)]);
    try {
      h.stage('sale-1');
      await h.tick();
      await h.tick(LATER); // far past any backoff window

      const row = nn(h.stateRepo.read('sale-1'));
      expect(row.sync_status).toBe('dead_letter');
      expect(row.last_error_category).toBe('payload_divergence');
      expect(row.synced_at).toBeNull();
      expect(row.server_sale_ref).toBeNull();
      expect(row.last_attempt_at).toBe(NOW); // the durable audit trail of when it diverged
      expect(h.posts()).toBe(1);
      expect(h.stateRepo.eligible(SCOPE, LATER)).toEqual([]);
      expect(h.divergences).toEqual([
        { externalId: 'pos-pulse:handoff-sale-1', errorCode: 'idempotency_key_conflict' },
      ]);
      expect(h.deadLetters).toEqual([]);
    } finally {
      h.db.close();
    }
  });

  it.each<[string, string | null]>([
    ['truncated JSON', '{"error":'],
    ['an empty body', null],
    ['an HTML body', '<html>409</html>'],
    ['another error code', JSON.stringify({ error: { code: 'conflict', message: 'x' } })],
  ])('409 with %s → dead_letter(payload_divergence) as unrecognized', async (_label, body) => {
    const h = wire([conflict(body)]);
    try {
      h.stage('sale-1');
      await h.tick();
      const row = nn(h.stateRepo.read('sale-1'));
      expect(row.sync_status).toBe('dead_letter');
      expect(row.last_error_category).toBe('payload_divergence');
      expect(h.divergences).toEqual([
        { externalId: 'pos-pulse:handoff-sale-1', errorCode: 'unrecognized' },
      ]);
    } finally {
      h.db.close();
    }
  });

  it.each<[string, Reply]>([
    ['201 first capture', { status: 201, body: JSON.stringify({ saleRef: SALE_REF }) }],
    [
      '201 same-key replay',
      {
        status: 201,
        body: JSON.stringify({ saleRef: SALE_REF }),
        headers: { 'Idempotent-Replayed': 'true' },
      },
    ],
    [
      '200 provenance replay',
      {
        status: 200,
        body: JSON.stringify({ saleRef: SALE_REF }),
        headers: { 'Idempotent-Replayed': 'true' },
      },
    ],
  ])('%s still counts as success (synced with saleRef)', async (_label, reply) => {
    const h = wire([reply]);
    try {
      h.stage('sale-1');
      await h.tick();
      const row = nn(h.stateRepo.read('sale-1'));
      expect(row.sync_status).toBe('synced');
      expect(row.server_sale_ref).toBe(SALE_REF);
      expect(h.divergences).toEqual([]);
      expect(h.stateRepo.readSyncStatus(SCOPE)).toEqual({
        pending: 0,
        heldPreviousPairing: 0,
        deadLetter: 0,
        payloadDivergence: 0,
        lastSuccessAt: NOW,
      });
    } finally {
      h.db.close();
    }
  });

  it('the sync-status counts include the divergence', async () => {
    const h = wire([
      conflict(CONFLICT_JSON),
      { status: 201, body: JSON.stringify({ saleRef: SALE_REF }) },
      { status: 422, body: null },
    ]);
    try {
      h.stage('sale-1'); // → 409 divergence
      h.stage('sale-2'); // → 201 synced
      h.stage('sale-3'); // → 422 permanent dead-letter
      h.stage('sale-4'); // → 422 again (last reply repeats)
      await h.tick();
      expect(h.stateRepo.readSyncStatus(SCOPE)).toEqual({
        pending: 0,
        heldPreviousPairing: 0,
        deadLetter: 3,
        payloadDivergence: 1,
        lastSuccessAt: NOW,
      });
    } finally {
      h.db.close();
    }
  });

  it('the divergence notification carries no PII, server message or credential', async () => {
    const h = wire([conflict(CONFLICT_JSON)]);
    try {
      h.stage('sale-1');
      await h.tick();
      const info = nn(h.divergences[0]);
      expect(Object.keys(info).sort()).toEqual(['errorCode', 'externalId']);
      const serialized = JSON.stringify(h.divergences);
      for (const forbidden of [
        'Panadol', // line name
        'op-1', // selling operator id
        'Operator One', // selling operator name
        'R-sale-1', // receipt number
        'SN-sale-1', // sale number
        ENVELOPE, // operator credential
        SERVER_MESSAGE, // raw server text
        'tenant-1',
        'term-1',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      h.db.close();
    }
  });
});
