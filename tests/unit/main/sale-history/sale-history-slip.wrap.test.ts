/**
 * RT-828 — every dynamic value on the sale-history slips wraps to the 42-column
 * roll: the returns block of a returned-sale duplicate and the whole sale-record
 * slip. An unbroken 120-character value (ASCII, emoji, Arabic) in each dynamic
 * field: every printed line is ≤ 42 columns (code points) in BOTH the HTML and
 * the ESC/POS output, and the whole value still prints.
 */
import { describe, expect, it } from 'vitest';

import {
  COLS,
  VALUES,
  compact,
  escposLines,
  htmlLines,
  width,
} from '../receipts/__helpers__/printed-lines.js';
import { renderBands, type Band } from '../../../../src/main/receipts/template-engine.js';
import type { SaleHistoryDetail } from '../../../../src/shared/sale-history/types.js';
import {
  duplicateBands,
  duplicateFromDetail,
  saleRecordBands,
  type SlipContext,
} from '../../../../src/main/sale-history/sale-history-slip.js';

const AT = '2026-10-16T09:00:00.000Z';

function detail(over: Partial<SaleHistoryDetail> = {}): SaleHistoryDetail {
  return {
    summary: {
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
    },
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
    tenders: [{ method: 'cash', amount_minor: 1500, reference: null, sequence: 1 }],
    change_minor: 0,
    settled_at: '2026-10-16T07:00:00.000Z',
    receipt_number: 'T1-20261016-0001',
    receipt_header: { branch_name: 'Branch', branch_address: 'Addr', tax_registration_id: 'TRN' },
    void: null,
    returns: [
      {
        return_ref: 'r1',
        recorded_at: '2026-10-16T08:00:00.000Z',
        business_day: '2026-10-16',
        total_minor: 1500,
        lines: [{ line_ref: 'l1', quantity: '1', line_minor: 1500 }],
      },
    ],
    erp: { sale: 'posted', sale_document_ref: 'D-1', reversal: null, reversal_document_ref: null },
    receipt_facts: 'complete',
    reprint: { duplicate: 'allowed', marks: [] },
    ...over,
  };
}

const withSummary = (over: Partial<SaleHistoryDetail['summary']>): SaleHistoryDetail => {
  const base = detail();
  return { ...base, summary: { ...base.summary, ...over } };
};

const withLineName = (name: string): SaleHistoryDetail => {
  const base = detail();
  return { ...base, lines: base.lines.map((line) => ({ ...line, name })) };
};

function ctx(d: SaleHistoryDetail, marks: SlipContext['marks'] = ['returned']): SlipContext {
  return { detail: d, copyNumber: 2, marks, printedAt: AT };
}

/** The returned-sale duplicate's bands (the returns block rides after the receipt). */
function returnedDuplicate(d: SaleHistoryDetail): Band[] {
  const payload = duplicateFromDetail(d, 2, AT);
  if (payload === null) throw new Error('the fixture builds a duplicate');
  return duplicateBands(payload, ctx(d));
}

/** The returns block alone: from its header to the end of the slip. */
const RETURNS_HEADER = 'المرتجعات — RETURNS';
function fromReturnsHeader(lines: string[]): string[] {
  const at = lines.indexOf(RETURNS_HEADER);
  if (at === -1) throw new Error('the slip has a returns block');
  return lines.slice(at);
}

type Build = (v: string) => Band[];

const FIELDS: ReadonlyArray<readonly [string, Build]> = [
  ['returns block: line name', (v) => returnedDuplicate(withLineName(v))],
  [
    'record: branch_name',
    (v) =>
      saleRecordBands(
        ctx(
          {
            ...detail(),
            receipt_header: { branch_name: v, branch_address: 'Addr', tax_registration_id: 'T' },
          },
          [],
        ),
      ),
  ],
  ['record: sale_number', (v) => saleRecordBands(ctx(withSummary({ sale_number: v }), []))],
  ['record: terminal', (v) => saleRecordBands(ctx(withSummary({ device_label: v }), []))],
  ['record: cashier', (v) => saleRecordBands(ctx(withSummary({ operator_display_name: v }), []))],
  ['record: line name', (v) => saleRecordBands(ctx(withLineName(v), []))],
  ['record (returned): returns-block line name', (v) => saleRecordBands(ctx(withLineName(v)))],
];

describe('RT-828 — an unbroken 120-character value wraps in every dynamic field', () => {
  for (const [field, build] of FIELDS) {
    for (const [kind, value] of VALUES) {
      it(`${field} (${kind}): every line ≤ ${String(COLS)} columns, full value printed, HTML and ESC/POS`, () => {
        const out = renderBands(build(value));
        for (const lines of [htmlLines(out.html), escposLines(out.escpos)]) {
          for (const line of lines) expect(width(line), line).toBeLessThanOrEqual(COLS);
          expect(compact(lines)).toContain(value);
          if (/returns[- ]block/.test(field)) {
            expect(compact(fromReturnsHeader(lines))).toContain(value);
          }
        }
      });
    }
  }
});

describe('RT-828 — a current-name label stays attached to a wrapped value', () => {
  it('prints the whole name and the label, each line within the roll', () => {
    const value = 'A'.repeat(120);
    const out = renderBands(
      saleRecordBands(
        ctx(withSummary({ operator_display_name: value, operator_name_source: 'current' }), []),
      ),
    );
    for (const lines of [htmlLines(out.html), escposLines(out.escpos)]) {
      for (const line of lines) expect(width(line)).toBeLessThanOrEqual(COLS);
      expect(compact(lines)).toContain(`${value}(currentname)`);
    }
  });
});

describe('RT-828 — a slip whose values already fit is unchanged', () => {
  it('prints each short value as one verbatim band, including internal spacing', () => {
    const out = renderBands(
      saleRecordBands(ctx(withSummary({ device_label: 'Till  2', sale_number: 'S-1' }), [])),
    );
    expect(out.html).toContain('>Terminal: Till  2<');
    expect(out.html).toContain('>Sale # S-1<');
    expect(out.html).toContain('>1× Panadol<');
    expect(out.html).toContain('>Branch<');
  });
});
