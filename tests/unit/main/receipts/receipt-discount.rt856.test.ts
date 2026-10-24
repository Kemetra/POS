/**
 * RT-856 (RT-699 I3, OD-28-11, doc 28 §5) — the discount rows on the receipt.
 *
 *   • under each discounted item, one indented row: «خصم 10%» and the amount
 *     (a percent shows its value; an amount discount shows «خصم» alone);
 *   • one «إجمالي الخصم» row (Σ line discounts) directly above the total;
 *   • the total is the Sale's `subtotal_minor`, the net;
 *   • a zero total (OZ-1 = Z-A) prints 0.00 and no payment section;
 *   • the receipt reads only the frozen `lines_json` and carries only the
 *     discount's kind, value and amount: no placeholder, reason or approver.
 *
 * Money goes through `money.ts`, so the minus is the ASCII hyphen-minus of
 * `format` ("-9.00 EGP"), not U+2212: one glyph for every printer codepage.
 * An item is two bands (name, amount), so a discount row is two bands too.
 */
import { describe, expect, it } from 'vitest';

import {
  composeReceiptBands,
  renderReceipt,
  type Band,
} from '../../../../src/main/receipts/template-engine.js';
import {
  deriveReceiptPayload,
  ReceiptPayloadDerivationError,
} from '../../../../src/main/receipts/receipts-payload.js';
import type { SaleRow } from '../../../../src/main/sales/repositories/sales.repository.js';
import type { ReceiptLineItem, ReceiptPayload } from '../../../../src/shared/receipts/types.js';
import type { SaleId, SaleNumber } from '../../../../src/shared/sales/types.js';

const PANADOL: ReceiptLineItem = {
  item_ref: 'SKU-1',
  display_name: 'بانادول إكسترا',
  quantity: 2,
  unit_price_minor: 4500,
  line_subtotal_minor: 9000,
  note: null,
};
const VITAMIN: ReceiptLineItem = {
  item_ref: 'SKU-2',
  display_name: 'Vitamin C',
  quantity: 1,
  unit_price_minor: 2500,
  line_subtotal_minor: 2500,
  note: null,
};

function payload(lines: ReceiptLineItem[], subtotal: number, tenders = true): ReceiptPayload {
  return {
    variant: 'first_print',
    sale_id: 'sale-1' as SaleId,
    sale_number: 'TERM-01-2026-10-24-000001' as SaleNumber,
    receipt_number: 'TERM-01-2026-10-24-000001',
    tenant_tax_registration_id: 'TRN-1',
    branch_name: 'صيدلية',
    branch_address: 'العنوان',
    terminal_label: 'TERM-01',
    selling_operator_display_name: 'Layla',
    subtotal_minor: subtotal,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    lines,
    tender_lines_summary: tenders
      ? [{ tender_type: 'cash', amount_applied_minor: subtotal, change_due_minor: 0 }]
      : [],
    settled_at: '2026-10-24T10:00:00.000Z',
    finalized_at: '2026-10-24T10:00:01.000Z',
    local_calendar_day: '2026-10-24',
  };
}

const texts = (bands: Band[]): string[] =>
  bands.map((b) => (b.kind === 'rule' ? `rule:${b.char}` : `${b.align}:${b.text}`));

/** The bands from one item's name to the next rule or item. */
function itemBlock(bands: Band[], name: string): string[] {
  const all = texts(bands);
  const start = all.findIndex((t) => t.includes(name));
  return all.slice(start, start + 4);
}

describe('RT-856 — a discount row under each discounted item', () => {
  it('percent: «خصم 10%» indented, then the negative amount', () => {
    const bands = composeReceiptBands(
      payload(
        [{ ...PANADOL, discount: { kind: 'percent', value: 10, amount_minor: 900 } }, VITAMIN],
        10_600,
      ),
    );
    expect(itemBlock(bands, 'بانادول')).toEqual([
      'rtl:2× بانادول إكسترا',
      'ltr:90.00 EGP',
      'rtl:   خصم 10%',
      'ltr:-9.00 EGP',
    ]);
    // The undiscounted line has no discount row.
    expect(itemBlock(bands, 'Vitamin C')).toEqual([
      'rtl:1× Vitamin C',
      'ltr:25.00 EGP',
      'rule:-',
      'rtl:إجمالي الخصم',
    ]);
  });

  it('amount: «خصم» and the amount only', () => {
    const bands = composeReceiptBands(
      payload([{ ...PANADOL, discount: { kind: 'amount', value: 500, amount_minor: 500 } }], 8500),
    );
    expect(itemBlock(bands, 'بانادول').slice(2)).toEqual(['rtl:   خصم', 'ltr:-5.00 EGP']);
  });

  it('a free line: «خصم 100%», the full gross off, total 0.00', () => {
    const bands = composeReceiptBands(
      payload(
        [{ ...PANADOL, discount: { kind: 'percent', value: 100, amount_minor: 9000 } }],
        0,
        false,
      ),
    );
    expect(itemBlock(bands, 'بانادول').slice(2)).toEqual(['rtl:   خصم 100%', 'ltr:-90.00 EGP']);
    expect(texts(bands)).toContain('ltr:Subtotal: 0.00 EGP');
  });
});

describe('RT-856 — «إجمالي الخصم» directly above the total', () => {
  it('sums the line discounts, then the net total', () => {
    const bands = composeReceiptBands(
      payload(
        [
          { ...PANADOL, discount: { kind: 'percent', value: 10, amount_minor: 900 } },
          { ...VITAMIN, discount: { kind: 'amount', value: 500, amount_minor: 500 } },
        ],
        10_100,
      ),
    );
    const all = texts(bands);
    const at = all.indexOf('rtl:إجمالي الخصم');
    expect(all.slice(at - 1, at + 3)).toEqual([
      'rule:-',
      'rtl:إجمالي الخصم',
      'ltr:-14.00 EGP',
      'ltr:Subtotal: 101.00 EGP',
    ]);
    expect(all.filter((t) => t === 'rtl:إجمالي الخصم')).toHaveLength(1);
  });
});

describe('RT-856 — a zero total (OZ-1 = Z-A)', () => {
  it('prints 0.00 and no payment section', () => {
    const p = payload(
      [{ ...PANADOL, discount: { kind: 'percent', value: 100, amount_minor: 9000 } }],
      0,
      false,
    );
    const all = texts(composeReceiptBands(p));
    expect(all).not.toContain('rtl:طريقة الدفع');
    expect(all).toContain('ltr:Total inc. VAT: 0.00 EGP');
    expect(all.some((t) => t.includes('نقدًا'))).toBe(false);
    const html = renderReceipt(p).html;
    expect(html).not.toContain('طريقة الدفع');
  });
});

describe('RT-856 — an undiscounted receipt is unchanged', () => {
  it('a positive total with an empty tender summary (tender-unknown) keeps its payment section', () => {
    const all = texts(composeReceiptBands(payload([PANADOL], 9000, false)));
    expect(all).toContain('rtl:طريقة الدفع');
  });

  it('no discount rows, and the payment section stays', () => {
    const all = texts(composeReceiptBands(payload([PANADOL, VITAMIN], 11_500)));
    expect(all.some((t) => t.includes('خصم'))).toBe(false);
    const subtotalAt = all.indexOf('ltr:Subtotal: 115.00 EGP');
    expect(all[subtotalAt - 1]).toBe('rule:-');
    expect(all[subtotalAt - 2]).toBe('ltr:25.00 EGP');
    expect(all).toContain('rtl:طريقة الدفع');
  });
});

describe('RT-856 — the receipt payload reads only the frozen lines_json', () => {
  const frozenDiscount = {
    kind: 'percent',
    value: 10,
    amount_minor: 900,
    placeholder_id: 'dp-SECRET-1',
    reason_code: 'promotion',
    authority_source: 'cashier_approval',
    approver_role: 'manager',
    approver_operator_id: 'mgr-SECRET-1',
  };
  const row = {
    sale_id: 'sale-1',
    sale_number: 'S-1',
    receipt_number: 'S-1',
    tenant_tax_registration_id: 'TRN-1',
    branch_name: 'b',
    branch_address: 'a',
    terminal_label: 'T',
    selling_operator_display_name: 'Layla',
    subtotal_minor: 8100,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary_json: '[]',
    settled_at: '2026-10-24T10:00:00.000Z',
    finalized_at: '2026-10-24T10:00:01.000Z',
    local_calendar_day: '2026-10-24',
    lines_json: JSON.stringify([
      { ...PANADOL, line_id: 'line-1', discount: frozenDiscount },
      { ...VITAMIN, line_id: 'line-2' },
    ]),
  } as unknown as SaleRow;

  it('maps only kind, value and amount; an undiscounted line has no discount', () => {
    const p = deriveReceiptPayload(row, { variant: 'first_print' });
    expect(p.lines[0]?.discount).toEqual({ kind: 'percent', value: 10, amount_minor: 900 });
    expect(p.lines[1]).not.toHaveProperty('discount');
    const rendered = renderReceipt(p);
    const all = new TextDecoder().decode(rendered.escpos) + rendered.html;
    for (const secret of ['dp-SECRET-1', 'mgr-SECRET-1', 'promotion', 'cashier_approval']) {
      expect(all).not.toContain(secret);
    }
    expect(JSON.stringify(p)).not.toContain('SECRET');
  });

  it.each([
    { kind: 'percent', value: 10, amount_minor: 1.5 },
    { kind: 'bogus', value: 1, amount_minor: 1 },
    { kind: 'amount', value: 0, amount_minor: 0 },
    { kind: 'percent', value: 101, amount_minor: 1 },
    'percent',
  ])('a malformed discount (%j) is a controlled failure, never a guessed slip', (discount) => {
    const bad = {
      ...row,
      lines_json: JSON.stringify([{ ...PANADOL, discount }]),
    };
    expect(() => deriveReceiptPayload(bad, { variant: 'first_print' })).toThrow(
      ReceiptPayloadDerivationError,
    );
  });
});
