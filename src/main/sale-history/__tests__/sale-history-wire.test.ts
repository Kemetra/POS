import { describe, expect, it } from 'vitest';

import {
  isServerCursor,
  readHistoryDetail,
  readHistoryPage,
  readReprintBody,
} from '../sale-history-wire.js';
import {
  CASHIER_USER,
  SALE_REF,
  wireDetail,
  wireItem,
  wireLine,
  wirePage,
  wireReprint,
  wireReturn,
} from './__helpers__/wire-fixtures.js';

describe('RT-542 readHistoryPage', () => {
  it('maps a contract page to the bridge view, money in EGP minor units', () => {
    const page = readHistoryPage(wirePage({ nextCursor: 'abc_DEF-123' }));
    expect(page).not.toBeNull();
    expect(page?.rows[0]).toEqual({
      sale_ref: SALE_REF,
      sale_number: 'T1-20261016-0001',
      business_day: '2026-10-16',
      occurred_at: '2026-10-16T08:00:00.000Z',
      received_at: '2026-10-16T08:00:05.000Z',
      device_label: 'Till 1',
      device_label_source: 'snapshot',
      operator_display_name: 'Mona',
      operator_name_source: 'snapshot',
      total_minor: 2550,
      sync_status: 'synced',
      voided: false,
      return_state: 'none',
      erp_state: 'posted',
    });
    expect(page?.operator_refs).toEqual([CASHIER_USER]);
    expect(page?.store_timezone).toBe('Africa/Cairo');
    expect(page?.next_cursor).toBe('abc_DEF-123');
    expect(page?.visibility).toBe('store');
  });

  it('keeps legacy nulls as null (pre-RT-77 device, no snapshot name)', () => {
    const page = readHistoryPage(
      wirePage({
        items: [
          wireItem({
            saleNumber: null,
            device: { deviceRef: null, label: null, labelSource: 'unavailable' },
            operator: { userRef: null, displayName: null, nameSource: 'unavailable' },
          }),
        ],
      }),
    );
    expect(page?.rows[0]?.sale_number).toBeNull();
    expect(page?.rows[0]?.device_label_source).toBe('unavailable');
    expect(page?.operator_refs).toEqual([null]);
  });

  it.each([
    ['a float-ish total', { posTotal: 25.5 }],
    ['a sub-minor total', { posTotal: '25.505' }],
    ['a negative total', { posTotal: '-1.00' }],
    ['another currency', { currencyCode: 'USD' }],
    ['an unknown ERP state', { erpPostingState: 'fiscalised' }],
    ['a non-uuid saleRef', { saleRef: 'not-a-uuid' }],
    ['a bad business date', { businessDate: '16/10/2026' }],
  ])('refuses the whole page for %s', (_label, overrides) => {
    expect(readHistoryPage(wirePage({ items: [wireItem(overrides)] }))).toBeNull();
  });

  it('refuses a cursor Backend-Core could not have issued', () => {
    expect(readHistoryPage(wirePage({ nextCursor: 'a|b' }))).toBeNull();
  });

  it('refuses more than 100 items and a non-object body', () => {
    const items = Array.from({ length: 101 }, () => wireItem());
    expect(readHistoryPage(wirePage({ items }))).toBeNull();
    expect(readHistoryPage(undefined)).toBeNull();
    expect(readHistoryPage([])).toBeNull();
  });
});

describe('RT-542 readHistoryDetail', () => {
  it('maps lines, tenders, change, header, ERP and eligibility', () => {
    expect(readHistoryDetail(wireDetail())).toMatchObject({
      operator_ref: CASHIER_USER,
      detail: {
        lines: [
          {
            line_ref: '0190a3c4-0000-4000-8000-0000000000e1',
            sequence: 1,
            name: 'Panadol 500mg',
            unit_price_minor: 1275,
            quantity: '2',
            line_minor: 2550,
            tax_minor: 0,
            unit: 'box',
            returned_quantity: '0',
          },
        ],
        tenders: [{ method: 'cash', amount_minor: 2550, reference: null, sequence: 1 }],
        change_minor: 450,
        receipt_header: { branch_name: 'Rahma Pharmacy' },
        erp: {
          sale: 'posted',
          sale_document_ref: 'ACC-SINV-0001',
          reversal: null,
          reversal_document_ref: null,
        },
        reprint: { duplicate: 'allowed', marks: [] },
      },
    });
  });

  it('keeps an unrecorded legacy sale honest (nulls, not_recorded, unknown)', () => {
    const parsed = readHistoryDetail(
      wireDetail({
        lines: [wireLine({ sequence: null })],
        lineOrder: 'not_recorded',
        tenderState: 'unknown',
        tenders: [],
        changeGiven: null,
        settledAt: null,
        receiptNumber: null,
        receiptHeader: null,
        erpPosting: {
          sale: 'unknown',
          saleDocumentRef: null,
          reversal: null,
          reversalDocumentRef: null,
        },
        receiptFacts: 'partial',
        reprint: { duplicate: 'unavailable_incomplete', saleRecord: 'allowed', marks: [] },
      }),
    );
    expect(parsed?.detail.receipt_header).toBeNull();
    expect(parsed?.detail.change_minor).toBeNull();
    expect(parsed?.detail.erp.sale).toBe('unknown');
    expect(parsed?.detail.reprint.duplicate).toBe('unavailable_incomplete');
  });

  it('maps a void summary and returns', () => {
    const parsed = readHistoryDetail(
      wireDetail({
        void: {
          voidedAt: '2026-10-16T12:00:00.000Z',
          voidBusinessDate: '2026-10-16',
          approved: true,
          approverRole: 'store_manager',
        },
        returns: [wireReturn()],
        reprint: {
          duplicate: 'unavailable_voided',
          saleRecord: 'allowed',
          marks: ['voided', 'returned'],
        },
      }),
    );
    expect(parsed?.detail.void?.approver_role).toBe('store_manager');
    expect(parsed?.detail.returns[0]?.total_minor).toBe(1275);
    expect(parsed?.detail.reprint.marks).toEqual(['voided', 'returned']);
  });

  it.each([
    ['a missing reprint block', { reprint: undefined }],
    [
      'a sale record that is not allowed',
      { reprint: { duplicate: 'allowed', saleRecord: 'no', marks: [] } },
    ],
    [
      'an unknown mark',
      { reprint: { duplicate: 'allowed', saleRecord: 'allowed', marks: ['paid'] } },
    ],
    ['a bad line amount', { lines: [wireLine({ lineAmount: '1e3' })] }],
    ['a bad quantity', { lines: [wireLine({ quantity: '-2' })] }],
    ['a zero sequence', { lines: [wireLine({ sequence: 0 })] }],
  ])('refuses the detail for %s', (_label, overrides) => {
    expect(readHistoryDetail(wireDetail(overrides))).toBeNull();
  });
});

describe('RT-542 readReprintBody', () => {
  it('maps a SaleReprint', () => {
    expect(readReprintBody(wireReprint({ marks: ['returned'] }))).toEqual({
      reprint_ref: '0190a3c4-0000-4000-8000-0000000000a1',
      sale_ref: SALE_REF,
      mode: 'authorize',
      kind: 'duplicate',
      marks: ['returned'],
      copy_number: 2,
      recorded_at: '2026-10-16T11:00:00.000Z',
    });
  });

  it.each([
    ['a zero copy number', { copyNumber: 0 }],
    ['a fractional copy number', { copyNumber: 1.5 }],
    ['an unknown kind', { kind: 'original' }],
  ])('refuses %s', (_label, overrides) => {
    expect(readReprintBody(wireReprint(overrides))).toBeNull();
  });
});

describe('RT-542 isServerCursor', () => {
  it('accepts the contract charset only', () => {
    expect(isServerCursor('Abc_09-z')).toBe(true);
    expect(isServerCursor('')).toBe(false);
    expect(isServerCursor('a.b')).toBe(false);
    expect(isServerCursor('x'.repeat(513))).toBe(false);
  });
});

describe('RT-542 review fixes — display-only values', () => {
  it('rounds fractional return and tax amounts to the piastre instead of blanking the detail', () => {
    const parsed = readHistoryDetail(
      wireDetail({
        lines: [wireLine({ taxAmount: '1.005' })],
        returns: [
          wireReturn({
            returnTotal: '3.3333',
            lines: [
              {
                lineRef: '0190a3c4-0000-4000-8000-0000000000e1',
                quantity: '1',
                lineAmount: '3.3333',
              },
            ],
          }),
        ],
      }),
    );
    expect(parsed?.detail.lines[0]?.tax_minor).toBe(101);
    expect(parsed?.detail.returns[0]?.total_minor).toBe(333);
    expect(parsed?.detail.returns[0]?.lines[0]?.line_minor).toBe(333);
  });

  it('keeps sale money exact: a fractional line amount is still off-contract', () => {
    expect(
      readHistoryDetail(wireDetail({ lines: [wireLine({ lineAmount: '25.505' })] })),
    ).toBeNull();
  });

  it('normalizes quantities and strips format characters from shown text', () => {
    const parsed = readHistoryDetail(
      wireDetail(
        {
          lines: [
            wireLine({
              quantity: '2.000000',
              returnedQuantity: '1.500',
              lineName: 'Pana\u200Fdol\uFEFF',
            }),
          ],
        },
        { saleNumber: 'T1\u200E-0001' },
      ),
    );
    expect(parsed?.detail.lines[0]?.quantity).toBe('2');
    expect(parsed?.detail.lines[0]?.returned_quantity).toBe('1.5');
    expect(parsed?.detail.lines[0]?.name).toBe('Panadol');
    expect(parsed?.detail.summary.sale_number).toBe('T1-0001');
  });

  it('bounds the detail arrays', () => {
    expect(
      readHistoryDetail(wireDetail({ lines: Array.from({ length: 501 }, () => wireLine()) })),
    ).toBeNull();
  });
});
