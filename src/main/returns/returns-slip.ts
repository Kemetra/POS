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
import { renderBands, utcStamp, type Band, type BandAlign } from '../receipts/template-engine.js';
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
const INDENT = '    ';
const CONTINUATION = COLS - INDENT.length;

/** Width in printed columns: code points, never UTF-16 units (astral = 1). */
function width(text: string): number {
  return Array.from(text).length;
}

/** A token longer than a continuation line, cut into pieces that fit. */
function splitToken(word: string): string[] {
  const chars = Array.from(word);
  if (chars.length <= CONTINUATION) return [word];
  const pieces: string[] = [];
  for (let i = 0; i < chars.length; i += CONTINUATION) {
    pieces.push(chars.slice(i, i + CONTINUATION).join(''));
  }
  return pieces;
}

/** Word-wrap to the roll by code points, with a hanging indent on continuations. */
function wrapColumns(text: string): string[] {
  const words = text
    .split(' ')
    .filter((w) => w !== '')
    .flatMap(splitToken);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    const indent = out.length === 0 ? 0 : INDENT.length;
    if (current !== '' && width(candidate) + indent > COLS) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') out.push(current);
  return out.map((line, i) => (i === 0 ? line : `${INDENT}${line}`));
}

/**
 * THE way any dynamic value reaches the slip (Codex P2, a1703dc): made
 * printable (control and bidi characters stripped), capped, a dash when
 * empty, then — after its static `label` — hard-wrapped to the 42-column
 * roll by code points. Every printed line fits; nothing is clipped.
 */
export function slipText(value: string | null | undefined, label = ''): string[] {
  const clean = value === null || value === undefined ? null : slipLineName(value);
  return wrapColumns(`${label}${clean ?? DASH}`);
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

  /** A dynamic value (after its static label), one band per wrapped line. */
  value(value: string | null | undefined, align: BandAlign, label = ''): void {
    for (const line of slipText(value, label)) this.text(line, align);
  }

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
  out.value(sale?.branchName, 'rtl');
  out.value(sale?.terminalLabel, 'ltr', 'Terminal: ');
  out.rule('-');
  out.text('إيصال مرتجع نقدي', 'rtl', true);
  out.text('CASH RETURN SLIP (non-fiscal)', 'center', true);
  out.rule('-');
  out.text('Return ref:', 'ltr');
  out.value(entry.returnRef, 'ltr');
  out.value(entry.saleNumber, 'ltr', 'Sale # ');
  out.text('Sale ref:', 'ltr');
  out.value(entry.serverSaleRef, 'ltr');
  out.value(payout.paidOperatorName, 'rtl', 'Paid by: ');
  out.text(stamp(payout.paidAt), 'ltr');
}

function lines(out: SlipBands, source: ReturnSlipSource): void {
  out.rule('=');
  out.text('الأصناف المرتجعة', 'rtl');
  out.rule('-');
  for (const line of source.lines) {
    out.value(line.lineName ?? UNNAMED_LINE, 'rtl', `${String(line.quantity)}× `);
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
