/**
 * RT-15 S2 — small pure units: UUIDv7 / externalId, the lenient wire readers
 * (D-g), returnability and request building, journal views, and the local
 * tender read (D-c).
 */
import { describe, expect, it } from 'vitest';

import { buildRecordReturnBody, assessSale, quoteReturn, viewLines } from '../returns-quote.js';
import {
  cashOnlyVerdict,
  localTenderEvidence,
  serverTenderEvidence,
  type TenderEvidence,
} from '../returns-tender.js';
import { toJournalView } from '../returns-views.js';
import { parseJsonBody, readErrorCode, readSaleBody, readSaleReturnBody } from '../returns-wire.js';
import { newReturnExternalId, uuidv7 } from '../uuidv7.js';
import type { JournalEntry } from '../returns-repository.js';
import {
  LOCAL_RETURN_REFUSALS,
  RETURN_STATES,
  SERVER_RETURN_REFUSALS,
} from '../../../shared/returns/types.js';
import { LINE_A, SALE_REF, SCOPE, saleBody, saleLine } from './__helpers__/returns-fixture.js';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function wire(overrides: Parameters<typeof saleBody>[0] = {}) {
  const parsed = readSaleBody(saleBody(overrides));
  if (parsed === null) throw new Error('fixture sale must parse');
  return parsed;
}

describe('uuidv7 / newReturnExternalId', () => {
  it('encodes the millisecond clock big-endian with version 7 and the RFC variant', () => {
    const id = uuidv7({ now: () => 0x0190f5a27b3c, random: (n) => new Uint8Array(n).fill(0xff) });
    expect(id).toBe('0190f5a2-7b3c-7fff-bfff-ffffffffffff');
  });

  it('is time-ordered and unique with the real sources', () => {
    const ids = Array.from({ length: 50 }, () => uuidv7());
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(id).toMatch(V7);
  });

  it('builds the 53-character pos-pulse-return:<uuidv7> key (16..128 printable, RT-181)', () => {
    const key = newReturnExternalId();
    expect(key).toMatch(/^pos-pulse-return:/);
    expect(key).toHaveLength(53);
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
  });

  it('clamps a negative clock to the epoch', () => {
    expect(uuidv7({ now: () => -5, random: (n) => new Uint8Array(n) })).toMatch(
      /^00000000-0000-7000-8000-000000000000$/,
    );
  });
});

describe('lenient wire readers (D-g)', () => {
  it('reads the needed Sale fields and ignores unknown keys', () => {
    const body = { ...saleBody(), futureField: { nested: true } };
    expect(readSaleBody(body)).toMatchObject({
      saleRef: SALE_REF,
      currencyCode: 'EGP',
      voided: false,
      tenders: [{ method: 'cash' }],
    });
  });

  it.each<[string, unknown]>([
    ['not json', '{'],
    ['an array', []],
    ['a missing voided', { ...saleBody(), voided: undefined }],
    ['a non-uuid saleRef', { ...saleBody(), saleRef: 'abc' }],
    ['a lowercase currency', { ...saleBody(), currencyCode: 'egp' }],
    ['a malformed line', { ...saleBody(), lines: [{ lineRef: LINE_A }] }],
    ['tenders that are not an array', { ...saleBody(), tenders: 'cash' }],
    ['lines that are not an array', { ...saleBody(), lines: {} }],
  ])('rejects a Sale body with %s', (_label, body) => {
    expect(readSaleBody(typeof body === 'string' ? parseJsonBody(body) : body)).toBeNull();
  });

  it('reads a SaleReturn and the Error code; rejects a malformed return', () => {
    expect(
      readSaleReturnBody({
        returnRef: SALE_REF,
        saleRef: SALE_REF,
        externalId: 'x',
        currencyCode: 'EGP',
        returnTotal: '1.0000',
        recordedAt: 't',
        lines: [{ lineRef: LINE_A, quantity: '1.000000' }],
        extra: 1,
      }),
    ).toMatchObject({ returnTotal: '1.0000' });
    expect(readSaleReturnBody({ returnRef: SALE_REF })).toBeNull();
    expect(readErrorCode({ error: { code: 'over_return', message: 'm' } })).toBe('over_return');
    expect(readErrorCode(parseJsonBody('<html>'))).toBeNull();
    expect(readErrorCode({ message: 'nest default' })).toBeNull();
  });
});

describe('returnability and quoting', () => {
  it('treats a line with an unreadable quantity as not returnable', () => {
    const sale = wire({ lines: [saleLine({ returnableQuantity: '1.5' })] });
    expect(assessSale(sale)).toBe('nothing_returnable');
    expect(viewLines(sale)[0]).toMatchObject({ soldQuantity: 0, returnableQuantity: 0 });
    expect(quoteReturn(sale, [{ lineRef: LINE_A, quantity: 1 }])).toEqual({
      kind: 'refused',
      reason: 'line_not_returnable',
    });
  });

  it('treats a zero-quantity sold line as not returnable', () => {
    const sale = wire({ lines: [saleLine({ quantity: '0', returnableQuantity: '0' })] });
    expect(assessSale(sale)).toBe('nothing_returnable');
  });

  it('shows a null unit price when it is not whole minor units', () => {
    expect(viewLines(wire({ lines: [saleLine({ unitPrice: '3.3333' })] }))[0]?.unitPriceMinor).toBe(
      null,
    );
    expect(viewLines(wire({ lines: [saleLine({ unitPrice: 'n/a' })] }))[0]?.unitPriceMinor).toBe(
      null,
    );
  });

  it('refuses locally when returned + q would exceed the sold quantity (P2-3)', () => {
    // An inconsistent server view: 2 of 3 already returned, yet 3 "returnable".
    const sale = wire({ lines: [saleLine({ returnedQuantity: '2', returnableQuantity: '3' })] });
    expect(quoteReturn(sale, [{ lineRef: LINE_A, quantity: 2 }])).toEqual({
      kind: 'refused',
      reason: 'quantity_out_of_range',
    });
    expect(quoteReturn(sale, [{ lineRef: LINE_A, quantity: 1 }])).toMatchObject({ kind: 'ok' });
  });

  it('matches line refs case-insensitively', () => {
    const quoted = quoteReturn(wire(), [{ lineRef: LINE_A.toUpperCase(), quantity: 1 }]);
    expect(quoted).toMatchObject({ kind: 'ok', quote: { totalMinor: 1500 } });
  });

  it('prices a full return of a pre-RT-105 line back to its exact lineAmount', () => {
    const sale = wire({ lines: [saleLine({ lineAmount: '10.0000' })] });
    expect(quoteReturn(sale, [{ lineRef: LINE_A, quantity: 3 }])).toMatchObject({
      quote: { totalMinor: 1000 },
    });
  });

  it('refuses amount_not_payable when the total is past the safe-integer range', () => {
    const big = { quantity: '1', returnableQuantity: '1', lineAmount: '50000000000000.0000' };
    const sale = wire({
      lines: [saleLine(big), saleLine({ ...big, lineRef: SALE_REF })],
    });
    const lines = [
      { lineRef: LINE_A, quantity: 1 },
      { lineRef: SALE_REF, quantity: 1 },
    ];
    expect(quoteReturn(sale, lines)).toEqual({ kind: 'refused', reason: 'amount_not_payable' });
  });

  it('builds the cash-only RecordReturnRequest at the currency exponent', () => {
    expect(
      buildRecordReturnBody('pos-pulse-return:k', {
        saleRef: SALE_REF,
        currencyCode: 'JPY',
        lines: [{ lineRef: LINE_A, quantity: 2, amountMinor: 300 }],
        totalMinor: 300,
      }),
    ).toEqual({
      sourceSystem: 'pos-pulse',
      externalId: 'pos-pulse-return:k',
      lines: [{ lineRef: LINE_A, quantity: '2' }],
      refundTenders: [{ method: 'cash', amount: '300' }],
    });
  });
});

function viewEntry(): JournalEntry {
  return {
    returnId: 'r1',
    scope: SCOPE,
    saleId: 's1',
    saleNumber: 'SN-1',
    serverSaleRef: SALE_REF,
    externalId: 'pos-pulse-return:secret-ish',
    operatorId: 'op',
    operatorSessionId: 'sess',
    currencyCode: 'EGP',
    quotedTotalMinor: 100,
    requestBodyJson: '{}',
    lines: [{ lineRef: LINE_A, quantity: 1 }],
    state: 'pending',
    returnRef: null,
    returnTotalMinor: null,
    refusalReason: null,
    attemptCount: 0,
    lastAttemptAt: null,
    createdAt: 't0',
    confirmedAt: null,
  };
}

describe('D-c tender evidence (Codex P1: fail closed on tender-unknown)', () => {
  it.each<[string, TenderEvidence]>([
    [JSON.stringify([{ tender_type: 'cash' }]), 'cash'],
    [JSON.stringify([{ tender_type: 'cash' }, { tender_type: 'cash' }]), 'cash'],
    ['[]', 'none'],
    [
      JSON.stringify([{ tender_type: 'cash' }, { tender_type: 'external_card_terminal' }]),
      'non_cash',
    ],
    [JSON.stringify([{ tender_type: 'internal_voucher' }]), 'non_cash'],
    [JSON.stringify([null]), 'non_cash'],
    [JSON.stringify({ tender_type: 'cash' }), 'non_cash'],
    ['not json', 'non_cash'],
  ])('local summary %s → %s', (json, expected) => {
    expect(localTenderEvidence({ tender_lines_summary_json: json })).toBe(expected);
  });

  it.each<[string, { method: string }[] | undefined, TenderEvidence]>([
    ['absent (pre-RT-77)', undefined, 'none'],
    ['empty (tender-unknown capture)', [], 'none'],
    ['all cash', [{ method: 'cash' }], 'cash'],
    ['a card', [{ method: 'cash' }, { method: 'card_external' }], 'non_cash'],
  ])('server tenders %s → %s', (_label, tenders, expected) => {
    expect(serverTenderEvidence(tenders === undefined ? {} : { tenders })).toBe(expected);
  });

  it.each<[TenderEvidence, TenderEvidence, string | null]>([
    ['none', 'none', 'tender_unknown'],
    ['none', 'cash', null],
    ['cash', 'none', null],
    ['cash', 'cash', null],
    ['cash', 'non_cash', 'card_tender_blocked'],
    ['non_cash', 'cash', 'card_tender_blocked'],
    ['none', 'non_cash', 'card_tender_blocked'],
  ])('verdict local %s + server %s → %s', (local, server, expected) => {
    expect(cashOnlyVerdict([local, server])).toBe(expected);
  });

  it('projects a journal entry without keys, operator ids or the request', () => {
    const entry = viewEntry();
    expect(toJournalView(entry)).toEqual({
      returnId: 'r1',
      saleId: 's1',
      saleNumber: 'SN-1',
      state: 'pending',
      currencyCode: 'EGP',
      quotedTotalMinor: 100,
      returnTotalMinor: null,
      returnRef: null,
      refusalReason: null,
      createdAt: 't0',
      confirmedAt: null,
      lines: [{ lineRef: LINE_A, quantity: 1 }],
      payout: null,
    });
  });

  it('projects a started or completed payout as when and how, never who (RT-15 S4)', () => {
    const entry = { ...viewEntry(), state: 'paid_out' as const };
    const payout = {
      returnId: 'r1',
      startedOperatorId: 'op-starter',
      startedSessionId: 'sess-starter',
      startedAt: 't2',
      paidOperatorId: 'op-payer',
      paidOperatorName: 'Mona',
      paidSessionId: 'sess-payer',
      paidAt: 't3',
      method: 'manual' as const,
      kickOutcome: 'opened' as const,
      kickCount: 1,
      kickedAt: 't2',
    };
    const view = toJournalView(entry, payout);
    expect(view.payout).toEqual({
      startedAt: 't2',
      paidAt: 't3',
      method: 'manual',
      kick: 'opened',
    });
    expect(JSON.stringify(view)).not.toMatch(/op-starter|sess-starter|op-payer|sess-payer|Mona/);
  });

  it.each<[string | null, string]>([
    [null, 'none'],
    ['sending', 'unknown'],
    ['failed_before_send', 'failed_before_send'],
    ['unknown', 'unknown'],
  ])('P1: a kick record %s is shown as %s (a crash mid-kick may have opened it)', (kick, shown) => {
    const payout = {
      returnId: 'r1',
      startedOperatorId: 'op',
      startedSessionId: 'sess',
      startedAt: 't2',
      paidOperatorId: null,
      paidOperatorName: null,
      paidSessionId: null,
      paidAt: null,
      method: null,
      kickOutcome: kick as 'sending' | null,
      kickCount: kick === null ? 0 : 1,
      kickedAt: kick === null ? null : 't2',
    };
    expect(toJournalView(viewEntry(), payout).payout?.kick).toBe(shown);
  });
});

describe('shared closed sets', () => {
  it('keeps the journal states and the server / local refusals distinct', () => {
    expect(RETURN_STATES).toEqual(['pending', 'confirmed', 'paid_out', 'refused', 'unknown']);
    const all = [...SERVER_RETURN_REFUSALS, ...LOCAL_RETURN_REFUSALS];
    expect(new Set(all).size).toBe(all.length);
    expect(SERVER_RETURN_REFUSALS).toEqual(
      expect.arrayContaining([
        'over_return',
        'already_reversed',
        'conflict',
        'return_tender_mismatch',
      ]),
    );
  });
});
