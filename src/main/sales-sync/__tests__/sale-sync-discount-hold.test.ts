/**
 * RT-856 (RT-699 I3, doc 28 §6 DEP-1 guard) — a discounted sale is HELD from
 * sync until the capture path can send it (RT-858 / I4).
 *
 * The capability switch `discountCaptureSupported` defaults to off. While it is
 * off, the drain skips every sale whose `lines_json` carries a line `discount`:
 * no POST, no state row, no attempt count, never dead-lettered. The sale stays
 * pending, so turning the switch on drains it with no requeue step. The sync
 * status names the hold (`discount_capture_unavailable`) and counts it. An
 * undiscounted sale is sent exactly as before, in the same tick.
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
import { createFakeSaleSyncClient } from '../sale-sync-client-types.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createSaleSyncEngine, type SaleSyncEngineDeps } from '../sale-sync-engine.js';
import { createSaleSyncStatusReader } from '../sale-sync-status-reader.js';
import { SALE_DISCOUNT_CAPTURE_SUPPORTED, saleHasLineDiscount } from '../discount-hold.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };

const DISCOUNTED_LINES = JSON.stringify([
  {
    line_id: 'l-1',
    item_ref: 'p-1',
    display_name: 'Panadol',
    quantity: 2,
    unit_price_minor: 4500,
    line_subtotal_minor: 9000,
    note: null,
    discount: {
      kind: 'percent',
      value: 10,
      amount_minor: 900,
      placeholder_id: 'dp-1',
      reason_code: 'promotion',
      authority_source: 'cashier_approval',
      approver_operator_id: 'mgr-1',
    },
  },
]);

function harness(over: Partial<SaleSyncEngineDeps> = {}) {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);
  const stateRepo = createSaleSyncStateRepo(handle);
  const client = createFakeSaleSyncClient([
    { kind: 'ok', saleRef: null },
    { kind: 'ok', saleRef: null },
  ]);
  const deadLetters: string[] = [];
  const deps: SaleSyncEngineDeps = {
    client,
    stateRepo,
    salesRepo: bindSalesRepository(handle),
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    resolveTerminalId: () => SCOPE.terminalId,
    getOperatorToken: () => 'tok-1',
    now: () => '2026-10-24T10:05:00.000Z',
    backoff: { baseMs: 1000, maxMs: 300_000 },
    onDeadLetter: (saleId) => deadLetters.push(saleId),
    ...over,
  };
  seedSale(db, { sale_id: 'sale-disc', subtotal_minor: 8100, lines_json: DISCOUNTED_LINES });
  seedOutbox(db, { sale_id: 'sale-disc', enqueued_at: '2026-10-24T10:00:00.000Z' });
  seedSale(db, { sale_id: 'sale-plain' });
  seedOutbox(db, { sale_id: 'sale-plain', enqueued_at: '2026-10-24T10:01:00.000Z' });
  return { db, deps, stateRepo, client, deadLetters };
}

async function tick(deps: SaleSyncEngineDeps): Promise<void> {
  const admission = createSaleSyncEngine(deps).runTickOnce();
  if (admission.kind === 'started') await admission.completed;
}

function postedIds(client: ReturnType<typeof createFakeSaleSyncClient>): string[] {
  return client.calls.map((call) => call.externalId);
}

describe('RT-856 — the capability switch', () => {
  it('is off on main until RT-858 turns it on', () => {
    expect(SALE_DISCOUNT_CAPTURE_SUPPORTED).toBe(false);
  });

  it('a sale is discounted when any line carries a discount', () => {
    expect(saleHasLineDiscount({ lines_json: DISCOUNTED_LINES })).toBe(true);
    expect(saleHasLineDiscount({ lines_json: '[{"line_id":"l-1"}]' })).toBe(false);
    expect(saleHasLineDiscount({ lines_json: '[{"line_id":"l-1","discount":null}]' })).toBe(false);
    expect(saleHasLineDiscount({ lines_json: '[]' })).toBe(false);
    // An unreadable snapshot is held, never sent as a guess.
    expect(saleHasLineDiscount({ lines_json: 'not json' })).toBe(true);
  });
});

describe('RT-856 — switch off (default): the discounted sale is held', () => {
  it('is never sent, never touched, never dead-lettered; the undiscounted sale syncs', async () => {
    const h = harness();
    await tick(h.deps);
    await tick({ ...h.deps, now: () => '2027-01-01T00:00:00.000Z' });
    expect(h.client.calls).toHaveLength(1);
    expect(postedIds(h.client)[0]).not.toContain('sale-disc');
    expect(nn(h.stateRepo.read('sale-plain')).sync_status).toBe('synced');
    // Untouched: no state row (so no attempt count), still eligible, still pending.
    expect(h.stateRepo.read('sale-disc')).toBeNull();
    expect(h.stateRepo.eligible(SCOPE, '2027-01-01T00:00:00.000Z').map((r) => r.sale_id)).toEqual([
      'sale-disc',
    ]);
    expect(h.stateRepo.readSyncStatus(SCOPE)).toMatchObject({ pending: 1, deadLetter: 0 });
    expect(h.deadLetters).toEqual([]);
    h.db.close();
  });

  it('a held sale does not keep the drain paused', async () => {
    const h = harness();
    const engine = createSaleSyncEngine(h.deps);
    const admission = engine.runTickOnce();
    if (admission.kind === 'started') await admission.completed;
    await expect(engine.pausedReason()).resolves.toBeNull();
    h.db.close();
  });

  it('the status names the hold and counts it; pending still includes it', async () => {
    const h = harness();
    await tick(h.deps);
    const status = await createSaleSyncStatusReader({
      stateRepo: h.stateRepo,
      tenantId: SCOPE.tenantId,
      branchId: SCOPE.branchId,
      resolveTerminalId: () => SCOPE.terminalId,
      pausedReason: () => null,
    })();
    expect(status.pending).toBe(1);
    expect(status.held).toEqual({ reason: 'discount_capture_unavailable', count: 1 });
    h.db.close();
  });
});

describe('RT-856 — switch on (RT-858): the same stored sale drains with no requeue', () => {
  it('sends the held sale on the next tick', async () => {
    const h = harness();
    await tick(h.deps);
    await tick({ ...h.deps, discountCaptureSupported: true });
    expect(h.client.calls).toHaveLength(2);
    expect(nn(h.stateRepo.read('sale-disc')).sync_status).toBe('synced');
    h.db.close();
  });

  it('the status reports no hold', async () => {
    const h = harness();
    const status = await createSaleSyncStatusReader({
      stateRepo: h.stateRepo,
      tenantId: SCOPE.tenantId,
      branchId: SCOPE.branchId,
      resolveTerminalId: () => SCOPE.terminalId,
      pausedReason: () => null,
      discountCaptureSupported: true,
    })();
    expect(status.held).toBeNull();
    h.db.close();
  });
});

describe('RT-856 — countDiscountHeld', () => {
  it('counts only the current terminal’s unsent discounted sales', () => {
    const h = harness();
    seedSale(h.db, {
      sale_id: 'sale-other',
      terminal_id: 'term-old',
      lines_json: DISCOUNTED_LINES,
    });
    seedOutbox(h.db, { sale_id: 'sale-other', terminal_id: 'term-old' });
    seedSale(h.db, { sale_id: 'sale-done', lines_json: DISCOUNTED_LINES });
    seedOutbox(h.db, { sale_id: 'sale-done' });
    h.stateRepo.markSynced({ saleId: 'sale-done', ...SCOPE, now: '2026-10-24T10:00:00.000Z' });
    expect(h.stateRepo.countDiscountHeld(SCOPE)).toBe(1);
    expect(h.stateRepo.countDiscountHeld({ ...SCOPE, terminalId: null })).toBe(0);
    h.db.close();
  });

  it('a scalar line element is not a discount and never breaks the count', () => {
    const h = harness();
    seedSale(h.db, { sale_id: 'sale-scalar', lines_json: '["corrupt", 7, null]' });
    seedOutbox(h.db, { sale_id: 'sale-scalar' });
    expect(h.stateRepo.countDiscountHeld(SCOPE)).toBe(1);
    expect(saleHasLineDiscount({ lines_json: '["corrupt", 7, null]' })).toBe(false);
    h.db.close();
  });

  it('no discounted sale → no hold in the status', async () => {
    const db = freshSalesSyncDb();
    const stateRepo = createSaleSyncStateRepo(handleFor(db));
    seedSale(db, { sale_id: 'sale-plain' });
    seedOutbox(db, { sale_id: 'sale-plain' });
    const status = await createSaleSyncStatusReader({
      stateRepo,
      tenantId: SCOPE.tenantId,
      branchId: SCOPE.branchId,
      resolveTerminalId: () => SCOPE.terminalId,
      pausedReason: () => null,
    })();
    expect(status.held).toBeNull();
    db.close();
  });
});
