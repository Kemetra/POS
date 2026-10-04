/**
 * RT-15 S4 — the non-fiscal cash return slip (AC12; invariants S1, S2, S3, S5, S6).
 *
 * The slip is built from the full domain objects (journal entry, payout row,
 * slip lines, sale header), so the "never on the slip" checks below prove the
 * builder drops what it is handed, not just that the payload type lacks it.
 */
import { describe, expect, it } from 'vitest';

import type { JournalEntry } from '../returns-repository.js';
import type { PayoutRow, SlipLine } from '../returns-payout-repository.js';
import { renderReturnSlip, slipLineName, type ReturnSlipSource } from '../returns-slip.js';
import { LINE_A, LINE_B, RETURN_REF, SALE_REF, SCOPE } from './__helpers__/returns-fixture.js';

const EXTERNAL_ID = 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-0000000000e1';

const ENTRY: JournalEntry = {
  returnId: 'ret-1',
  scope: SCOPE,
  saleId: 'sale-1',
  saleNumber: 'T1-000042',
  serverSaleRef: SALE_REF,
  externalId: EXTERNAL_ID,
  operatorId: 'op-returner-secret-id',
  operatorSessionId: 'sess-returner-secret-id',
  currencyCode: 'EGP',
  quotedTotalMinor: 3500,
  requestBodyJson: '{"body":"request-body-marker"}',
  lines: [
    { lineRef: LINE_A, quantity: 1 },
    { lineRef: LINE_B, quantity: 2 },
  ],
  state: 'paid_out',
  returnRef: RETURN_REF,
  returnTotalMinor: 3500,
  refusalReason: null,
  attemptCount: 1,
  lastAttemptAt: '2026-10-04T10:00:01.000Z',
  createdAt: '2026-10-04T10:00:00.000Z',
  confirmedAt: '2026-10-04T10:00:02.000Z',
};

const PAYOUT: PayoutRow = {
  returnId: 'ret-1',
  startedOperatorId: 'op-starter-secret-id',
  startedSessionId: 'sess-starter-secret-id',
  startedAt: '2026-10-04T10:01:00.000Z',
  paidOperatorId: 'op-payer-secret-id',
  paidOperatorName: 'Mona Manager',
  paidSessionId: 'sess-payer-secret-id',
  paidAt: '2026-10-04T10:01:05.000Z',
  method: 'drawer',
};

const LINES: SlipLine[] = [
  { lineRef: LINE_A, quantity: 1, lineName: 'Panadol 500mg', amountMinor: 1500 },
  { lineRef: LINE_B, quantity: 2, lineName: 'Vitamin C', amountMinor: 2000 },
];

const SOURCE: ReturnSlipSource = {
  entry: ENTRY,
  payout: PAYOUT,
  lines: LINES,
  sale: { branchName: 'Maadi Branch', terminalLabel: 'TERM-01' },
};

/** The slip as printed text: the HTML bands with tags and entities removed. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');
}

function slipText(
  source = SOURCE,
  variant: Parameters<typeof renderReturnSlip>[1] = { kind: 'original' },
) {
  return textOf(renderReturnSlip(source, variant).html);
}

describe('return slip content (S1)', () => {
  it('prints the references, lines, cash total, operator, terminal, branch and time', () => {
    const text = slipText();
    for (const expected of [
      'Maadi Branch',
      'Terminal: TERM-01',
      'CASH RETURN SLIP (non-fiscal)',
      'Return ref:',
      RETURN_REF,
      'Sale # T1-000042',
      'Sale ref:',
      SALE_REF,
      'Paid by: Mona Manager',
      '2026-10-04 10:01:05 UTC',
      '1× Panadol 500mg',
      '15.00 EGP',
      '2× Vitamin C',
      '20.00 EGP',
      'Refund total (cash): 35.00 EGP',
      'طريقة الصرف: نقدًا — Cash',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('prints the total the server confirmed, not the quote', () => {
    const text = slipText({ ...SOURCE, entry: { ...ENTRY, returnTotalMinor: 3400 } });
    expect(text).toContain('Refund total (cash): 34.00 EGP');
  });

  it('prints a line with no journaled details as a quantity with a dash amount', () => {
    const text = slipText({
      ...SOURCE,
      lines: [{ lineRef: LINE_A, quantity: 3, lineName: null, amountMinor: null }],
    });
    expect(text).toContain('3× صنف مرتجع');
    expect(text).toMatch(/3× صنف مرتجع\n—/);
  });

  it('prints a dash for an unknown operator name, missing sale header and missing time', () => {
    const text = slipText({
      ...SOURCE,
      payout: { ...PAYOUT, paidOperatorName: null, paidAt: null },
      sale: null,
    });
    expect(text).toContain('Paid by: —');
    expect(text).toContain('Terminal: —');
    expect(text).not.toContain('UTC');
  });

  it('formats a currency without minor units through its exponent', () => {
    const text = slipText({
      ...SOURCE,
      entry: { ...ENTRY, currencyCode: 'JPY', returnTotalMinor: 3500 },
    });
    expect(text).toContain('Refund total (cash): 3500 JPY');
  });

  it('wraps a long line name', () => {
    const long = `${'Paracetamol '.repeat(5)}end`;
    const line: SlipLine = { lineRef: LINE_A, quantity: 1, lineName: long, amountMinor: 1500 };
    const text = slipText({ ...SOURCE, lines: [line] });
    expect(text).toContain('end');
    expect(text.split('\n').every((l) => Array.from(l).length <= 42)).toBe(true);
  });
});

describe('never on the slip (S2)', () => {
  it.each([
    EXTERNAL_ID,
    'request-body-marker',
    'op-returner-secret-id',
    'sess-returner-secret-id',
    'op-starter-secret-id',
    'sess-starter-secret-id',
    'op-payer-secret-id',
    'sess-payer-secret-id',
    'ret-1',
    SCOPE.tenantId,
  ])('omits %s from both outputs', (secret) => {
    const rendered = renderReturnSlip(SOURCE, {
      kind: 'copy',
      reprintedAt: '2026-10-04T11:00:00.000Z',
    });
    expect(rendered.html).not.toContain(secret);
    expect(new TextDecoder().decode(rendered.escpos)).not.toContain(secret);
  });
});

describe('original and copy (S3)', () => {
  it('marks only a reprint as a copy, with the reprint time', () => {
    expect(slipText()).not.toContain('COPY');
    const copy = slipText(SOURCE, { kind: 'copy', reprintedAt: '2026-10-04T11:00:00.000Z' });
    expect(copy.startsWith('#'.repeat(42))).toBe(true);
    expect(copy).toContain('نسخة — COPY');
    expect(copy).toContain('Reprinted: 2026-10-04 11:00:00 UTC');
  });
});

describe('one source, two outputs (S5)', () => {
  it('serialises the same text to ESC/POS as to HTML', () => {
    const rendered = renderReturnSlip(SOURCE, { kind: 'original' });
    const escposText = new TextDecoder().decode(rendered.escpos);
    for (const line of textOf(rendered.html).split('\n')) expect(escposText).toContain(line);
    expect(rendered.escpos[0]).toBe(0x1b);
  });
});

describe('slip line names (S6)', () => {
  it.each<[string, string, string | null]>([
    ['keeps a plain name', 'Panadol 500mg', 'Panadol 500mg'],
    ['keeps Arabic with joiners', 'بانادول‌ ٥٠٠', 'بانادول‌ ٥٠٠'],
    ['strips control characters', 'Pana\u0007dol\n500', 'Panadol500'],
    ['strips bidi overrides', '‮loadnaP‬', 'loadnaP'],
    ['trims', '  Panadol  ', 'Panadol'],
    ['is null when nothing printable is left', '\u0000 ‮', null],
  ])('%s', (_label, raw, expected) => {
    expect(slipLineName(raw)).toBe(expected);
  });

  it('caps a name at 120 characters without splitting a character', () => {
    const name = slipLineName('😀'.repeat(130));
    expect(Array.from(name ?? '')).toHaveLength(120);
  });
});
