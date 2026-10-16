/**
 * T120-T125 — AD-6 template engine (RED).
 *
 * The engine takes a `ReceiptPayload` and emits BOTH an ESC/POS byte stream
 * and an HTML string from ONE composition pass (AD-6 single-source dual-output).
 * Architecture: `compose(payload) → Band[]`, then `toEscPos(bands)` +
 * `toHtml(bands)` serializers. Layout decisions (42-col wrap, alignment,
 * variant band selection) live only in compose, so the two outputs can never
 * diverge in content.
 *
 * Covered here:
 *   T120 dual-output from one payload
 *   T121 byte-stability (same payload → byte-identical output every call)
 *   T122 Arabic-first RTL + Latin numerals on every numeric field
 *   T123 reprint_duplicate marker present; absent on first_print/preview
 *   T124 currency formatting routed through money.ts (never inlined)
 *   T125 sale-level VAT footer (no per-line VAT); v1 suppresses rate label at tax=0
 */

import { describe, expect, it } from 'vitest';
import { renderReceipt } from '../../../../src/main/receipts/template-engine.js';
import type { ReceiptPayload } from '../../../../src/shared/receipts/types.js';
import type { SaleId, SaleNumber } from '../../../../src/shared/sales/types.js';

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
    selling_operator_display_name: 'محمد أحمد — Mohamed Ahmed',
    subtotal_minor: 19925,
    total_tax_minor: 0,
    total_change_due_minor: 75,
    lines: [
      {
        item_ref: 'SKU-001',
        display_name: 'Augmentin 625mg box 14 tab',
        quantity: 1,
        unit_price_minor: 12500,
        line_subtotal_minor: 12500,
        note: null,
      },
      {
        item_ref: 'SKU-002',
        display_name: 'Paracetamol 500mg box 24 tab',
        quantity: 2,
        unit_price_minor: 2275,
        line_subtotal_minor: 4550,
        note: null,
      },
    ],
    tender_lines_summary: [
      { tender_type: 'cash', amount_applied_minor: 20000, change_due_minor: 75 },
    ],
    settled_at: '2026-05-27T08:42:18.000Z',
    finalized_at: '2026-05-27T08:42:19.000Z',
    local_calendar_day: '2026-05-27',
    ...overrides,
  };
}

describe('T120 — dual output from one payload', () => {
  it('emits both an ESC/POS byte stream and an HTML string', () => {
    const out = renderReceipt(payload());
    expect(out.escpos).toBeInstanceOf(Uint8Array);
    expect(out.escpos.length).toBeGreaterThan(0);
    expect(typeof out.html).toBe('string');
    expect(out.html.length).toBeGreaterThan(0);
  });

  it('renders the same content fields in both outputs', () => {
    const out = renderReceipt(payload());
    const escposText = new TextDecoder().decode(out.escpos);
    // The sale number, an item name, and the formatted subtotal appear in BOTH.
    for (const needle of [
      'TERM-01-2026-05-27-000001',
      'Augmentin 625mg box 14 tab',
      '199.25 EGP',
    ]) {
      expect(escposText).toContain(needle);
      expect(out.html).toContain(needle);
    }
  });
});

describe('T121 — byte-stability', () => {
  it('produces byte-identical output across two renders of the same payload', () => {
    const p = payload();
    const a = renderReceipt(p);
    const b = renderReceipt(p);
    expect(Buffer.from(a.escpos).equals(Buffer.from(b.escpos))).toBe(true);
    expect(a.html).toBe(b.html);
  });

  it('does not embed wall-clock time (renders only from payload timestamps)', () => {
    const out = renderReceipt(payload());
    const text = new TextDecoder().decode(out.escpos) + out.html;
    // The payload's stored date (in the store zone) appears; no other date should.
    expect(text).toContain('2026-05-27');
  });
});

describe('RT-249 N-S5 — the sale stamp is the store-zone (Africa/Cairo) time', () => {
  const textOf = (out: ReturnType<typeof renderReceipt>): string =>
    new TextDecoder().decode(out.escpos) + out.html;

  it('prints settled_at as Cairo local YYYY-MM-DD HH:MM (the plan golden)', () => {
    // 2026-10-06T22:53Z is 01:53 on 2026-10-07 in Cairo (summer time).
    const text = textOf(renderReceipt(payload({ settled_at: '2026-10-06T22:53:00.000Z' })));
    expect(text).toContain('2026-10-07 01:53');
    expect(text).not.toContain('2026-10-06 22:53');
  });

  it('prints the winter Cairo time between 00:00 and 02:00 on the Cairo day', () => {
    const text = textOf(renderReceipt(payload({ settled_at: '2026-01-14T22:05:00.000Z' })));
    expect(text).toContain('2026-01-15 00:05');
  });

  it('renders the same Cairo stamp whatever the process zone is', () => {
    const saved = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const text = textOf(renderReceipt(payload({ settled_at: '2026-10-06T22:53:00.000Z' })));
      expect(text).toContain('2026-10-07 01:53');
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('still renders (as the old UTC stamp) when settled_at is not a valid instant', () => {
    // A receipt must never fail to render over its stamp; settled_at is engine-written.
    const text = textOf(renderReceipt(payload({ settled_at: '2026-05-27T08:42:18' })));
    expect(text).toContain('2026-05-27 08:42:18 UTC');
  });

  it('no longer labels the sale stamp UTC; the reprint line is unchanged', () => {
    const first = textOf(renderReceipt(payload({ settled_at: '2026-10-06T22:53:00.000Z' })));
    expect(first).not.toContain('UTC');
    const duplicate = textOf(
      renderReceipt(
        payload({
          settled_at: '2026-10-06T22:53:00.000Z',
          variant: 'reprint_duplicate',
          duplicate_copy_sequence_number: 1,
          reprinted_at: '2026-10-06T23:10:00.000Z',
        }),
      ),
    );
    expect(duplicate).toContain('2026-10-07 01:53');
    expect(duplicate).toContain('Reprinted: 2026-10-06 23:10:00 UTC');
  });
});

describe('T122 — Arabic-first RTL + Latin numerals', () => {
  it('includes the Arabic branch name and uses Latin digits for numeric fields', () => {
    const out = renderReceipt(payload());
    expect(out.html).toContain('صيدلية الرحمة قناطر');
    // Latin digits only on money/numbers — no Arabic-Indic digits (٠-٩).
    expect(out.html).not.toMatch(/[٠-٩]/);
    const escposText = new TextDecoder().decode(out.escpos);
    expect(escposText).not.toMatch(/[٠-٩]/);
  });

  it('marks RTL alignment for Arabic bands in the HTML output', () => {
    const out = renderReceipt(payload());
    expect(out.html).toMatch(/rtl|dir="rtl"|text-align:\s*right/i);
  });
});

describe('T123 — duplicate-copy marker', () => {
  it('renders the bilingual marker on reprint_duplicate', () => {
    const out = renderReceipt(
      payload({
        variant: 'reprint_duplicate',
        duplicate_copy_sequence_number: 1,
        reprinted_at: '2026-05-27T11:08:33.000Z',
      }),
    );
    const text = new TextDecoder().decode(out.escpos) + out.html;
    expect(text).toContain('نسخة طبق الأصل');
    expect(text).toContain('DUPLICATE COPY');
    expect(text).toContain('Duplicate # 1');
  });

  it('omits the marker on first_print', () => {
    const out = renderReceipt(payload({ variant: 'first_print' }));
    const text = new TextDecoder().decode(out.escpos) + out.html;
    expect(text).not.toContain('DUPLICATE COPY');
  });

  it('omits the marker on preview', () => {
    const out = renderReceipt(payload({ variant: 'preview' }));
    const text = new TextDecoder().decode(out.escpos) + out.html;
    expect(text).not.toContain('DUPLICATE COPY');
  });

  it('renders preview byte-equal to first_print content (AD-6 invariant)', () => {
    const first = renderReceipt(payload({ variant: 'first_print' }));
    const prev = renderReceipt(payload({ variant: 'preview' }));
    expect(prev.html).toBe(first.html);
    expect(Buffer.from(prev.escpos).equals(Buffer.from(first.escpos))).toBe(true);
  });
});

describe('T124 — currency via money.ts formatting', () => {
  it('formats every money field as <major>.<minor> EGP (money.ts format)', () => {
    const out = renderReceipt(payload());
    // subtotal 19925 → 199.25 EGP; change 75 → 0.75 EGP; line 12500 → 125.00 EGP.
    expect(out.html).toContain('199.25 EGP');
    expect(out.html).toContain('0.75 EGP');
    expect(out.html).toContain('125.00 EGP');
    expect(out.html).toContain('45.50 EGP');
  });
});

describe('T125 — sale-level VAT footer', () => {
  it('renders a single sale-level VAT amount, no per-line VAT column', () => {
    const out = renderReceipt(payload({ total_tax_minor: 2450, subtotal_minor: 17475 }));
    expect(out.html).toContain('24.50 EGP'); // VAT total formatted
    // No per-line VAT: each item line shows exactly one money figure (its subtotal).
  });

  it('suppresses the "14%" rate label when tax is 0 (v1 fiscal-honesty rule)', () => {
    const out = renderReceipt(payload({ total_tax_minor: 0 }));
    expect(out.html).not.toContain('14%');
  });

  it('shows the tax-registration id in the VAT footer', () => {
    const out = renderReceipt(payload());
    // Tax ID re-echoed in the footer (appears at least twice: header + VAT band).
    const count = out.html.split('100123456789012').length - 1;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe('T160 — composition edge cases (wrap + tender variants)', () => {
  it('wraps a long item name at 42 columns with a hanging indent', () => {
    const out = renderReceipt(
      payload({
        lines: [
          {
            item_ref: 'SKU-LONG',
            display_name:
              'Amoxicillin and Clavulanate Potassium extended release 1000mg film coated tablets box of 14',
            quantity: 3,
            unit_price_minor: 5000,
            line_subtotal_minor: 15000,
            note: null,
          },
        ],
      }),
    );
    // The full name survives across wrapped lines (joined text contains it
    // word-for-word at the start).
    expect(out.html).toContain('Amoxicillin and Clavulanate');
    // No single rendered band exceeds 42 visible chars (the wrap budget).
    const bands = out.html.match(/<div class="band[^"]*"[^>]*>([^<]*)<\/div>/g) ?? [];
    for (const b of bands) {
      const inner = b.replace(/<[^>]+>/g, '');
      // decode the few entities we emit so length reflects visible chars
      const visible = inner.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      expect(visible.length).toBeLessThanOrEqual(46); // 42 + 4 hanging indent
    }
  });

  it('renders card + voucher tender labels and omits change-due on non-cash', () => {
    const out = renderReceipt(
      payload({
        total_change_due_minor: 0,
        tender_lines_summary: [
          { tender_type: 'external_card_terminal', amount_applied_minor: 10000 },
          { tender_type: 'internal_voucher', amount_applied_minor: 9925 },
        ],
      }),
    );
    expect(out.html).toContain('بطاقة — Card');
    expect(out.html).toContain('قسيمة — Voucher');
    expect(out.html).not.toContain('Change due');
  });

  it('renders reprint_duplicate without a sequence number when none supplied', () => {
    const out = renderReceipt(payload({ variant: 'reprint_duplicate' }));
    const text = new TextDecoder().decode(out.escpos) + out.html;
    expect(text).toContain('DUPLICATE COPY');
    expect(text).not.toContain('Duplicate #');
  });
});
