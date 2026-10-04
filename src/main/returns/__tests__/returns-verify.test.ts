/**
 * RT-15 S2 — fail-closed correspondence of trusted server answers (Codex P2
 * on 50b591a + sweep), and the capture → Backend-Core → readSale round trip
 * that proves the snapshot match holds for every real POS sale.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildCapturePayload } from '../../sales-sync/capture-payload.js';
import { toWireBody } from '../../sales-sync/create-sale-sync-client.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { isExpectedSale, returnedLinesMatch } from '../returns-verify.js';
import { readSaleBody, type WireSale } from '../returns-wire.js';
import type { ContractSale, ContractSaleLine } from './__contract__/sales-returns.contract.js';
import {
  LINE_A,
  LINE_B,
  RETURN_REF,
  SALE_NUMBER,
  SALE_REF,
  initReturnsSql,
  jsonResponse,
  returnsHarness,
  saleBody,
  saleLine,
  saleReturnFor,
  seedSyncedSale,
  snapshotFor,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
  await initSalesSyncSql();
});

function wire(sale: ContractSale): WireSale {
  return nn(readSaleBody(sale));
}

const EXPECTED = { saleRef: SALE_REF, linesJson: snapshotFor(saleBody()) };

describe('isExpectedSale (readSale)', () => {
  it.each<[string, ContractSale, boolean]>([
    ['the sale as captured', saleBody(), true],
    ['the saleRef in upper case', saleBody({ saleRef: SALE_REF.toUpperCase() }), true],
    ['lines in another order', saleBody({ lines: [...saleBody().lines].reverse() }), true],
    ['another saleRef', saleBody({ saleRef: RETURN_REF }), false],
    [
      'a line in another currency',
      saleBody({
        lines: [saleLine({ currencyCode: 'USD' }), saleBody().lines[1] as ContractSaleLine],
      }),
      false,
    ],
    [
      'a duplicate lineRef',
      saleBody({
        lines: [
          saleLine(),
          saleLine({
            lineRef: LINE_A,
            lineName: 'Vitamin C',
            unitPrice: '20.0000',
            quantity: '1',
            lineAmount: '20.0000',
          }),
        ],
      }),
      false,
    ],
    ['a missing line', saleBody({ lines: [saleLine()] }), false],
    [
      'an extra line',
      saleBody({ lines: [...saleBody().lines, saleLine({ lineRef: RETURN_REF })] }),
      false,
    ],
    [
      'another line amount',
      saleBody({
        lines: [saleLine({ lineAmount: '44.0000' }), saleBody().lines[1] as ContractSaleLine],
      }),
      false,
    ],
    [
      'another quantity',
      saleBody({ lines: [saleLine({ quantity: '2' }), saleBody().lines[1] as ContractSaleLine] }),
      false,
    ],
    [
      'a fractional quantity',
      saleBody({ lines: [saleLine({ quantity: '3.5' }), saleBody().lines[1] as ContractSaleLine] }),
      false,
    ],
  ])('%s → %s', (_label, sale, expected) => {
    expect(isExpectedSale(wire(sale), EXPECTED)).toBe(expected);
  });

  it.each(['not json', '{}', '[{"quantity":3}]'])(
    'fails closed on an unusable local snapshot (%s)',
    (linesJson) => {
      expect(isExpectedSale(wire(saleBody()), { saleRef: SALE_REF, linesJson })).toBe(false);
    },
  );
});

describe('returnedLinesMatch (recordReturn confirmation)', () => {
  const requested = [
    { lineRef: LINE_A, quantity: 2 },
    { lineRef: LINE_B, quantity: 1 },
  ];
  it.each<[string, { lineRef: string; quantity: string }[], boolean]>([
    [
      'the requested lines',
      [
        { lineRef: LINE_A, quantity: '2.000000' },
        { lineRef: LINE_B, quantity: '1' },
      ],
      true,
    ],
    ['a subset', [{ lineRef: LINE_A.toUpperCase(), quantity: '2' }], true],
    ['a foreign line', [{ lineRef: RETURN_REF, quantity: '1' }], false],
    ['another quantity', [{ lineRef: LINE_A, quantity: '1' }], false],
    [
      'a duplicate line',
      [
        { lineRef: LINE_A, quantity: '2' },
        { lineRef: LINE_A, quantity: '2' },
      ],
      false,
    ],
  ])('%s → %s', (_label, returned, expected) => {
    expect(returnedLinesMatch(requested, returned)).toBe(expected);
  });
});

describe('service / dispatch fail closed on a mismatched answer', () => {
  let h: ReturnsHarness;
  afterEach(() => {
    h.close();
  });

  it('readSale answering another saleRef → sale_mismatch, no lines exposed', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    h.backend.sale = saleBody({ saleRef: RETURN_REF });
    await expect(h.service.lookup({ saleNumber: SALE_NUMBER })).resolves.toEqual({
      kind: 'refused',
      reason: 'sale_mismatch',
    });
  });

  it.each<
    [
      string,
      (lines: { lineRef: string; quantity: string }[]) => { lineRef: string; quantity: string }[],
    ]
  >([
    ['a foreign line', () => [{ lineRef: LINE_B, quantity: '1.000000' }]],
    ['another quantity', () => [{ lineRef: LINE_A, quantity: '2.000000' }]],
  ])('a confirmation returning %s is not trusted', async (_label, tamper) => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    h.backend.onReturn = (call) => {
      const body = saleReturnFor(JSON.parse(call.body ?? '{}') as never);
      return jsonResponse(201, {
        ...body,
        lines: tamper(body.lines).map((l) => ({ ...body.lines[0], ...l })),
      });
    };
    const res = await h.service.submit({
      saleNumber: SALE_NUMBER,
      lines: [{ lineRef: LINE_A, quantity: 1 }],
    });
    expect(res).toMatchObject({ kind: 'unconfirmed', ret: { state: 'unknown' } });
    expect(h.warnings).toContain('returns:confirmation_mismatch');
  });
});

/** Postgres `numeric(19,scale)::text` of an exact decimal string. */
function pgNumericText(value: string, scale: number): string {
  const [int = '0', frac = ''] = value.split('.');
  return `${int}.${frac.padEnd(scale, '0')}`;
}

describe('round trip: POS capture → Backend-Core sale_lines → readSale', () => {
  it('a sale built by the real capture builder passes readSale validation', () => {
    const db = freshSalesSyncDb();
    try {
      const linesJson = JSON.stringify([
        {
          line_id: 'l-1',
          item_ref: 'p-1',
          display_name: 'Zinc',
          quantity: 2,
          unit_price_minor: 1250,
          line_subtotal_minor: 2500,
        },
        {
          line_id: 'l-2',
          item_ref: 'p-2',
          display_name: 'Aspirin',
          quantity: 1,
          unit_price_minor: 5,
          line_subtotal_minor: 5,
        },
        {
          line_id: 'l-3',
          item_ref: 'p-3',
          display_name: 'Aspirin',
          quantity: 3,
          unit_price_minor: 1999,
          line_subtotal_minor: 5997,
        },
      ]);
      seedSale(db, { sale_id: 'rt-1', lines_json: linesJson, subtotal_minor: 8502 });
      const row = nn(bindSalesRepository(handleFor(db)).readById('rt-1'));
      const body = toWireBody(buildCapturePayload(row), 'EGP');

      // As Backend-Core persists and serves it (sales.service.ts:342-364, :451-462,
      // :773-784): one sale_lines row per request line, values verbatim in
      // numeric(19,4)/(19,6), served as numeric text, ORDER BY line_name.
      const served: ContractSaleLine[] = body.lines
        .map((l, i) => ({
          lineRef: `0190f5a2-7b3c-7d4e-8f90-${String(i).padStart(12, '0')}`,
          lineName: l.lineName,
          unitPrice: pgNumericText(l.unitPrice, 4),
          currencyCode: l.currencyCode,
          quantity: pgNumericText(l.quantity, 6),
          lineAmount: pgNumericText(l.lineAmount, 4),
          taxAmount: null,
          unit: l.unit,
          tenantProductRef: null,
          returnedQuantity: '0',
          returnableQuantity: pgNumericText(l.quantity, 6),
        }))
        .sort((a, b) => a.lineName.localeCompare(b.lineName));
      const sale = saleBody({ posTotal: pgNumericText(body.posTotal, 4), lines: served });

      expect(isExpectedSale(wire(sale), { saleRef: SALE_REF, linesJson: row.lines_json })).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });
});
