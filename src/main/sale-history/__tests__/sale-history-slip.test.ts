/** RT-542 — the pure slip builders: duplicate fidelity and sale-record labels. */
import { describe, expect, it } from 'vitest';

import type { Band } from '../../receipts/template-engine.js';
import type { SaleRow } from '../../sales/repositories/sales.repository.js';
import type { ReceiptPayload } from '../../../shared/receipts/types.js';
import { format as formatMoney, of as moneyOf } from '../../../shared/money.js';
import type { SaleHistoryDetail, SaleHistoryRow } from '../../../shared/sale-history/types.js';
import {
  duplicateBands,
  duplicateFromDetail,
  duplicateFromLocal,
  saleRecordBands,
  type SlipContext,
} from '../sale-history-slip.js';
import { localSaleRow } from './__helpers__/service-fixtures.js';

const AT = '2026-10-16T09:00:00.000Z';
// A right-to-left override and a bell: server text the printer must never see.
const RLO = String.fromCodePoint(0x202e);
const BEL = String.fromCodePoint(0x07);

function row(over: Partial<SaleHistoryRow> = {}): SaleHistoryRow {
  return {
    sale_ref: '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b',
    sale_number: 'T1-20261016-0001',
    business_day: '2026-10-16',
    occurred_at: '2026-10-16T07:00:00.000Z',
    received_at: '2026-10-16T07:00:05.000Z',
    device_label: 'Till 2',
    device_label_source: 'snapshot',
    operator_display_name: 'Mona',
    operator_name_source: 'snapshot',
    total_minor: 1500,
    sync_status: 'synced',
    voided: false,
    return_state: 'none',
    erp_state: 'posted',
    local_sale_id: null,
    ...over,
  };
}

function detail(over: Partial<SaleHistoryDetail> = {}): SaleHistoryDetail {
  return {
    summary: row(),
    lines: [
      {
        line_ref: 'l1',
        sequence: 1,
        name: 'Panadol',
        unit_price_minor: 1500,
        quantity: '1',
        line_minor: 1500,
        tax_minor: 0,
        unit: 'box',
        returned_quantity: '0',
      },
    ],
    line_order: 'recorded',
    tender_state: 'recorded',
    // Backend-Core records the cash tender net of change: 20 handed over, 5 back.
    tenders: [{ method: 'cash', amount_minor: 1500, reference: null, sequence: 1 }],
    change_minor: 500,
    settled_at: '2026-10-16T07:00:00.000Z',
    receipt_number: 'T1-20261016-0001',
    receipt_header: { branch_name: 'Branch', branch_address: 'Addr', tax_registration_id: 'TRN' },
    void: null,
    returns: [],
    erp: { sale: 'posted', sale_document_ref: 'D-1', reversal: null, reversal_document_ref: null },
    receipt_facts: 'complete',
    reprint: { duplicate: 'allowed', marks: [] },
    ...over,
  };
}

function ctx(over: Partial<SlipContext> = {}): SlipContext {
  return { detail: detail(), copyNumber: 2, marks: [], printedAt: AT, ...over };
}

function texts(bands: readonly Band[]): string[] {
  return bands.flatMap((band) => (band.kind === 'text' ? [band.text] : []));
}

const egp = (minor: number): string => formatMoney(moneyOf(minor, 'EGP'));

/** The fixture with its one line changed. */
function withLine(over: Partial<SaleHistoryDetail['lines'][number]>): SaleHistoryDetail {
  const base = detail();
  return { ...base, lines: base.lines.map((line) => ({ ...line, ...over })) };
}

/** The fixture's duplicate (the fixture records every receipt fact). */
function duplicate(): ReceiptPayload {
  const payload = duplicateFromDetail(detail(), 2, AT);
  if (payload === null) throw new Error('the fixture builds a duplicate');
  return payload;
}

describe('RT-542 duplicateFromDetail — tenders as the receipt printed them', () => {
  it('puts the change back on the cash tender: the cash handed over, not the net', () => {
    const payload = duplicateFromDetail(detail(), 2, AT);
    expect(payload?.tender_lines_summary).toEqual([
      { tender_type: 'cash', amount_applied_minor: 2000, change_due_minor: 500 },
    ]);
    expect(payload?.total_change_due_minor).toBe(500);
  });

  it('carries the change on the last cash tender only, in recorded order', () => {
    const payload = duplicateFromDetail(
      detail({
        tenders: [
          { method: 'cash', amount_minor: 300, reference: null, sequence: 3 },
          { method: 'card_external', amount_minor: 700, reference: `RRN${RLO}1`, sequence: 1 },
          { method: 'cash', amount_minor: 500, reference: null, sequence: 2 },
        ],
      }),
      2,
      AT,
    );
    expect(payload?.tender_lines_summary).toEqual([
      {
        tender_type: 'external_card_terminal',
        amount_applied_minor: 700,
        external_reference: 'RRN1',
      },
      { tender_type: 'cash', amount_applied_minor: 500 },
      { tender_type: 'cash', amount_applied_minor: 800, change_due_minor: 500 },
    ]);
  });

  it('builds no duplicate when change was given but no cash tender can carry it', () => {
    const card = detail({
      tenders: [{ method: 'card_external', amount_minor: 1500, reference: null, sequence: 1 }],
    });
    expect(duplicateFromDetail(card, 2, AT)).toBeNull();
    expect(duplicateFromDetail({ ...card, change_minor: 0 }, 2, AT)).not.toBeNull();
  });

  it('builds no duplicate when a receipt fact is missing', () => {
    expect(duplicateFromDetail(detail({ receipt_facts: 'partial' }), 2, AT)).toBeNull();
    expect(duplicateFromDetail(detail({ receipt_header: null }), 2, AT)).toBeNull();
    expect(duplicateFromDetail(detail({ receipt_number: null }), 2, AT)).toBeNull();
    expect(
      duplicateFromDetail(detail({ summary: row({ operator_name_source: 'current' }) }), 2, AT),
    ).toBeNull();
    expect(duplicateFromDetail(withLine({ quantity: '1.5' }), 2, AT)).toBeNull();
    expect(duplicateFromDetail(withLine({ sequence: null }), 2, AT)).toBeNull();
  });
});

describe('RT-542 duplicateFromLocal', () => {
  it('builds the duplicate from this terminal’s own record', () => {
    expect(duplicateFromLocal(localSaleRow(), 3, AT)?.duplicate_copy_sequence_number).toBe(3);
  });

  it('answers null for a record it cannot read', () => {
    const broken: SaleRow = { ...localSaleRow(), tender_lines_summary_json: '{not json' };
    expect(duplicateFromLocal(broken, 3, AT)).toBeNull();
  });
});

describe('RT-542 duplicateBands — marks', () => {
  it('adds nothing to an unmarked duplicate', () => {
    const plain = duplicateBands(duplicate(), ctx());
    expect(texts(plain).join('\n')).not.toContain('RETURNED');
  });

  it('marks a returned duplicate and lists its returns, naming an unknown line as not recorded', () => {
    const returned = detail({
      returns: [
        {
          return_ref: 'r1',
          recorded_at: '2026-10-16T08:00:00.000Z',
          business_day: '2026-10-16',
          total_minor: 1500,
          lines: [
            { line_ref: 'l1', quantity: '1', line_minor: 1500 },
            { line_ref: 'gone', quantity: '1', line_minor: 0 },
          ],
        },
      ],
    });
    const out = texts(duplicateBands(duplicate(), ctx({ detail: returned, marks: ['returned'] })));
    expect(out).toContain('RETURNED');
    expect(out).toContain('1× Panadol');
    expect(out).toContain('1× not recorded — غير مسجل');
    expect(out).toContain(`Return total: ${egp(1500)}`);
  });
});

describe('RT-542 saleRecordBands — every unrecorded block says so', () => {
  it('labels a legacy sale instead of guessing', () => {
    const legacy = detail({
      summary: row({
        sale_number: null,
        device_label: null,
        device_label_source: 'unavailable',
        operator_display_name: 'Mona',
        operator_name_source: 'current',
      }),
      receipt_header: null,
      line_order: 'not_recorded',
      tender_state: 'unknown',
      tenders: [],
      change_minor: null,
      settled_at: null,
    });
    const out = texts(saleRecordBands(ctx({ detail: legacy })));
    expect(out).toContain('SALE RECORD — NOT A RECEIPT COPY');
    expect(out).toContain('Branch: not recorded — غير مسجل');
    expect(out).toContain('Sale # not recorded — غير مسجل');
    expect(out).toContain('Terminal: not recorded — غير مسجل');
    expect(out).toContain('Cashier: Mona (current name)');
    expect(out).toContain('Line order: not recorded — غير مسجل');
    expect(out).toContain('Payment: not recorded — غير مسجل');
    expect(out).toContain('Copy # 2');
  });

  it('prints the recorded tenders, card and cash, and an unrecorded change', () => {
    const out = texts(
      saleRecordBands(
        ctx({
          detail: detail({
            tenders: [
              { method: 'card_external', amount_minor: 1000, reference: null, sequence: 1 },
              { method: 'cash', amount_minor: 500, reference: null, sequence: 2 },
            ],
            change_minor: null,
          }),
        }),
      ),
    );
    expect(out).toContain(`Card — بطاقة   ${egp(1000)}`);
    expect(out).toContain(`Cash — نقدي   ${egp(500)}`);
    expect(out).toContain('Change — الباقي   not recorded — غير مسجل');
    expect(out).toContain('Branch');
  });

  it('marks a voided record, with the void time when recorded', () => {
    const voided = detail({
      void: {
        voided_at: '2026-10-16T07:20:00.000Z',
        void_business_day: '2026-10-16',
        approved: true,
        approver_role: 'store_manager',
      },
    });
    const withTime = texts(saleRecordBands(ctx({ detail: voided, marks: ['voided'] })));
    expect(withTime).toContain('VOIDED');
    expect(withTime.some((t) => t.startsWith('Voided: '))).toBe(true);
    // A live local void the server does not know yet: marked, no server time.
    const local = texts(saleRecordBands(ctx({ marks: ['voided'] })));
    expect(local).toContain('VOIDED');
    expect(local.some((t) => t.startsWith('Voided: '))).toBe(false);
  });

  it('names an unprintable server line as not recorded', () => {
    const out = texts(saleRecordBands(ctx({ detail: withLine({ name: `${RLO}${BEL}  ` }) })));
    expect(out).toContain('1× not recorded — غير مسجل');
  });
});
