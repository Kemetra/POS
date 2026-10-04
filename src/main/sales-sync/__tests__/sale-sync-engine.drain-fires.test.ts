/**
 * Sync-gap verification (test A) — when an operator token IS present and a
 * pending sale is eligible, the drain MUST POST it and mark it synced.
 *
 * Context: a finalized sale enqueues to the 008 `sale_sync_outbox` (pending)
 * but only reaches DP-2 when the 011 engine ticks WITH a present operator
 * envelope (FR-3 gate). The gate (no token → pause) was code-read; this proves
 * the OTHER half — that with a token, the drain actually fires the POST and the
 * sale lands `synced` (it had never been exercised in-app, only server-side via
 * a seeded token). Fake-driven (DI seams) — no Electron, no DB, no GUI.
 */

import { describe, it, expect, vi } from 'vitest';

import { createSaleSyncEngine } from '../sale-sync-engine.js';
import type { SaleSyncEngineDeps, SaleReadPort } from '../sale-sync-engine.js';
import type { SaleSyncStateRepo, EligibleSale } from '../sale-sync-state-repo.js';
import { createFakeSaleSyncClient } from '../sale-sync-client-types.js';
import type { SaleRow } from '../../sales/repositories/sales.repository.js';

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';
const SALE_ID = 'sale-1';

const HANDOFF = 'handoff-abc';

/** SaleRow with the fields buildCapturePayload reads (externalId + lines). */
function fakeSaleRow(): SaleRow {
  return {
    sale_id: SALE_ID,
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: 'terminal-1',
    selling_operator_id: 'op-1',
    envelope_handoff_action_id: HANDOFF,
    finalized_at: '2026-06-19T06:02:29.138Z',
    subtotal_minor: 1250,
    lines_json: JSON.stringify([
      {
        line_id: 'line-1',
        item_ref: 'prod-1',
        display_name: 'Paracetamol 500mg Tablets',
        quantity: 1,
        unit_price_minor: 1250,
        line_subtotal_minor: 1250,
      },
    ]),
  } as unknown as SaleRow;
}

function makeStateRepo(eligible: EligibleSale[]): {
  repo: SaleSyncStateRepo;
  markSynced: ReturnType<typeof vi.fn>;
  recordTransient: ReturnType<typeof vi.fn>;
  markDeadLetter: ReturnType<typeof vi.fn>;
} {
  const markSynced = vi.fn();
  const recordTransient = vi.fn();
  const markDeadLetter = vi.fn();
  const repo: SaleSyncStateRepo = {
    read: () => null,
    eligible: () => eligible,
    markSynced,
    markDeadLetter,
    recordTransient,
  } as unknown as SaleSyncStateRepo;
  return { repo, markSynced, recordTransient, markDeadLetter };
}

function makeEngine(over: Partial<SaleSyncEngineDeps>): SaleSyncEngineDeps {
  const salesRepo: SaleReadPort = { readById: () => fakeSaleRow() };
  return {
    client: createFakeSaleSyncClient([{ kind: 'ok', saleRef: null }]),
    stateRepo: makeStateRepo([{ sale_id: SALE_ID } as EligibleSale]).repo,
    salesRepo,
    tenantId: TENANT,
    branchId: BRANCH,
    getOperatorToken: () => 'envelope-present',
    now: () => '2026-06-19T09:00:00.000Z',
    backoff: { baseMs: 1000, maxMs: 300000 },
    ...over,
  };
}

describe('sale-sync drain — fires the POST when a token is present', () => {
  it('POSTs an eligible pending sale and marks it synced when an operator token is present', async () => {
    const client = createFakeSaleSyncClient([{ kind: 'ok', saleRef: null }]);
    const { repo, markSynced } = makeStateRepo([{ sale_id: SALE_ID } as EligibleSale]);
    const engine = createSaleSyncEngine(
      makeEngine({ client, stateRepo: repo, getOperatorToken: () => 'envelope-present' }),
    );

    const admission = engine.runTickOnce();
    expect(admission.kind).toBe('started');
    if (admission.kind === 'started') await admission.completed;

    // Drain fired: the sale was POSTed (deterministic externalId from the
    // handoff action) and marked synced.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.externalId).toBe(`pos-pulse:${HANDOFF}`);
    expect(client.calls[0]?.totalMinor).toBe(1250);
    expect(markSynced).toHaveBeenCalledTimes(1);
    expect(markSynced).toHaveBeenCalledWith(
      expect.objectContaining({ saleId: SALE_ID, tenantId: TENANT, branchId: BRANCH }),
    );
  });

  it('PAUSES the drain (no POST) when no operator token is present — the FR-3 gate', async () => {
    const client = createFakeSaleSyncClient([{ kind: 'ok', saleRef: null }]);
    const { repo, markSynced } = makeStateRepo([{ sale_id: SALE_ID } as EligibleSale]);
    const engine = createSaleSyncEngine(
      makeEngine({ client, stateRepo: repo, getOperatorToken: () => null }),
    );

    const admission = engine.runTickOnce();
    if (admission.kind === 'started') await admission.completed;

    // No token → no POST, no state change. The sale stays pending (not lost).
    expect(client.calls).toHaveLength(0);
    expect(markSynced).not.toHaveBeenCalled();
  });

  it('treats an empty-string token as ABSENT (envelope "" → paused, not a no_connection POST)', async () => {
    const client = createFakeSaleSyncClient([{ kind: 'ok', saleRef: null }]);
    const { repo, markSynced } = makeStateRepo([{ sale_id: SALE_ID } as EligibleSale]);
    const engine = createSaleSyncEngine(
      makeEngine({ client, stateRepo: repo, getOperatorToken: () => '' }),
    );

    const admission = engine.runTickOnce();
    if (admission.kind === 'started') await admission.completed;

    expect(client.calls).toHaveLength(0);
    expect(markSynced).not.toHaveBeenCalled();
  });
});
