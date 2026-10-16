/**
 * RT-542 test fixtures: contract-shaped Backend-Core sale-history bodies
 * (`sale-history.yaml`). Each builder returns a fresh, valid body; tests
 * override fields to make it off-contract.
 */

export const SALE_REF = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b';
export const OTHER_SALE_REF = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6c';
export const CASHIER_USER = '0190a3c4-0000-4000-8000-0000000000c1';
export const OTHER_USER = '0190a3c4-0000-4000-8000-0000000000c2';
export const DEVICE_REF = '0190a3c4-0000-4000-8000-0000000000d1';
export const LINE_REF = '0190a3c4-0000-4000-8000-0000000000e1';
export const RETURN_REF = '0190a3c4-0000-4000-8000-0000000000f1';
export const REPRINT_REF = '0190a3c4-0000-4000-8000-0000000000a1';

type Body = Record<string, unknown>;

export function wireItem(overrides: Body = {}): Body {
  return {
    saleRef: SALE_REF,
    saleNumber: 'T1-20261016-0001',
    businessDate: '2026-10-16',
    occurredAt: '2026-10-16T08:00:00.000Z',
    receivedAt: '2026-10-16T08:00:05.000Z',
    device: { deviceRef: DEVICE_REF, label: 'Till 1', labelSource: 'snapshot' },
    operator: { userRef: CASHIER_USER, displayName: 'Mona', nameSource: 'snapshot' },
    currencyCode: 'EGP',
    posTotal: '25.50',
    syncStatus: 'synced',
    voided: false,
    returnState: 'none',
    erpPostingState: 'posted',
    ...overrides,
  };
}

export function wirePage(overrides: Body = {}): Body {
  return {
    items: [wireItem()],
    nextCursor: null,
    asOf: '2026-10-16T09:00:00.000Z',
    storeTimezone: 'Africa/Cairo',
    visibility: 'store',
    from: '2026-10-01',
    to: '2026-10-16',
    ...overrides,
  };
}

export function wireLine(overrides: Body = {}): Body {
  return {
    lineRef: LINE_REF,
    sequence: 1,
    lineName: 'Panadol 500mg',
    unitPrice: '12.75',
    currencyCode: 'EGP',
    quantity: '2',
    lineAmount: '25.50',
    taxAmount: '0.00',
    unit: 'box',
    returnedQuantity: '0',
    ...overrides,
  };
}

export function wireDetail(overrides: Body = {}, summary: Body = {}): Body {
  return {
    summary: wireItem(summary),
    lines: [wireLine()],
    lineOrder: 'recorded',
    tenderState: 'recorded',
    tenders: [{ method: 'cash', amount: '25.50', reference: null, sequence: 1 }],
    changeGiven: '4.50',
    settledAt: '2026-10-16T07:59:58.000Z',
    receiptNumber: 'T1-20261016-0001',
    receiptHeader: {
      branchName: 'Rahma Pharmacy',
      branchAddress: '1 Nile St, Cairo',
      taxRegistrationId: '123-456-789',
    },
    void: null,
    returns: [],
    erpPosting: {
      sale: 'posted',
      saleDocumentRef: 'ACC-SINV-0001',
      reversal: null,
      reversalDocumentRef: null,
    },
    receiptFacts: 'complete',
    reprint: { duplicate: 'allowed', saleRecord: 'allowed', marks: [] },
    ...overrides,
  };
}

export function wireReturn(overrides: Body = {}): Body {
  return {
    returnRef: RETURN_REF,
    recordedAt: '2026-10-16T10:00:00.000Z',
    businessDate: '2026-10-16',
    returnTotal: '12.75',
    lines: [{ lineRef: LINE_REF, quantity: '1', lineAmount: '12.75' }],
    ...overrides,
  };
}

export function wireReprint(overrides: Body = {}): Body {
  return {
    reprintRef: REPRINT_REF,
    saleRef: SALE_REF,
    mode: 'authorize',
    kind: 'duplicate',
    marks: [],
    copyNumber: 2,
    recordedAt: '2026-10-16T11:00:00.000Z',
    ...overrides,
  };
}
