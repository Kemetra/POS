/**
 * RT-204 — every dynamic value on the sale receipt wraps to the 42-column roll.
 *
 * An unbroken 120-character value (ASCII, emoji, Arabic) in each dynamic field:
 * every printed line is ≤ 42 columns, measured in display cells (RT-829), in BOTH the HTML
 * and the ESC/POS output, and the whole value still prints (nothing clipped).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { renderReceipt } from '../../../../src/main/receipts/template-engine.js';
import {
  COLS,
  VALUES,
  WIDE_VALUES,
  compact,
  expectFitsRoll,
  escposLines,
  htmlLines,
  width,
} from './__helpers__/printed-lines.js';
import type { ReceiptPayload } from '../../../../src/shared/receipts/types.js';
import type { SaleId, SaleNumber, TenderLineSummary } from '../../../../src/shared/sales/types.js';

const oneLine = (display_name: string): ReceiptPayload['lines'][number] => ({
  item_ref: 'i',
  display_name,
  quantity: 1,
  unit_price_minor: 100,
  line_subtotal_minor: 100,
  note: null,
});

function payload(overrides: Partial<ReceiptPayload> = {}): ReceiptPayload {
  return {
    variant: 'first_print',
    sale_id: 's-9' as SaleId,
    sale_number: 'S-9' as SaleNumber,
    receipt_number: 'R-9',
    tenant_tax_registration_id: '555',
    branch_name: 'Branch',
    branch_address: 'Street 1',
    terminal_label: 'T9',
    selling_operator_display_name: 'Op',
    subtotal_minor: 100,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    lines: [oneLine('Item')],
    tender_lines_summary: [{ tender_type: 'cash', amount_applied_minor: 100 }],
    settled_at: '2026-06-01T10:00:00.000Z',
    finalized_at: '2026-06-01T10:00:01.000Z',
    local_calendar_day: '2026-06-01',
    ...overrides,
  };
}

function tenderWith(
  tender_type: TenderLineSummary['tender_type'],
  extra: Partial<TenderLineSummary>,
): Partial<ReceiptPayload> {
  return { tender_lines_summary: [{ tender_type, amount_applied_minor: 12500, ...extra }] };
}

const FIELDS: ReadonlyArray<readonly [string, (v: string) => Partial<ReceiptPayload>]> = [
  ['branch_name', (v) => ({ branch_name: v })],
  ['branch_address', (v) => ({ branch_address: v })],
  ['tenant_tax_registration_id', (v) => ({ tenant_tax_registration_id: v })],
  ['sale_number', (v) => ({ sale_number: v as SaleNumber })],
  ['receipt_number', (v) => ({ receipt_number: v })],
  ['terminal_label', (v) => ({ terminal_label: v })],
  ['selling_operator_display_name', (v) => ({ selling_operator_display_name: v })],
  ['line display_name', (v) => ({ lines: [oneLine(v)] })],
  [
    'card external_reference',
    (v) => tenderWith('external_card_terminal', { external_reference: v }),
  ],
  [
    'voucher_authority_redemption_id',
    (v) => tenderWith('internal_voucher', { voucher_authority_redemption_id: v }),
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

describe('RT-829 — wide, emoji and combining values wrap by display width in every dynamic field', () => {
  for (const [field, build] of FIELDS) {
    for (const [kind, value] of WIDE_VALUES) {
      it(`${field} (${kind}): every line ≤ ${String(COLS)} display columns, full value, no split cluster, HTML and ESC/POS`, () => {
        const out = renderReceipt(payload(build(value)));
        for (const lines of [htmlLines(out.html), escposLines(out.escpos)]) {
          expectFitsRoll(lines, value);
        }
      });
    }
  }
});

describe('RT-829 — internal spacing survives a wrap', () => {
  it('keeps a double space inside a line and drops the gap at the break', () => {
    const out = renderReceipt(
      payload({ branch_address: `${'ab'.repeat(10)}  ${'cd'.repeat(10)}  ${'ef'.repeat(10)}` }),
    );
    for (const lines of [htmlLines(out.html), escposLines(out.escpos)]) {
      expect(lines).toContain(`${'ab'.repeat(10)}  ${'cd'.repeat(10)}`);
      expect(lines).toContain(`    ${'ef'.repeat(10)}`);
    }
  });

  it('prints a value that fits verbatim, spacing included', () => {
    const fits = renderReceipt(payload({ terminal_label: 'a   b' }));
    expect(fits.html).toContain('>Terminal: a   b<');
  });
});

describe('RT-204 — a hard-split token is never altered', () => {
  it('inserts no space inside a 39-character token that is followed by more words', () => {
    const token = 'A'.repeat(39);
    const out = renderReceipt(payload({ branch_name: `${token} BBB` }));
    for (const lines of [htmlLines(out.html), escposLines(out.escpos)]) {
      expect(lines.join('|')).not.toMatch(/A\s+A/);
      expect(compact(lines)).toContain(`${token}BBB`);
    }
  });

  it('keeps a band for an overlong whitespace-only value', () => {
    const out = renderReceipt(payload({ branch_address: ' '.repeat(60) }));
    expect(htmlLines(out.html)).toContain('');
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
    const rlo = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(7);
    const out = renderReceipt(payload({ terminal_label: `T${rlo}ERM${bell}-01` }));
    expect(out.html).toContain('Terminal: TERM-01');
    expect(out.html).not.toContain(rlo);
    expect(new TextDecoder().decode(out.escpos)).not.toContain(bell);
  });
});

describe('RT-204 — a receipt whose values already fit is unchanged', () => {
  it('prints short values verbatim, including internal spacing', () => {
    const out = renderReceipt(payload({ terminal_label: 'TERM  01', branch_address: '' }));
    expect(out.html).toContain('>Terminal: TERM  01<');
    expect(htmlLines(out.html).filter((l) => l === '')).toHaveLength(1);
  });
});
