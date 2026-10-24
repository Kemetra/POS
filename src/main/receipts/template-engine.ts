/**
 * T160 — AD-6 receipt template engine (single-source dual-output).
 *
 * `renderReceipt(payload)` composes the slip ONCE into an intermediate band
 * list, then serialises that list to BOTH an ESC/POS byte stream and an HTML
 * string. All layout decisions (alignment, 42-column wrapping, which bands a
 * variant includes) live in `compose`; the two serialisers are mechanical and
 * decision-free, so the outputs can never diverge in content (AD-6 invariant).
 *
 * Determinism (FR-016 byte-stability — load-bearing for all later slices):
 *   • timestamps are formatted from the payload's stored ISO strings, never
 *     `new Date()`;
 *   • NO `toLocaleString` and no machine locale or zone (that would break
 *     byte-stability across machines/CI). RT-249 N-S5: the sale stamp is the
 *     store-zone (Africa/Cairo) time of `settled_at`, from the shared fixed-zone
 *     formatter `businessDateTimeOf`; a reprint of an older sale prints the
 *     same instant in Cairo time instead of UTC (accepted, RT-545 §4). The
 *     `Reprinted:` line keeps its explicit UTC stamp;
 *   • money is formatted only through `src/shared/money.ts`;
 *   • iteration is over arrays (stable order), never object-key maps.
 *
 * v1 layout subset (slice2-mapping-pass.md, Ahmed 2026-05-28):
 *   • one `display_name` per item (no bilingual second line — v2);
 *   • no shift line (v2);
 *   • VAT block driven by `total_tax_minor`; the "14%" rate label is suppressed
 *     when tax is 0 (fiscal honesty — no misleading rate on a zero-tax doc).
 *   • RT-856 (OD-28-11): a discount row under each discounted item and one
 *     «إجمالي الخصم» row above the total; the totals print the Sale's net
 *     `subtotal_minor`. A zero-total sale (no tender) has no payment section.
 *
 * ESC/POS note: this engine emits structurally-correct control codes + UTF-8
 * text. The Arabic codepage decision (CP864 vs Windows-1256 on the TM-T20III)
 * is a Slice 3 hardware-bring-up concern (T301/T302); nothing is sent to a
 * printer in Slice 2 — the preview uses the HTML path only.
 */

import { format as formatMoney, of as moneyOf } from '../../shared/money.js';
import { BusinessDayError, businessDateTimeOf } from '../../shared/time/business-day.js';
import type { ReceiptPayload, ReceiptLineItem } from '../../shared/receipts/types.js';
import type { TenderLineSummary, SalesTenderType } from '../../shared/sales/types.js';
import type { ReceiptLineDiscount } from '../../shared/sales/sale-line-discount.js';
import { COLS, receiptLines } from './receipt-text.js';

export interface ReceiptRenderOutput {
  escpos: Uint8Array;
  html: string;
}

const DEFAULT_RECEIPT_WEBSITE = 'www.example.test';

function receiptWebsite(): string {
  const configured = process.env['POS_PULSE_RECEIPT_WEBSITE'];
  return typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_RECEIPT_WEBSITE;
}

// ── Intermediate representation ──────────────────────────────────────────────

export type BandAlign = 'ltr' | 'rtl' | 'center';

export interface TextBand {
  kind: 'text';
  text: string;
  align: BandAlign;
  /** Emphasis hint for serialisers (double-strike / heading weight). */
  emphasis?: boolean;
}

export interface RuleBand {
  kind: 'rule';
  /** The repeated character forming the separator rule. */
  char: '=' | '-' | '#';
}

/**
 * One slip band. Exported (RT-15 S4) so another non-fiscal slip — the cash
 * return slip — composes its own bands and reuses these serialisers, rather
 * than growing a second printer path.
 */
export type Band = TextBand | RuleBand;

// ── Helpers (pure) ───────────────────────────────────────────────────────────

function egp(minor: number): string {
  return formatMoney(moneyOf(minor, 'EGP'));
}

/** UTC date-time formatted from a stored ISO string. No Intl, no new Date(). */
export function utcStamp(iso: string): string {
  // "2026-05-27T08:42:18.000Z" → "2026-05-27 08:42:18 UTC"
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19);
  return `${date} ${time} UTC`;
}

/**
 * RT-249 N-S5 — the sale stamp: the store-zone (Africa/Cairo) time of an
 * instant. A receipt never fails to render over its stamp, so an instant the
 * shared formatter refuses falls back to the old UTC slice.
 */
export function storeStamp(iso: string): string {
  try {
    return businessDateTimeOf(iso);
  } catch (error) {
    if (error instanceof BusinessDayError) return utcStamp(iso);
    throw error;
  }
}

const TENDER_LABELS: Record<SalesTenderType, string> = {
  cash: 'نقدًا — Cash',
  external_card_terminal: 'بطاقة — Card',
  internal_voucher: 'قسيمة — Voucher',
};

/** Adds a band (or, for a dynamic value, one per wrapped line). */
type TextSink = (t: string, align: BandAlign, emphasis?: boolean) => void;

// ── compose: the SINGLE source of layout truth ───────────────────────────────

function compose(payload: ReceiptPayload): Band[] {
  const bands: Band[] = [];
  const rule = (char: RuleBand['char']): void => {
    bands.push({ kind: 'rule', char });
  };
  const text: TextSink = (t, align, emphasis = false) => {
    bands.push({ kind: 'text', text: t, align, emphasis });
  };
  // A dynamic value (RT-204): wrapped to the roll, one band per printed line.
  const value = (t: string, align: BandAlign, emphasis = false): void => {
    for (const line of receiptLines(t)) text(line, align, emphasis);
  };

  composeDuplicateMarker(payload, rule, text);

  // Header band.
  rule('=');
  value(payload.branch_name, 'rtl');
  value(payload.branch_address, 'rtl');
  value(`Tax ID: ${payload.tenant_tax_registration_id}`, 'ltr');
  rule('-');
  value(`Sale # ${payload.sale_number}`, 'ltr', true);
  value(`Receipt # ${payload.receipt_number}`, 'ltr');
  value(`Terminal: ${payload.terminal_label}`, 'ltr');
  value(`Cashier: ${payload.selling_operator_display_name}`, 'rtl');
  // v1: no shift line (slice2-mapping-pass.md Gap 3).
  text(storeStamp(payload.settled_at), 'ltr');
  if (payload.variant === 'reprint_duplicate' && payload.reprinted_at !== undefined) {
    text(`Reprinted: ${utcStamp(payload.reprinted_at)}`, 'ltr');
  }

  // Items band.
  rule('=');
  text('العناصر', 'rtl');
  rule('-');
  for (const line of payload.lines) {
    composeItem(line, value, text);
  }
  rule('-');
  composeDiscountTotal(payload.lines, text);
  text(`Subtotal: ${egp(payload.subtotal_minor)}`, 'ltr');

  composeTenderBand(payload, rule, text, value);

  // VAT footer band.
  rule('=');
  text('ضريبة القيمة المضافة', 'rtl');
  rule('-');
  value(`Tax ID: ${payload.tenant_tax_registration_id}`, 'ltr');
  // v1: suppress the "14%" rate label when tax is 0 (fiscal honesty).
  const vatLabel = payload.total_tax_minor === 0 ? 'VAT:' : 'VAT (14%):';
  text(`${vatLabel} ${egp(payload.total_tax_minor)}`, 'ltr');
  text(`Subtotal (ex. VAT): ${egp(payload.subtotal_minor - payload.total_tax_minor)}`, 'ltr');
  text(`Total inc. VAT: ${egp(payload.subtotal_minor)}`, 'ltr');

  // Closing band.
  rule('=');
  text('شكرًا لتعاملكم معنا — Thank you', 'center');
  value(receiptWebsite(), 'center');
  rule('=');

  return bands;
}

/** Duplicate-copy marker band — topmost, reprint_duplicate only (§(b)). */
function composeDuplicateMarker(
  payload: ReceiptPayload,
  rule: (char: RuleBand['char']) => void,
  text: TextSink,
): void {
  if (payload.variant !== 'reprint_duplicate') return;
  rule('#');
  text('نسخة طبق الأصل', 'rtl', true);
  text('DUPLICATE COPY', 'center', true);
  if (payload.duplicate_copy_sequence_number !== undefined) {
    text(`Duplicate # ${String(payload.duplicate_copy_sequence_number)}`, 'center', true);
  }
  rule('#');
}

function composeItem(line: ReceiptLineItem, value: TextSink, text: TextSink): void {
  // v1 single-name composition: "{qty}× {name}" then the line subtotal.
  value(`${String(line.quantity)}× ${line.display_name}`, 'rtl');
  text(egp(line.line_subtotal_minor), 'ltr');
  if (line.discount !== undefined) composeLineDiscount(line.discount, text);
}

/** RT-856 (OD-28-11): the discount row's indent under its item. */
const DISCOUNT_INDENT = '   ';

/**
 * RT-856 (OD-28-11, doc 28 §5): one indented row under a discounted item, in
 * the item's two-band shape — «خصم 10%» (a percent shows its value; an amount
 * discount shows «خصم» alone), then the amount as a negative through
 * `money.ts` ("-9.00 EGP": ASCII hyphen-minus, one glyph on every codepage).
 */
function composeLineDiscount(discount: ReceiptLineDiscount, text: TextSink): void {
  const label = discount.kind === 'percent' ? `خصم ${String(discount.value)}%` : 'خصم';
  text(`${DISCOUNT_INDENT}${label}`, 'rtl');
  text(egp(-discount.amount_minor), 'ltr');
}

/** RT-856: one «إجمالي الخصم» row (Σ line discounts) above the total, when any line is discounted. */
function composeDiscountTotal(lines: readonly ReceiptLineItem[], text: TextSink): void {
  const discounted = lines.filter((line) => line.discount !== undefined);
  if (discounted.length === 0) return;
  const total = discounted.reduce((sum, line) => sum + (line.discount?.amount_minor ?? 0), 0);
  text('إجمالي الخصم', 'rtl');
  text(egp(-total), 'ltr');
}

/**
 * The payment section. RT-856 (OZ-1 = Z-A): a zero-total sale settles with no
 * tender, so it has no payment section at all. Only that case: a positive
 * total with an empty summary (a tender-unknown sale) keeps its section, as
 * before.
 */
function composeTenderBand(
  payload: Pick<ReceiptPayload, 'tender_lines_summary' | 'subtotal_minor'>,
  rule: (char: RuleBand['char']) => void,
  text: TextSink,
  value: TextSink,
): void {
  const tenders = payload.tender_lines_summary;
  if (tenders.length === 0 && payload.subtotal_minor === 0) return;
  rule('=');
  text('طريقة الدفع', 'rtl');
  rule('-');
  for (const t of tenders) {
    composeTender(t, text, value);
  }
}

function composeTender(t: TenderLineSummary, text: TextSink, value: TextSink): void {
  text(`${TENDER_LABELS[t.tender_type]}   ${egp(t.amount_applied_minor)}`, 'ltr');
  if (t.tender_type === 'cash' && t.change_due_minor !== undefined) {
    text(`Change due — الباقي   ${egp(t.change_due_minor)}`, 'ltr');
  }
  // Conditional reference fields (FR-017 / R-13): printed ONLY when the Sale
  // row carries them. These are the SOLE non-generic tender identifiers
  // allowed on the slip — the card external_reference (already ≤6-char
  // non-PAN, redacted upstream) and the voucher authority redemption id.
  if (t.external_reference !== undefined) {
    value(`Ref: ${t.external_reference}`, 'ltr');
  }
  if (t.voucher_authority_redemption_id !== undefined) {
    value(`Voucher ref: ${t.voucher_authority_redemption_id}`, 'ltr');
  }
}

// ── toHtml: mechanical serialiser ─────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replaceAll(/&/g, '&amp;')
    .replaceAll(/</g, '&lt;')
    .replaceAll(/>/g, '&gt;')
    .replaceAll(/"/g, '&quot;');
}

/** CSS `text-align` per band alignment (rtl bands sit on the right edge). */
const HTML_TEXT_ALIGN: Record<BandAlign, 'left' | 'center' | 'right'> = {
  ltr: 'left',
  center: 'center',
  rtl: 'right',
};

/** ESC/POS `ESC a n` argument per band alignment (0 left, 1 center, 2 right). */
const ESCPOS_ALIGN: Record<BandAlign, number> = { ltr: 0x00, center: 0x01, rtl: 0x02 };

function toHtml(bands: Band[]): string {
  const rows = bands.map((band) => {
    if (band.kind === 'rule') {
      return `<div class="rule">${band.char.repeat(COLS)}</div>`;
    }
    const dir = band.align === 'rtl' ? 'rtl' : 'ltr';
    const align = HTML_TEXT_ALIGN[band.align];
    const weight = band.emphasis === true ? ' receipt-emph' : '';
    return `<div class="band${weight}" dir="${dir}" style="text-align: ${align}">${escapeHtml(band.text)}</div>`;
  });
  return `<div class="receipt" dir="rtl">\n${rows.join('\n')}\n</div>`;
}

// ── toEscPos: mechanical serialiser ──────────────────────────────────────────

const ESC = 0x1b;
const GS = 0x1d;

function toEscPos(bands: Band[]): Uint8Array {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const push = (arr: number[]): void => {
    for (const b of arr) bytes.push(b);
  };
  const pushText = (s: string): void => {
    for (const b of encoder.encode(s)) bytes.push(b);
  };

  // Initialise printer (ESC @).
  push([ESC, 0x40]);

  for (const band of bands) {
    if (band.kind === 'rule') {
      // Left-align separators.
      push([ESC, 0x61, 0x00]);
      pushText(band.char.repeat(COLS));
      push([0x0a]);
      continue;
    }
    // Alignment: ESC a n  (0 left, 1 center, 2 right).
    push([ESC, 0x61, ESCPOS_ALIGN[band.align]]);
    // Emphasis: ESC E n (double-strike/bold).
    if (band.emphasis === true) push([ESC, 0x45, 0x01]);
    pushText(band.text);
    if (band.emphasis === true) push([ESC, 0x45, 0x00]);
    push([0x0a]);
  }

  // Feed + full cut (GS V 0).
  push([0x0a, 0x0a, GS, 0x56, 0x00]);
  return new Uint8Array(bytes);
}

// ── Public entry ──────────────────────────────────────────────────────────────

/** Serialise composed bands to both outputs (AD-6: one composition, two serialisers). */
export function renderBands(bands: Band[]): ReceiptRenderOutput {
  return { escpos: toEscPos(bands), html: toHtml(bands) };
}

/**
 * RT-542 — the receipt's bands, for a slip that adds bands after the receipt
 * (a returned sale's duplicate lists its returns) and serialises with
 * {@link renderBands}. Same composition as {@link renderReceipt}.
 */
export function composeReceiptBands(payload: ReceiptPayload): Band[] {
  return compose(payload);
}

export function renderReceipt(payload: ReceiptPayload): ReceiptRenderOutput {
  return renderBands(compose(payload));
}
