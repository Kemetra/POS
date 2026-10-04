/**
 * RT-15 S2 — the return service, end to end over sql.js and a fake Backend-Core.
 *
 * Covers the admission gate (AC1 flag off, no session, AC2 cashier refused and
 * audited), lookup (AC3 unsynced, D-c card, AC4 voided / nothing returnable,
 * the live readSale), quote (AC5 bounds, AC6 exact minor units), submit (AC8
 * journal before send, AC9/AC10 confirmed / refused / unknown, AC11 audits)
 * and list.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ReturnsRefusalReason } from '../../../shared/returns/types.js';
import type { Role } from '../../../shared/operator/role.js';
import {
  CARD_SUMMARY,
  LINE_A,
  LINE_B,
  RETURN_REF,
  SALE_NUMBER,
  SALE_REF,
  categories,
  errorBody,
  initReturnsSql,
  jsonResponse,
  omit,
  returnsHarness,
  saleBody,
  saleLine,
  seedSyncedSale,
  type HarnessOptions,
  type ReturnsHarness,
  type SeedSyncedSaleInput,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;

function setup(options: HarnessOptions = {}, sale: SeedSyncedSaleInput = {}): ReturnsHarness {
  h = returnsHarness(options);
  seedSyncedSale(h.db, sale);
  if (sale.sale !== undefined) h.backend.sale = sale.sale;
  return h;
}

/** Serve `sale` live AND seed the till's frozen lines to match it (a real capture). */
function setupServing(sale: ReturnType<typeof saleBody>): ReturnsHarness {
  return setup({}, { sale });
}

afterEach(() => {
  h.close();
});

const ONE_A = { saleNumber: SALE_NUMBER, lines: [{ lineRef: LINE_A, quantity: 1 }] };

function journalCount(): number {
  return Number(h.db.exec('SELECT COUNT(*) FROM return_journal')[0]?.values[0]?.[0] ?? 0);
}

describe('admission gate', () => {
  it('AC1: with the flag off every call is feature_disabled and nothing is sent or journaled', async () => {
    setup({ enabled: false });
    await expect(h.service.lookup({ saleNumber: SALE_NUMBER })).resolves.toEqual({
      kind: 'refused',
      reason: 'feature_disabled',
    });
    await expect(h.service.submit(ONE_A)).resolves.toEqual({
      kind: 'refused',
      reason: 'feature_disabled',
      ret: null,
    });
    await expect(h.service.list()).resolves.toMatchObject({ reason: 'feature_disabled' });
    await expect(h.service.resolve()).resolves.toMatchObject({ reason: 'feature_disabled' });
    expect(h.backend.calls).toHaveLength(0);
    expect(journalCount()).toBe(0);
    expect(h.audits).toHaveLength(0);
  });

  it('refuses no_session without auditing (no operator to attribute)', async () => {
    setup({ role: null });
    await expect(h.service.quote(ONE_A)).resolves.toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    expect(h.audits).toHaveLength(0);
  });

  it('AC2: a cashier is refused role_denied in main, and the refusal is audited', async () => {
    setup({ role: 'cashier' });
    await expect(h.service.submit(ONE_A)).resolves.toMatchObject({ reason: 'role_denied' });
    expect(h.backend.calls).toHaveLength(0);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action_category: 'sale.return.refused',
      acting_operator_id: 'op-cashier',
      originating_terminal_id: 'term-1',
      payload: { operation: 'submit', reason: 'role_denied', return_id: null },
    });
  });

  it.each<Role>(['manager', 'admin'])('admits a %s', async (role) => {
    setup({ role });
    await expect(h.service.lookup({ saleNumber: SALE_NUMBER })).resolves.toMatchObject({
      kind: 'ok',
    });
  });
});

describe('lookup', () => {
  it('reads the live sale and projects whole quantities and minor-unit prices', async () => {
    setup();
    const res = await h.service.lookup({ saleNumber: SALE_NUMBER });
    expect(res).toEqual({
      kind: 'ok',
      sale: {
        saleId: 'sale-1',
        saleNumber: SALE_NUMBER,
        saleRef: SALE_REF,
        currencyCode: 'EGP',
        lines: [
          {
            lineRef: LINE_A,
            lineName: 'Panadol 500mg',
            soldQuantity: 3,
            returnedQuantity: 0,
            returnableQuantity: 3,
            unitPriceMinor: 1500,
          },
          {
            lineRef: LINE_B,
            lineName: 'Vitamin C',
            soldQuantity: 1,
            returnedQuantity: 0,
            returnableQuantity: 1,
            unitPriceMinor: 2000,
          },
        ],
      },
    });
    expect(h.backend.calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `https://backend.example.invalid/api/pos/v1/sales/${SALE_REF}`],
    ]);
  });

  it.each<{
    label: string;
    sale: SeedSyncedSaleInput;
    number?: string;
    reason: ReturnsRefusalReason;
  }>([
    { label: 'unknown sale number', sale: {}, number: 'SN-nope', reason: 'sale_not_found' },
    {
      label: 'synced without a saleRef (pre-S1)',
      sale: { saleRef: null },
      reason: 'sale_not_synced',
    },
    { label: 'not yet synced', sale: { syncStatus: 'pending' }, reason: 'sale_not_synced' },
    {
      label: 'card tender on the local record',
      sale: { tenderSummary: CARD_SUMMARY },
      reason: 'card_tender_blocked',
    },
    {
      label: 'unreadable local tender summary',
      sale: { tenderSummary: '{' },
      reason: 'card_tender_blocked',
    },
  ])('AC3 / D-c: refuses a $label before any network call', async ({ sale, number, reason }) => {
    setup({}, sale);
    await expect(h.service.lookup({ saleNumber: number ?? SALE_NUMBER })).resolves.toEqual({
      kind: 'refused',
      reason,
    });
    expect(h.backend.calls).toHaveLength(0);
    expect(categories(h.audits)).toEqual(['sale.return.refused']);
  });

  it.each<{
    label: string;
    sale: Response | ReturnType<typeof saleBody>;
    reason: ReturnsRefusalReason;
  }>([
    { label: 'voided sale', sale: saleBody({ voided: true }), reason: 'sale_voided' },
    {
      label: 'card_external tender on the server sale',
      sale: saleBody({ tenders: [{ method: 'card_external', amount: '65.0000' }] }),
      reason: 'card_tender_blocked',
    },
    {
      label: 'fully returned sale',
      sale: saleBody({
        lines: [saleLine({ returnedQuantity: '3', returnableQuantity: '0.000000' })],
      }),
      reason: 'nothing_returnable',
    },
    {
      label: '404 (gate off or unknown sale)',
      sale: jsonResponse(404, errorBody('not_found')),
      reason: 'returns_unavailable',
    },
    {
      label: '401 envelope refused',
      sale: jsonResponse(401, errorBody('unauthorized')),
      reason: 'unauthorized',
    },
    {
      label: '500 server failure',
      sale: jsonResponse(500, errorBody('internal_error')),
      reason: 'offline',
    },
    {
      label: 'unreadable sale body',
      sale: jsonResponse(200, { saleRef: SALE_REF }),
      reason: 'offline',
    },
  ])('AC4 / D-a: refuses a $label from the live readSale', async ({ sale, reason }) => {
    if (sale instanceof Response) {
      setup();
      h.backend.sale = sale;
    } else {
      setupServing(sale);
    }
    await expect(h.service.lookup({ saleNumber: SALE_NUMBER })).resolves.toEqual({
      kind: 'refused',
      reason,
    });
    expect(h.audits[0]?.payload).toMatchObject({ sale_id: 'sale-1', sale_ref: SALE_REF, reason });
  });

  it('accepts a sale whose server view has no tenders yet (pre-RT-77)', async () => {
    setup();
    h.backend.sale = omit(saleBody(), 'tenders');
    await expect(h.service.lookup({ saleNumber: SALE_NUMBER })).resolves.toMatchObject({
      kind: 'ok',
    });
  });

  it('is offline when no operator envelope is present (never an unauthenticated call)', async () => {
    setup({ token: null });
    await expect(h.service.lookup({ saleNumber: SALE_NUMBER })).resolves.toMatchObject({
      reason: 'offline',
    });
    expect(h.backend.calls).toHaveLength(0);
  });
});

describe('quote', () => {
  it('AC6: prices exactly by the contract rule, in minor units', async () => {
    setup();
    const res = await h.service.quote({
      saleNumber: SALE_NUMBER,
      lines: [
        { lineRef: LINE_A, quantity: 2 },
        { lineRef: LINE_B, quantity: 1 },
      ],
    });
    expect(res).toEqual({
      kind: 'ok',
      quote: {
        saleRef: SALE_REF,
        currencyCode: 'EGP',
        lines: [
          { lineRef: LINE_A, quantity: 2, amountMinor: 3000 },
          { lineRef: LINE_B, quantity: 1, amountMinor: 2000 },
        ],
        totalMinor: 5000,
      },
    });
  });

  it.each<{ label: string; lineRef: string; quantity: number; reason: ReturnsRefusalReason }>([
    { label: 'zero', lineRef: LINE_A, quantity: 0, reason: 'quantity_out_of_range' },
    {
      label: 'more than returnable',
      lineRef: LINE_A,
      quantity: 4,
      reason: 'quantity_out_of_range',
    },
    { label: 'fractional', lineRef: LINE_A, quantity: 1.5, reason: 'quantity_out_of_range' },
    {
      label: 'a line of another sale',
      lineRef: RETURN_REF,
      quantity: 1,
      reason: 'line_not_returnable',
    },
  ])('AC5: refuses a $label quantity', async ({ lineRef, quantity, reason }) => {
    setup();
    await expect(
      h.service.quote({ saleNumber: SALE_NUMBER, lines: [{ lineRef, quantity }] }),
    ).resolves.toEqual({ kind: 'refused', reason });
  });

  it('honours the server returnableQuantity after an earlier partial return', async () => {
    setupServing(
      saleBody({
        lines: [saleLine({ returnedQuantity: '2.000000', returnableQuantity: '1.000000' })],
      }),
    );
    await expect(
      h.service.quote({ saleNumber: SALE_NUMBER, lines: [{ lineRef: LINE_A, quantity: 2 }] }),
    ).resolves.toMatchObject({ reason: 'quantity_out_of_range' });
    await expect(h.service.quote(ONE_A)).resolves.toMatchObject({ quote: { totalMinor: 1500 } });
  });

  it('refuses amount_not_payable when the contract price is not whole minor units', async () => {
    setupServing(
      saleBody({
        lines: [saleLine({ unitPrice: '3.3300', lineAmount: '10.0000', returnableQuantity: '3' })],
      }),
    );
    await expect(h.service.quote(ONE_A)).resolves.toEqual({
      kind: 'refused',
      reason: 'amount_not_payable',
    });
  });
});

describe('submit', () => {
  it('AC8: journals the return BEFORE the request leaves, with the same key as externalId', async () => {
    setup();
    const seenAtSend: unknown[][] = [];
    h.backend.onReturn = (call, backend) => {
      seenAtSend.push(
        h.db.exec('SELECT state, external_id, request_body_json FROM return_journal')[0]
          ?.values[0] ?? [],
      );
      return backend.recordIdempotently(call);
    };
    const res = await h.service.submit(ONE_A);
    expect(res.kind).toBe('confirmed');
    const [state, externalId, bodyJson] = seenAtSend[0] as [string, string, string];
    const call = h.backend.returnCalls()[0];
    expect(state).toBe('pending');
    expect(externalId).toMatch(/^pos-pulse-return:[0-9a-f-]{36}$/);
    expect(call?.headers['Idempotency-Key']).toBe(externalId);
    expect(call?.headers['Authorization']).toBe('Bearer opaque-operator-envelope');
    expect(call?.url).toBe(`https://backend.example.invalid/api/pos/v1/sales/${SALE_REF}/returns`);
    expect(call?.body).toBe(bodyJson);
    expect(JSON.parse(bodyJson)).toEqual({
      sourceSystem: 'pos-pulse',
      externalId,
      lines: [{ lineRef: LINE_A, quantity: '1' }],
      refundTenders: [{ method: 'cash', amount: '15.00' }],
    });
  });

  it('AC9 / AC11: a 201 confirms, is payout-ready, and audits attempt → confirmed → payout_ready', async () => {
    setup();
    const res = await h.service.submit(ONE_A);
    expect(res).toMatchObject({
      kind: 'confirmed',
      replayed: false,
      ret: {
        state: 'confirmed',
        saleNumber: SALE_NUMBER,
        quotedTotalMinor: 1500,
        returnTotalMinor: 1500,
        returnRef: RETURN_REF,
        lines: [{ lineRef: LINE_A, quantity: 1 }],
      },
    });
    expect(categories(h.audits)).toEqual([
      'sale.return.attempted',
      'sale.return.confirmed',
      'sale.return.payout_ready',
    ]);
    for (const event of h.audits) {
      expect(event).toMatchObject({
        acting_operator_id: 'op-manager',
        originating_terminal_id: 'term-1',
        session_id: 'sess-manager',
      });
      expect(event.payload['sale_ref']).toBe(SALE_REF);
    }
    expect(h.audits[2]?.payload).toMatchObject({ return_ref: RETURN_REF, payout_minor: 1500 });
  });

  it.each<{ status: number; code: string; reason: ReturnsRefusalReason }>([
    { status: 409, code: 'over_return', reason: 'over_return' },
    { status: 409, code: 'already_reversed', reason: 'already_reversed' },
    { status: 409, code: 'conflict', reason: 'conflict' },
    { status: 409, code: 'idempotency_key_conflict', reason: 'conflict' },
    { status: 422, code: 'return_tender_mismatch', reason: 'return_tender_mismatch' },
    { status: 400, code: 'validation_error', reason: 'validation_error' },
    { status: 401, code: 'unauthorized', reason: 'unauthorized' },
    { status: 404, code: 'not_found', reason: 'returns_unavailable' },
  ])(
    'AC10: $status $code is refused ($reason), never success',
    async ({ status, code, reason }) => {
      setup();
      h.backend.onReturn = () => jsonResponse(status, errorBody(code));
      const res = await h.service.submit(ONE_A);
      expect(res).toMatchObject({
        kind: 'refused',
        reason,
        ret: { state: 'refused', refusalReason: reason },
      });
      expect(categories(h.audits)).toEqual(['sale.return.attempted', 'sale.return.refused']);
      expect(h.audits[1]?.payload).toMatchObject({ operation: 'submit', reason });
    },
  );

  it.each<{ label: string; respond: () => Response | Promise<Response> }>([
    {
      label: 'a timeout',
      respond: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    },
    { label: 'a network failure', respond: () => Promise.reject(new TypeError('fetch failed')) },
    { label: 'a 503', respond: () => jsonResponse(503, errorBody('internal_error')) },
    { label: 'a 429', respond: () => jsonResponse(429, errorBody('rate_limited')) },
    {
      label: 'a 201 with an unreadable body',
      respond: () => new Response('<html>', { status: 201 }),
    },
  ])(
    'AC9 / AC10: $label leaves the return unknown — unconfirmed, no payout',
    async ({ respond }) => {
      setup();
      h.backend.onReturn = respond;
      const res = await h.service.submit(ONE_A);
      expect(res).toMatchObject({
        kind: 'unconfirmed',
        ret: { state: 'unknown', returnRef: null },
      });
      expect(categories(h.audits)).toEqual(['sale.return.attempted']);
    },
  );

  it('AC8: refuses a new return while the sale has an unresolved one (no double payout)', async () => {
    setup();
    h.backend.onReturn = () => Promise.reject(new TypeError('fetch failed'));
    await h.service.submit(ONE_A);
    const second = await h.service.submit(ONE_A);
    expect(second).toEqual({ kind: 'refused', reason: 'unresolved_return_exists', ret: null });
    expect(h.backend.returnCalls()).toHaveLength(1);
    expect(journalCount()).toBe(1);
  });

  it('a refusal before journaling writes nothing', async () => {
    setup();
    await h.service.submit({ saleNumber: SALE_NUMBER, lines: [{ lineRef: LINE_A, quantity: 9 }] });
    expect(journalCount()).toBe(0);
    expect(h.backend.returnCalls()).toHaveLength(0);
  });
});

describe('list', () => {
  beforeEach(() => {
    setup();
  });

  it('lists this terminal’s returns newest first, without keys or operator ids', async () => {
    await h.service.submit(ONE_A);
    const res = await h.service.list();
    expect(res).toMatchObject({ kind: 'ok', returns: [{ state: 'confirmed', saleId: 'sale-1' }] });
    const view = res.kind === 'ok' ? res.returns[0] : undefined;
    for (const key of ['externalId', 'operatorId', 'operatorSessionId', 'requestBodyJson']) {
      expect(Object.keys(view ?? {})).not.toContain(key);
    }
  });

  it('is refused for a cashier', async () => {
    h.state.role = 'cashier';
    await expect(h.service.list()).resolves.toEqual({ kind: 'refused', reason: 'role_denied' });
  });
});
