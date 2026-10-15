/**
 * RT-530 — a voided cash sale in the shift cash-up, counted like a cash refund.
 *
 * The voided sale's net cash goes back to the customer, so it reduces the
 * expected drawer cash and is reported in the close's `cashRefundsTotal` (it
 * names no return, so it adds no refund reference), in the window the void was
 * REQUESTED, whichever shift sold the sale. A void Backend-Core refused counts
 * nothing; a card-only sale has no drawer cash to take back.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createSaleVoidRepository } from '../../sale-void/sale-void-repository.js';
import {
  APPROVAL_A,
  newVoidEntry,
} from '../../sale-void/__tests__/__helpers__/sale-void-fixture.js';
import { computeCashup } from '../shift-cashup-calculator.js';
import type { ShiftCashupService } from '../shift-cashup-service.js';
import {
  CLOSED_AT,
  OPENED_AT,
  cardLine,
  cashLine,
  seedRefund,
  seedShiftSale,
  serviceHarness,
  storedBody,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import { SCOPE } from './__helpers__/shift-sync-fixture.js';

const FLOAT = 50_000;
const REF = '0192f5a2-3b4c-7d8e-9f01-0000000000c1';
const APPROVAL_N = (n: number): string => `0190f5a2-7b3c-7d4e-8f90-0000000000${String(n)}0`;

let db: SqlJsDatabase;
let harness: ServiceHarness;
let service: ShiftCashupService;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db);
  service = harness.service;
});

afterEach(() => {
  db.close();
});

/** Journal a void of `saleId` requested at `requestedAt`; `n` makes the ids unique. */
function seedVoid(input: {
  n: number;
  saleId: string;
  requestedAt: string;
  refused?: boolean;
}): void {
  const repo = createSaleVoidRepository(handleFor(db));
  repo.insert(
    newVoidEntry(input.n, {
      scope: SCOPE,
      saleId: input.saleId,
      approvalId: input.n === 1 ? APPROVAL_A : APPROVAL_N(input.n),
      now: input.requestedAt,
    }),
  );
  if (input.refused === true) {
    repo.markRefused({
      voidId: `v${String(input.n)}`,
      reason: 'void_self_approval',
      now: input.requestedAt,
    });
  }
}

function openAndAdvance(): ShiftCashupService {
  service.openShift({ openingFloatMinor: FLOAT });
  harness.state.clock = CLOSED_AT;
  return service;
}

describe('computeCashup with voids', () => {
  const sale = (lines: ReadonlyArray<Record<string, unknown>>) => ({
    tenderLinesSummaryJson: JSON.stringify(lines),
  });
  const base = {
    currencyCode: 'EGP',
    openingFloatMinor: FLOAT,
    payInTotalMinor: 0,
    payOutTotalMinor: 0,
    refunds: [],
  };

  it('subtracts the voided sale net cash, like a cash refund, and names no return', () => {
    const result = computeCashup({
      ...base,
      sales: [sale([cashLine(2_000, 500)])],
      voids: [sale([cashLine(2_000, 500)])],
    });
    expect(result).toEqual({
      cashSalesTotalMinor: 1_500,
      cashRefundsTotalMinor: 1_500,
      expectedCashMinor: FLOAT,
      saleCount: 1,
      cashRefundReturnRefs: [],
    });
  });

  it('adds a void to the refunds of returns in one total', () => {
    const result = computeCashup({
      ...base,
      sales: [],
      refunds: [{ returnRef: REF, amountMinor: 700, currencyCode: 'EGP' }],
      voids: [sale([cashLine(300)])],
    });
    expect(result.cashRefundsTotalMinor).toBe(1_000);
    expect(result.cashRefundReturnRefs).toEqual([REF]);
    expect(result.expectedCashMinor).toBe(FLOAT - 1_000);
  });

  it('takes nothing back for a card-only voided sale, and none without voids', () => {
    expect(
      computeCashup({ ...base, sales: [], voids: [sale([cardLine(9_000)])] }).cashRefundsTotalMinor,
    ).toBe(0);
    expect(computeCashup({ ...base, sales: [] }).cashRefundsTotalMinor).toBe(0);
  });

  it('refuses a voided sale whose tender summary cannot be read', () => {
    expect(() =>
      computeCashup({ ...base, sales: [], voids: [{ tenderLinesSummaryJson: 'not json' }] }),
    ).toThrow(expect.objectContaining({ reason: 'unreadable_sale_tenders' }) as Error);
  });
});

describe('closeShift counts a voided cash sale', () => {
  it('a sale and its void in the same shift net to the float, the close reports the void as a refund', () => {
    const svc = openAndAdvance();
    seedShiftSale(db, { saleId: 'sale-1', finalizedAt: OPENED_AT, lines: [cashLine(2_000, 500)] });
    seedVoid({ n: 1, saleId: 'sale-1', requestedAt: CLOSED_AT });
    const closed = svc.closeShift({ countedCashMinor: FLOAT });
    expect(closed).toMatchObject({
      cashSalesTotalMinor: 1_500,
      cashRefundsTotalMinor: 1_500,
      expectedCashMinor: FLOAT,
      varianceMinor: 0,
    });
    expect(storedBody(db, 2)).toMatchObject({
      cashSalesTotal: '15.00',
      cashRefundsTotal: '15.00',
      expectedCash: '500.00',
      cashRefundReturnRefs: [],
    });
  });

  it('counts a void in the shift it was requested in, even when an earlier shift sold the sale', () => {
    seedShiftSale(db, {
      saleId: 'sale-0',
      finalizedAt: '2026-10-05T06:00:00.000Z',
      lines: [cashLine(4_000)],
    });
    seedVoid({ n: 1, saleId: 'sale-0', requestedAt: CLOSED_AT });
    const closed = openAndAdvance().closeShift({ countedCashMinor: FLOAT - 4_000 });
    expect(closed).toMatchObject({
      cashSalesTotalMinor: 0,
      cashRefundsTotalMinor: 4_000,
      expectedCashMinor: FLOAT - 4_000,
      varianceMinor: 0,
    });
  });

  it('counts a requested, sent or confirmed void, but not a refused one or one outside the window', () => {
    seedShiftSale(db, { saleId: 'sale-1', finalizedAt: OPENED_AT, lines: [cashLine(1_000)] });
    seedShiftSale(db, { saleId: 'sale-2', finalizedAt: OPENED_AT, lines: [cashLine(2_000)] });
    seedShiftSale(db, { saleId: 'sale-3', finalizedAt: OPENED_AT, lines: [cashLine(4_000)] });
    seedVoid({ n: 1, saleId: 'sale-1', requestedAt: CLOSED_AT });
    seedVoid({ n: 2, saleId: 'sale-2', requestedAt: CLOSED_AT, refused: true });
    seedVoid({ n: 3, saleId: 'sale-3', requestedAt: '2026-10-05T20:00:00.000Z' });
    const closed = openAndAdvance().closeShift({ countedCashMinor: FLOAT + 7_000 - 1_000 });
    expect(closed).toMatchObject({ cashSalesTotalMinor: 7_000, cashRefundsTotalMinor: 1_000 });
  });

  it('a void and a return refund add up in the close', () => {
    seedShiftSale(db, { saleId: 'sale-1', finalizedAt: OPENED_AT, lines: [cashLine(1_000)] });
    seedVoid({ n: 1, saleId: 'sale-1', requestedAt: CLOSED_AT });
    seedRefund(db, { returnId: 'r-1', returnRef: REF, amountMinor: 700, paidAt: CLOSED_AT });
    const closed = openAndAdvance().closeShift({ countedCashMinor: FLOAT - 700 });
    expect(closed).toMatchObject({ cashRefundsTotalMinor: 1_700, expectedCashMinor: FLOAT - 700 });
    expect(storedBody(db, 2)).toMatchObject({ cashRefundReturnRefs: [REF] });
  });
});
