/**
 * RT-204 — every dynamic value on the sale receipt wraps to the 42-column roll.
 *
 * An unbroken 120-character value (ASCII, emoji, Arabic) in each dynamic field:
 * every printed line is ≤ 42 columns, measured in code points, in BOTH the HTML
 * and the ESC/POS output, and the whole value still prints (nothing clipped).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { renderReceipt } from '../../../../src/main/receipts/template-engine.js';
import type { ReceiptPayload } from '../../../../src/shared/receipts/types.js';
import type { SaleId, SaleNumber } from '../../../../src/shared/sales/types.js';

const COLS = 42;

function payload(overrides: Partial<ReceiptPayload> = {}): ReceiptPayload {
  return {
    variant: 'first_print',
    sale_id: 'sale-1' as SaleId,
    sale_number: 'TERM-01-2026-05-27-000001' as SaleNumber,
    receipt_number: 'TERM-01-2026-05-27-000001',
    tenant_tax_registration_id: '100123456789012',
    branch_name: 'صيدلية الرحمة قناطر',
    branch_address: 'الفرع الرئيسي — العاشر من رمضان',
    terminal_label: 'TERM-01',
    selling_operator_display_name: 'Mohamed Ahmed',
    subtotal_minor: 12500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    lines: [
      {
        item_ref: 'SKU-001',
        display_name: 'Augmentin 625mg',
        quantity: 1,
        unit_price_minor: 12500,
        line_subtotal_minor: 12500,
        note: null,
      },
    ],
    tender_lines_summary: [{ tender_type: 'cash', amount_applied_minor: 12500 }],
    settled_at: '2026-05-27T08:42:18.000Z',
    finalized_at: '2026-05-27T08:42:19.000Z',
    local_calendar_day: '2026-05-27',
    ...overrides,
  };
}

const width = (s: string): number => Array.from(s).length;

function htmlLines(html: string): string[] {
  const bands = html.match(/<div class="(?:band|rule)[^"]*"[^>]*>[^<]*<\/div>/g) ?? [];
  return bands.map((b) =>
    b
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&'),
  );
}

function escposLines(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  return text
    .replace(/\u001b@/g, '')
    .replace(/\u001b[aE]./g, '')
    .replace(/\u001dV\u0000/g, '')
    .split('\n');
}

const compact = (lines: string[]): string => lines.join('').replace(/\s+/g, '');

const VALUES: ReadonlyArray<readonly [string, string]> = [
  ['ASCII', 'A'.repeat(120)],
  ['emoji', '😀'.repeat(120)],
  ['Arabic', 'م'.repeat(120)],
];

const FIELDS: ReadonlyArray<readonly [string, (v: string) => Partial<ReceiptPayload>]> = [
  ['branch_name', (v) => ({ branch_name: v })],
  ['branch_address', (v) => ({ branch_address: v })],
  ['tenant_tax_registration_id', (v) => ({ tenant_tax_registration_id: v })],
  ['sale_number', (v) => ({ sale_number: v as SaleNumber })],
  ['receipt_number', (v) => ({ receipt_number: v })],
  ['terminal_label', (v) => ({ terminal_label: v })],
  ['selling_operator_display_name', (v) => ({ selling_operator_display_name: v })],
  [
    'line display_name',
    (v) => ({
      lines: [
        {
          item_ref: 'SKU-X',
          display_name: v,
          quantity: 1,
          unit_price_minor: 12500,
          line_subtotal_minor: 12500,
          note: null,
        },
      ],
    }),
  ],
  [
    'card external_reference',
    (v) => ({
      tender_lines_summary: [
        {
          tender_type: 'external_card_terminal',
          amount_applied_minor: 12500,
          external_reference: v,
        },
      ],
    }),
  ],
  [
    'voucher_authority_redemption_id',
    (v) => ({
      tender_lines_summary: [
        {
          tender_type: 'internal_voucher',
          amount_applied_minor: 12500,
          voucher_authority_redemption_id: v,
        },
      ],
    }),
  ],
];

describe('RT-204 — an unbroken 120-character value wraps in every dynamic field', () => {
  for (const [field, build] of FIELDS) {
    for (const [kind, value] of VALUES) {
      it(`${field} (${kind}): every line ≤ ${String(COLS)} columns, full value printed, HTML and ESC/POS`, () => {
        const out = renderReceipt(payload(build(value)));
        for (const lines of [htmlLines(out.html), escposLines(out.escpos)]) {
          for (const line of lines) {
            expect(width(line), line).toBeLessThanOrEqual(COLS);
          }
          expect(compact(lines)).toContain(value);
        }
      });
    }
  }

  it('the reprint duplicate wraps too (same composition)', () => {
    const value = '😀'.repeat(120);
    const out = renderReceipt(
      payload({
        variant: 'reprint_duplicate',
        duplicate_copy_sequence_number: 1,
        reprinted_at: '2026-05-27T11:08:33.000Z',
        branch_name: value,
      }),
    );
    for (const line of htmlLines(out.html)) expect(width(line)).toBeLessThanOrEqual(COLS);
    expect(compact(htmlLines(out.html))).toContain(value);
  });
});

describe('RT-204 — the receipt website line (configured text) wraps as well', () => {
  const saved = process.env['POS_PULSE_RECEIPT_WEBSITE'];
  afterEach(() => {
    if (saved === undefined) delete process.env['POS_PULSE_RECEIPT_WEBSITE'];
    else process.env['POS_PULSE_RECEIPT_WEBSITE'] = saved;
  });

  it('a 120-character configured website never exceeds the roll', () => {
    const value = 'w'.repeat(120);
    process.env['POS_PULSE_RECEIPT_WEBSITE'] = value;
    const out = renderReceipt(payload());
    for (const lines of [htmlLines(out.html), escposLines(out.escpos)]) {
      for (const line of lines) expect(width(line)).toBeLessThanOrEqual(COLS);
      expect(compact(lines)).toContain(value);
    }
  });
});

describe('RT-204 — control and bidi override characters never reach the printer', () => {
  it('strips them from a dynamic value', () => {
    const out = renderReceipt(payload({ terminal_label: 'T‮ERM\u0007-01' }));
    expect(out.html).toContain('Terminal: TERM-01');
    expect(out.html).not.toContain('‮');
    expect(new TextDecoder().decode(out.escpos)).not.toContain('\u0007');
  });
});

describe('RT-204 — a receipt whose values already fit is unchanged', () => {
  it('prints short values verbatim, including internal spacing', () => {
    const out = renderReceipt(payload({ terminal_label: 'TERM  01', branch_address: '' }));
    expect(out.html).toContain('>Terminal: TERM  01<');
    expect(htmlLines(out.html).filter((l) => l === '')).toHaveLength(1);
  });
});
