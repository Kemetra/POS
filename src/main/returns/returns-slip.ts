/**
 * RT-15 S4 — the non-fiscal cash return slip (AC12).
 *
 * Composed as receipt bands and serialised by the 008 template engine
 * (`renderBands`: one composition, ESC/POS + HTML), then printed through the
 * same print pipeline as a sale receipt. No new printer path.
 *
 * Content: branch, terminal, return ref, sale number, sale ref, each returned
 * line (name x quantity, refund amount), the server-confirmed cash total, the
 * paying operator's display name and the paid-at time. A reprint is marked as
 * a copy with its own time.
 *
 * Never on the slip: the externalId (Idempotency-Key), the request body, the
 * operator envelope, operator or session ids, tenant/branch ids, customer data.
 * Pure: no clock, no I/O.
 */
import {
  renderBands,
  utcStamp,
  wrap,
  type Band,
  type BandAlign,
} from '../receipts/template-engine.js';
import type { RenderedReceipt } from '../receipts/print-pipeline.js';
import { exponentFor, minorUnitsToDecimalString } from '../sales-sync/create-sale-sync-client.js';
import type { PayoutRow, SlipLine } from './returns-payout-repository.js';
import type { JournalEntry } from './returns-repository.js';

/** Longest line name kept for the slip (0040 CHECK). */
export const SLIP_LINE_NAME_MAX = 120;

/** Control characters and bidi embeddings/overrides/isolates (no reordering tricks). */
const UNPRINTABLE = /[\p{Cc}‪-‮⁦-⁩]/gu;

/** A server line name made safe to print, or null when nothing printable remains. */
export function slipLineName(raw: string): string | null {
  const clean = raw.replace(UNPRINTABLE, '').trim();
  if (clean === '') return null;
  return Array.from(clean).slice(0, SLIP_LINE_NAME_MAX).join('');
}

/**
 * The slip's lines add up to the refund (reviewer P2-4). Confirmation already
 * requires the server total to equal the quote exactly (S2), and the lines
 * are the quote's own amounts, so this always holds unless something is
 * wrong: then no slip is printed (fail closed). A return journaled before
 * 0040 has no line amounts and prints quantities with the total.
 */
export function slipTotalsAgree(lines: readonly SlipLine[], totalMinor: number): boolean {
  if (lines.length === 0) return false;
  const amounts = lines.map((l) => l.amountMinor);
  if (amounts.every((a) => a === null)) return true;
  if (amounts.some((a) => a === null)) return false;
  return (amounts as number[]).reduce((sum, a) => sum + a, 0) === totalMinor;
}

/** The sale header facts the slip reuses (same terminal as the sale, D-d). */
export interface SlipSaleHeader {
  readonly branchName: string;
  readonly terminalLabel: string;
}

export interface ReturnSlipSource {
  readonly entry: JournalEntry;
  /** The completed payout. */
  readonly payout: PayoutRow;
  readonly lines: readonly SlipLine[];
  /** Null when the sale row cannot be read (the slip prints dashes). */
  readonly sale: SlipSaleHeader | null;
}

export type ReturnSlipVariant =
  | { readonly kind: 'original' }
  | { readonly kind: 'copy'; readonly reprintedAt: string };

const DASH = '—';
const UNNAMED_LINE = 'صنف مرتجع';

/** The receipt's column width, and what a wrapped continuation line can hold. */
const COLS = 42;
const CONTINUATION = COLS - 4;

/**
 * Split any token longer than a continuation line into pieces that fit, so
 * the shared word-wrap (which only breaks at spaces) never emits a line
 * wider than the roll. Code points, never UTF-16 halves.
 */
function breakLongTokens(text: string): string {
  return text
    .split(' ')
    .map((word) => {
      const chars = Array.from(word);
      if (chars.length <= CONTINUATION) return word;
      const pieces: string[] = [];
      for (let i = 0; i < chars.length; i += CONTINUATION) {
        pieces.push(chars.slice(i, i + CONTINUATION).join(''));
      }
      return pieces.join(' ');
    })
    .join(' ');
}

/** A fact, or a dash when it is not known. */
function orDash(value: string | null | undefined): string {
  return value ?? DASH;
}

/** A stored ISO time as the receipt prints it (UTC), or a dash. */
function stamp(iso: string | null): string {
  return iso === null ? DASH : utcStamp(iso);
}

function money(minor: number, currencyCode: string): string {
  return `${minorUnitsToDecimalString(minor, exponentFor(currencyCode))} ${currencyCode}`;
}

class SlipBands {
  readonly bands: Band[] = [];

  rule(char: '=' | '-' | '#'): void {
    this.bands.push({ kind: 'rule', char });
  }

  text(text: string, align: BandAlign, emphasis = false): void {
    this.bands.push({ kind: 'text', text, align, emphasis });
  }
}

function copyMarker(out: SlipBands, variant: ReturnSlipVariant): void {
  if (variant.kind !== 'copy') return;
  out.rule('#');
  out.text('نسخة — COPY', 'center', true);
  out.text(`Reprinted: ${utcStamp(variant.reprintedAt)}`, 'ltr');
  out.rule('#');
}

function header(out: SlipBands, source: ReturnSlipSource): void {
  const { entry, payout, sale } = source;
  out.rule('=');
  out.text(orDash(sale?.branchName), 'rtl');
  out.text(`Terminal: ${orDash(sale?.terminalLabel)}`, 'ltr');
  out.rule('-');
  out.text('إيصال مرتجع نقدي', 'rtl', true);
  out.text('CASH RETURN SLIP (non-fiscal)', 'center', true);
  out.rule('-');
  out.text('Return ref:', 'ltr');
  out.text(orDash(entry.returnRef), 'ltr');
  out.text(`Sale # ${entry.saleNumber}`, 'ltr', true);
  out.text('Sale ref:', 'ltr');
  out.text(entry.serverSaleRef, 'ltr');
  out.text(`Paid by: ${orDash(payout.paidOperatorName)}`, 'rtl');
  out.text(stamp(payout.paidAt), 'ltr');
}

function lines(out: SlipBands, source: ReturnSlipSource): void {
  out.rule('=');
  out.text('الأصناف المرتجعة', 'rtl');
  out.rule('-');
  for (const line of source.lines) {
    const label = `${String(line.quantity)}× ${breakLongTokens(line.lineName ?? UNNAMED_LINE)}`;
    for (const part of wrap(label)) {
      out.text(part, 'rtl');
    }
    const amount =
      line.amountMinor === null ? DASH : money(line.amountMinor, source.entry.currencyCode);
    out.text(amount, 'ltr');
  }
}

function total(out: SlipBands, entry: JournalEntry): void {
  out.rule('-');
  const totalMinor = entry.returnTotalMinor ?? entry.quotedTotalMinor;
  out.text(`Refund total (cash): ${money(totalMinor, entry.currencyCode)}`, 'ltr', true);
  out.text('طريقة الصرف: نقدًا — Cash', 'rtl');
  out.rule('=');
}

/** The slip for a paid-out return, as both serialised outputs. */
export function renderReturnSlip(
  source: ReturnSlipSource,
  variant: ReturnSlipVariant,
): RenderedReceipt {
  const out = new SlipBands();
  copyMarker(out, variant);
  header(out, source);
  lines(out, source);
  total(out, source.entry);
  return renderBands(out.bands);
}
