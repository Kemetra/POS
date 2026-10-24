/**
 * RT-856 (RT-699 I3, doc 28 §3.3) — the manual line discount is frozen into
 * the Sale's `lines_json` at finalize.
 *
 * Each discounted line gains a `discount` object built from its envelope
 * placeholder and its `cart.discount.manager_authorized` audit row: `kind`,
 * `value`, `amount_minor`, `placeholder_id`, `reason_code`, `authority_source`,
 * `approver_role` (only when the row has it, never invented), and
 * `approver_operator_id` (the row's `approving_supervisor_id`). The line keeps
 * its gross `line_subtotal_minor`; the Sale's `subtotal_minor` is the net.
 *
 * Runs over sql.js with EVERY migration applied: the discount is a JSON shape
 * in the existing `lines_json` TEXT column, so no local migration is needed.
 *
 * Fail closed: a discount the dispatch cannot attribute (no audit row, or one
 * recording another amount) or whose total disagrees with the settled amount
 * refuses the projection. RT-614's handoff check makes this unreachable in
 * practice; a refusal leaves the settled attempt unfinalized and logged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import { buildFinalizeInput } from '../../../../src/main/sales/finalize-dispatch.js';
import { bindFinalizeTransaction } from '../../../../src/main/sales/finalize-transaction.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindSaleSyncOutboxRepository } from '../../../../src/main/sync-outbox/sale-sync-outbox.repository.js';
import { bindSaleNumberAllocator } from '../../../../src/main/sales/sale-number-allocator.js';
import { createSaleAuditEmitter } from '../../../../src/main/sales/audit-emitter.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import { freshMigratedDbPerTest } from '../payments/__fixtures__/real-payments-core.js';
import {
  HANDOFF,
  seedDiscountedHandoff,
  type SeedLine,
} from './__helpers__/discounted-handoff-seed.js';

const currentDb = freshMigratedDbPerTest();
let db: SqlJsDatabase;
beforeEach(() => {
  db = currentDb();
});

const PANADOL: SeedLine = {
  line_id: 'line-1',
  display_name: 'Panadol Extra',
  quantity: 2,
  unit_price_minor: 4500,
};
const VITAMIN: SeedLine = {
  line_id: 'line-2',
  display_name: 'Vitamin C',
  quantity: 1,
  unit_price_minor: 2500,
};

function project() {
  return buildFinalizeInput({ db: makeSqlJsHandle(db), handoff_action_id: HANDOFF });
}

function finalizeAndReadLines(): unknown[] {
  const projected = project();
  if (projected.kind !== 'ok') throw new Error(`projection refused: ${projected.reason}`);
  const handle = makeSqlJsHandle(db);
  let id = 0;
  const result = bindFinalizeTransaction({
    db: handle,
    salesRepo: bindSalesRepository(handle),
    outboxRepo: bindSaleSyncOutboxRepository(handle),
    allocator: bindSaleNumberAllocator(handle),
    auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
    now: () => '2026-10-24T10:00:02.000Z',
    saleIdGenerator: () => `sale-${String(++id)}`,
    outboxRowIdGenerator: () => `ob-${String(++id)}`,
  }).finalize(projected.input);
  expect(result.kind).toBe('finalized');
  const row = db.exec(`SELECT lines_json, subtotal_minor FROM sales`)[0]?.values[0];
  return [JSON.parse(String(row?.[0])), row?.[1]];
}

describe('RT-856 — the discount is frozen into lines_json at finalize', () => {
  it('a cashier-approved percent discount: the full shape, gross kept, Sale subtotal = net', () => {
    seedDiscountedHandoff(db, {
      lines: [PANADOL, VITAMIN],
      discounts: [
        { placeholder_id: 'dp-1', line_id: 'line-1', token: 'manual_pct_10', amount_minor: 900 },
      ],
      amountDue: 9000 + 2500 - 900,
    });
    const [lines, subtotal] = finalizeAndReadLines() as [Array<Record<string, unknown>>, number];
    expect(subtotal).toBe(10_600);
    expect(lines[0]).toMatchObject({ line_id: 'line-1', line_subtotal_minor: 9000 });
    expect(lines[0]?.['discount']).toEqual({
      kind: 'percent',
      value: 10,
      amount_minor: 900,
      placeholder_id: 'dp-1',
      reason_code: 'promotion',
      authority_source: 'cashier_approval',
      approver_operator_id: 'mgr-1',
    });
    // An undiscounted line carries no `discount` key at all.
    expect(lines[1]).not.toHaveProperty('discount');
  });

  it('a manager-session amount discount records the session role and no approval', () => {
    seedDiscountedHandoff(db, {
      lines: [PANADOL],
      discounts: [
        {
          placeholder_id: 'dp-1',
          line_id: 'line-1',
          token: 'manual_amt_500',
          amount_minor: 500,
          audit: {
            approval_id: undefined,
            approver_role: 'admin',
            reason_code: 'price_correction',
          },
          approving_supervisor_id: 'admin-7',
        },
      ],
      amountDue: 8500,
    });
    const [lines] = finalizeAndReadLines() as [Array<Record<string, unknown>>];
    expect(lines[0]?.['discount']).toEqual({
      kind: 'amount',
      value: 500,
      amount_minor: 500,
      placeholder_id: 'dp-1',
      reason_code: 'price_correction',
      authority_source: 'manager_session',
      approver_role: 'admin',
      approver_operator_id: 'admin-7',
    });
  });

  it('a cashier approval whose row carries approver_role (RT-861) keeps it', () => {
    seedDiscountedHandoff(db, {
      lines: [PANADOL],
      discounts: [
        {
          placeholder_id: 'dp-1',
          line_id: 'line-1',
          token: 'manual_pct_100',
          amount_minor: 9000,
          audit: { approver_role: 'manager' },
        },
      ],
      amountDue: 0,
    });
    const [lines, subtotal] = finalizeAndReadLines() as [Array<Record<string, unknown>>, number];
    expect(subtotal).toBe(0);
    expect(lines[0]?.['discount']).toMatchObject({
      kind: 'percent',
      value: 100,
      amount_minor: 9000,
      authority_source: 'cashier_approval',
      approver_role: 'manager',
    });
  });

  it('an undiscounted sale is unchanged: lines_json equals the envelope lines', () => {
    seedDiscountedHandoff(db, { lines: [PANADOL, VITAMIN], amountDue: 11_500 });
    const projected = project();
    if (projected.kind !== 'ok') throw new Error('refused');
    const envelope = JSON.parse(
      String(db.exec(`SELECT handoff_envelope_json FROM carts`)[0]?.values[0]?.[0]),
    ) as { lines: unknown[] };
    expect(projected.input.lines).toEqual(envelope.lines);
    const [lines, subtotal] = finalizeAndReadLines() as [unknown[], number];
    expect(lines).toEqual(envelope.lines);
    expect(subtotal).toBe(11_500);
  });

  it('a placeholder on a removed line, or a pre-RT-854 non-canonical kind, freezes nothing', () => {
    seedDiscountedHandoff(db, {
      lines: [PANADOL],
      discounts: [
        { placeholder_id: 'dp-gone', line_id: 'line-9', token: 'manual_pct_10', amount_minor: 0 },
        { placeholder_id: 'dp-old', line_id: 'line-1', token: 'manual', amount_minor: 0 },
      ],
      amountDue: 9000,
    });
    const [lines] = finalizeAndReadLines() as [Array<Record<string, unknown>>];
    expect(lines[0]).not.toHaveProperty('discount');
  });
});

describe('RT-856 — a discount the dispatch cannot attribute refuses the projection', () => {
  const discounted = (over: Record<string, unknown> | null, amountDue = 8100) => {
    seedDiscountedHandoff(db, {
      lines: [PANADOL],
      discounts: [
        {
          placeholder_id: 'dp-1',
          line_id: 'line-1',
          token: 'manual_pct_10',
          amount_minor: 900,
          audit: over,
        },
      ],
      amountDue,
    });
  };

  it('no cart.discount.manager_authorized row', () => {
    discounted(null);
    expect(project()).toEqual({ kind: 'refused', reason: 'discount_unattributed' });
  });

  it('a row recording another amount', () => {
    discounted({ amount_minor: 800 });
    expect(project()).toEqual({ kind: 'refused', reason: 'discount_unattributed' });
  });

  it('a row with no closed reason code', () => {
    discounted({ reason_code: 'loyal_customer' });
    expect(project()).toEqual({ kind: 'refused', reason: 'discount_unattributed' });
  });

  it('a row with no approving supervisor', () => {
    seedDiscountedHandoff(db, {
      lines: [PANADOL],
      discounts: [
        {
          placeholder_id: 'dp-1',
          line_id: 'line-1',
          token: 'manual_pct_10',
          amount_minor: 900,
          approving_supervisor_id: null,
        },
      ],
      amountDue: 8100,
    });
    expect(project()).toEqual({ kind: 'refused', reason: 'discount_unattributed' });
  });

  it('a settled amount that is not Σ gross − Σ discount', () => {
    discounted({}, 9000);
    expect(project()).toEqual({ kind: 'refused', reason: 'discount_total_mismatch' });
  });
});
