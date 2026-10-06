/**
 * RT-17 slice 3 — the shift cash-up wire bodies (`shift-wire.ts`).
 *
 * The bytes a fact is sent with are decided ONCE, when the fact is recorded
 * (RT-17 10931/10934): these builders turn a local fact (integer minor units)
 * into the exact `pos-shifts.openapi.yaml` 1.1.0-draft request body and its
 * Idempotency-Key. Every id goes out in lower case; every amount is an exact
 * decimal string in the shift currency's minor unit; the device path always
 * carries `operatorUserId` (= the fact's own actor).
 */
import { describe, expect, it } from 'vitest';

import {
  buildCashMovementRequest,
  buildCloseShiftRequest,
  buildOpenShiftRequest,
  ShiftFactInvalidError,
  type ShiftFactInvalidReason,
  type CashMovementFact,
  type ShiftCloseFact,
  type ShiftOpenFact,
} from '../shift-wire.js';

const SHIFT = '0192f5a2-3b4c-7d8e-9f01-23456789ab01';
const MOVE = '0192f5a2-3b4c-7d8e-9f01-23456789ab02';
const REF = '0192f5a2-3b4c-7d8e-9f01-23456789ab03';
const USER = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
const MANAGER = '0190f5a2-3b4c-7d8e-9f01-23456789abce';

const OPEN: ShiftOpenFact = {
  shiftId: SHIFT,
  openedAt: '2026-10-05T08:00:00.000Z',
  openingUserId: USER,
  currencyCode: 'EGP',
  openingFloatMinor: 50_000,
};

const MOVEMENT: CashMovementFact = {
  movementId: MOVE,
  shiftId: SHIFT,
  kind: 'pay_out',
  amountMinor: 12_000,
  reasonCode: 'petty_expense',
  note: 'Cleaning supplies',
  occurredAt: '2026-10-05T11:30:00.000Z',
  operatorUserId: USER,
};

/** The contract's own `normal` example, in minor units. */
const CLOSE: ShiftCloseFact = {
  shiftId: SHIFT,
  closedAt: '2026-10-05T16:00:00.000Z',
  closingUserId: USER,
  openingFloatMinor: 50_000,
  cashSalesTotalMinor: 245_000,
  cashRefundsTotalMinor: 7_500,
  payInTotalMinor: 0,
  payOutTotalMinor: 12_000,
  expectedCashMinor: 275_500,
  countedCashMinor: 275_000,
  varianceMinor: -500,
  saleCount: 37,
  cashRefundReturnRefs: [REF],
  varianceApprovedByUserId: MANAGER,
};

/** One refused fact: the change to a valid fixture and the expected reason. */
interface Refusal<F> {
  name: string;
  change: Partial<F>;
  reason: ShiftFactInvalidReason;
}

function invalidReason(build: () => unknown): string {
  try {
    build();
  } catch (err) {
    if (err instanceof ShiftFactInvalidError) return err.reason;
    throw err;
  }
  throw new Error('expected a ShiftFactInvalidError');
}

describe('buildOpenShiftRequest', () => {
  it('builds the exact openShift body and key, with operatorUserId = the opening user', () => {
    const built = buildOpenShiftRequest(OPEN);
    expect(built.request.idempotencyKey).toBe(`pos-pulse-shift-open:${SHIFT}`);
    expect(built.request.body).toBe(
      JSON.stringify({
        shiftId: SHIFT,
        openedAt: '2026-10-05T08:00:00.000Z',
        openingUserId: USER,
        currencyCode: 'EGP',
        openingFloat: '500.00',
        operatorUserId: USER,
      }),
    );
    expect(built.fact).toEqual(OPEN);
  });

  it('sends and keeps every id in lower case', () => {
    const built = buildOpenShiftRequest({
      ...OPEN,
      shiftId: SHIFT.toUpperCase(),
      openingUserId: USER.toUpperCase(),
    });
    expect(built.fact.shiftId).toBe(SHIFT);
    expect(built.fact.openingUserId).toBe(USER);
    expect(built.request.idempotencyKey).toBe(`pos-pulse-shift-open:${SHIFT}`);
    expect(JSON.parse(built.request.body)).toMatchObject({
      shiftId: SHIFT,
      openingUserId: USER,
      operatorUserId: USER,
    });
  });

  it.each([
    { currencyCode: 'JPY', openingFloatMinor: 500, wire: '500' },
    { currencyCode: 'KWD', openingFloatMinor: 500, wire: '0.500' },
    { currencyCode: 'EGP', openingFloatMinor: 0, wire: '0.00' },
  ])('renders the float in the $currencyCode minor unit', ({ wire, ...change }) => {
    const built = buildOpenShiftRequest({ ...OPEN, ...change });
    expect(JSON.parse(built.request.body)).toMatchObject({ openingFloat: wire });
  });

  it.each<Refusal<ShiftOpenFact>>([
    { name: 'a non-UUID shift id', change: { shiftId: 'shift-1' }, reason: 'invalid_id' },
    { name: 'a non-UUID opening user', change: { openingUserId: '' }, reason: 'invalid_id' },
    {
      name: 'a non-canonical instant',
      change: { openedAt: '2026-10-05T08:00:00Z' },
      reason: 'invalid_timestamp',
    },
    {
      name: 'an impossible date',
      change: { openedAt: '2026-02-31T08:00:00.000Z' },
      reason: 'invalid_timestamp',
    },
    {
      name: 'a currency with no known minor unit',
      change: { currencyCode: 'XYZ' },
      reason: 'unsupported_currency',
    },
    {
      name: 'a lower-case currency',
      change: { currencyCode: 'egp' },
      reason: 'unsupported_currency',
    },
    { name: 'a negative float', change: { openingFloatMinor: -1 }, reason: 'invalid_amount' },
    { name: 'a fractional float', change: { openingFloatMinor: 1.5 }, reason: 'invalid_amount' },
    {
      name: 'an unsafe float',
      change: { openingFloatMinor: Number.MAX_SAFE_INTEGER + 1 },
      reason: 'invalid_amount',
    },
    {
      name: 'a float beyond 15 integer digits',
      change: { currencyCode: 'JPY', openingFloatMinor: 10 ** 15 },
      reason: 'invalid_amount',
    },
  ])('refuses $name', ({ change, reason }) => {
    expect(invalidReason(() => buildOpenShiftRequest({ ...OPEN, ...change }))).toBe(reason);
  });

  it('names the field, never the value, in the error', () => {
    try {
      buildOpenShiftRequest({ ...OPEN, openingUserId: 'secret-looking-value' });
    } catch (err) {
      expect(err).toBeInstanceOf(ShiftFactInvalidError);
      expect((err as ShiftFactInvalidError).field).toBe('openingUserId');
      expect((err as Error).message).not.toContain('secret-looking-value');
    }
  });
});

describe('buildCashMovementRequest', () => {
  it('builds the exact recordCashMovement body and key', () => {
    const built = buildCashMovementRequest({ fact: MOVEMENT, currencyCode: 'EGP' });
    expect(built.request.idempotencyKey).toBe(`pos-pulse-shift-movement:${MOVE}`);
    expect(built.request.body).toBe(
      JSON.stringify({
        movementId: MOVE,
        kind: 'pay_out',
        amount: '120.00',
        reasonCode: 'petty_expense',
        note: 'Cleaning supplies',
        occurredAt: '2026-10-05T11:30:00.000Z',
        operatorUserId: USER,
      }),
    );
  });

  it('omits an absent note', () => {
    const withoutNote: CashMovementFact = { ...MOVEMENT };
    delete withoutNote.note;
    const built = buildCashMovementRequest({ fact: withoutNote, currencyCode: 'EGP' });
    expect(JSON.parse(built.request.body)).not.toHaveProperty('note');
    expect(built.fact).not.toHaveProperty('note');
  });

  it('lower-cases the movement, shift and operator ids', () => {
    const built = buildCashMovementRequest({
      fact: {
        ...MOVEMENT,
        movementId: MOVE.toUpperCase(),
        shiftId: SHIFT.toUpperCase(),
        operatorUserId: USER.toUpperCase(),
      },
      currencyCode: 'EGP',
    });
    expect(built.fact).toMatchObject({ movementId: MOVE, shiftId: SHIFT, operatorUserId: USER });
    expect(built.request.idempotencyKey).toBe(`pos-pulse-shift-movement:${MOVE}`);
  });

  it.each<Refusal<CashMovementFact>>([
    { name: 'a zero amount', change: { amountMinor: 0 }, reason: 'invalid_amount' },
    {
      name: 'an unknown kind',
      change: { kind: 'refund' as CashMovementFact['kind'] },
      reason: 'invalid_kind',
    },
    {
      name: 'an unknown reason code',
      change: { reasonCode: 'tip' as CashMovementFact['reasonCode'] },
      reason: 'invalid_reason_code',
    },
    { name: 'an empty note', change: { note: '' }, reason: 'invalid_note' },
    {
      name: 'a note over 200 characters',
      change: { note: 'x'.repeat(201) },
      reason: 'invalid_note',
    },
    { name: 'a non-UUID shift id', change: { shiftId: 'nope' }, reason: 'invalid_id' },
    {
      name: 'a non-canonical occurredAt',
      change: { occurredAt: 'yesterday' },
      reason: 'invalid_timestamp',
    },
  ])('refuses $name', ({ change, reason }) => {
    expect(
      invalidReason(() =>
        buildCashMovementRequest({ fact: { ...MOVEMENT, ...change }, currencyCode: 'EGP' }),
      ),
    ).toBe(reason);
  });

  it('accepts a note of exactly 200 characters', () => {
    const note = 'x'.repeat(200);
    const built = buildCashMovementRequest({ fact: { ...MOVEMENT, note }, currencyCode: 'EGP' });
    expect(JSON.parse(built.request.body)).toMatchObject({ note });
  });
});

describe('buildCloseShiftRequest', () => {
  it('builds the contract example close exactly, with operatorUserId = the closing user', () => {
    const built = buildCloseShiftRequest({ fact: CLOSE, currencyCode: 'EGP' });
    expect(built.request.idempotencyKey).toBe(`pos-pulse-shift-close:${SHIFT}`);
    expect(built.request.body).toBe(
      JSON.stringify({
        closedAt: '2026-10-05T16:00:00.000Z',
        closingUserId: USER,
        closeKind: 'normal',
        openingFloat: '500.00',
        cashSalesTotal: '2450.00',
        cashRefundsTotal: '75.00',
        payInTotal: '0.00',
        payOutTotal: '120.00',
        expectedCash: '2755.00',
        countedCash: '2750.00',
        variance: '-5.00',
        saleCount: 37,
        cashRefundReturnRefs: [REF],
        varianceApprovedByUserId: MANAGER,
        operatorUserId: USER,
      }),
    );
  });

  it('omits an absent variance approver and lower-cases the refs', () => {
    const fact: ShiftCloseFact = { ...CLOSE };
    delete fact.varianceApprovedByUserId;
    const built = buildCloseShiftRequest({
      fact: { ...fact, cashRefundReturnRefs: [REF.toUpperCase()] },
      currencyCode: 'EGP',
    });
    const body = JSON.parse(built.request.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('varianceApprovedByUserId');
    expect(body['cashRefundReturnRefs']).toEqual([REF]);
    expect(built.fact.cashRefundReturnRefs).toEqual([REF]);
  });

  it('renders an overage as a positive variance', () => {
    const built = buildCloseShiftRequest({
      fact: { ...CLOSE, countedCashMinor: 276_000, varianceMinor: 500 },
      currencyCode: 'EGP',
    });
    expect(JSON.parse(built.request.body)).toMatchObject({ variance: '5.00' });
  });

  it.each<Refusal<ShiftCloseFact>>([
    {
      name: 'a wrong expected cash',
      change: { expectedCashMinor: 275_501, varianceMinor: -501 },
      reason: 'cashup_inconsistent',
    },
    { name: 'a wrong variance', change: { varianceMinor: -499 }, reason: 'cashup_inconsistent' },
    {
      name: 'a negative expected cash',
      change: {
        cashRefundsTotalMinor: 400_000,
        expectedCashMinor: -117_000,
        countedCashMinor: 0,
        varianceMinor: 117_000,
      },
      reason: 'invalid_amount',
    },
    {
      name: 'a negative counted cash',
      change: { countedCashMinor: -1, varianceMinor: -275_501 },
      reason: 'invalid_amount',
    },
    { name: 'an unsafe variance', change: { varianceMinor: 0.5 }, reason: 'invalid_amount' },
    { name: 'a negative sale count', change: { saleCount: -1 }, reason: 'invalid_sale_count' },
    {
      name: 'a sale count past int32',
      change: { saleCount: 2_147_483_648 },
      reason: 'invalid_sale_count',
    },
    { name: 'a fractional sale count', change: { saleCount: 1.5 }, reason: 'invalid_sale_count' },
    {
      name: 'a duplicate refund ref',
      change: { cashRefundReturnRefs: [REF, REF.toUpperCase()] },
      reason: 'invalid_refund_refs',
    },
    {
      name: 'a non-UUID refund ref',
      change: { cashRefundReturnRefs: ['r-1'] },
      reason: 'invalid_id',
    },
    {
      name: 'a non-UUID approver',
      change: { varianceApprovedByUserId: 'boss' },
      reason: 'invalid_id',
    },
  ])('refuses $name', ({ change, reason }) => {
    expect(
      invalidReason(() =>
        buildCloseShiftRequest({ fact: { ...CLOSE, ...change }, currencyCode: 'EGP' }),
      ),
    ).toBe(reason);
  });

  it('refuses more than 1000 refund refs', () => {
    const refs = Array.from(
      { length: 1001 },
      (_, i) => `0192f5a2-3b4c-7d8e-9f01-${i.toString(16).padStart(12, '0')}`,
    );
    expect(
      invalidReason(() =>
        buildCloseShiftRequest({
          fact: { ...CLOSE, cashRefundReturnRefs: refs },
          currencyCode: 'EGP',
        }),
      ),
    ).toBe('invalid_refund_refs');
  });

  it('builds the same bytes from the same fact (deterministic)', () => {
    const a = buildCloseShiftRequest({ fact: CLOSE, currencyCode: 'EGP' });
    const b = buildCloseShiftRequest({ fact: { ...CLOSE }, currencyCode: 'EGP' });
    expect(a.request).toEqual(b.request);
  });
});
