/**
 * RT-542 — the slips a store-history reprint prints, composed as receipt bands
 * and serialised by the 008 template engine (`renderBands`), so they go through
 * the same print pipeline and path selection as every receipt.
 *
 *   • A DUPLICATE (OD-534-3) is the receipt template's own `reprint_duplicate`
 *     variant («نسخة طبق الأصل», the server copy number, the RT-249 N-S5 Cairo
 *     stamp). It is built from this terminal's own record when it made the sale,
 *     else from Backend-Core's recorded receipt facts, and only when every fact
 *     the original printed is recorded. A returned sale's duplicate is marked
 *     and lists its returns (OD-534-8 A).
 *   • A SALE RECORD is titled "sale record, not a receipt copy". A voided sale
 *     gets only this, marked VOIDED / ملغي (OD-534-8 B). Every block the record
 *     lacks says "not recorded"; a current name is labelled as such (OD-534-6).
 *
 * Server text is untrusted: control and bidi-override characters are stripped
 * before it reaches the printer. Pure: no clock, no I/O.
 */

import { parseWholeQuantity } from '../returns/returns-money.js';
import { slipLineName } from '../returns/returns-slip.js';
import { deriveReceiptPayload } from '../receipts/receipts-payload.js';
import { receiptLines as wrapValue } from '../receipts/receipt-text.js';
import {
  composeReceiptBands,
  storeStamp,
  type Band,
  type BandAlign,
} from '../receipts/template-engine.js';
import type { SaleRow } from '../sales/repositories/sales.repository.js';
import { format as formatMoney, of as moneyOf } from '../../shared/money.js';
import type { ReceiptLineItem, ReceiptPayload } from '../../shared/receipts/types.js';
import type { SaleId, SaleNumber, TenderLineSummary } from '../../shared/sales/types.js';
import type {
  SaleHistoryDetail,
  SaleHistoryNameSource,
  SaleHistoryReprintMark,
} from '../../shared/sale-history/types.js';

const NOT_RECORDED = 'not recorded — غير مسجل';

export interface SlipContext {
  readonly detail: SaleHistoryDetail;
  readonly copyNumber: number;
  readonly marks: readonly SaleHistoryReprintMark[];
  readonly printedAt: string;
}

class SlipBuilder {
  readonly bands: Band[] = [];

  text(value: string, align: BandAlign, emphasis = false): void {
    this.bands.push({ kind: 'text', text: value, align, emphasis });
  }

  /** A dynamic value (RT-828): wrapped to the 42-column roll, one band per printed line. */
  value(value: string, align: BandAlign, emphasis = false): void {
    for (const line of wrapValue(value)) this.text(line, align, emphasis);
  }

  rule(char: '=' | '-' | '#'): void {
    this.bands.push({ kind: 'rule', char });
  }
}

function egp(minor: number): string {
  return formatMoney(moneyOf(minor, 'EGP'));
}

/** Server text made printable; null when nothing printable is left. */
function clean(value: string | null): string | null {
  return value === null ? null : slipLineName(value);
}

function named(value: string | null, source: SaleHistoryNameSource): string {
  const text = clean(value);
  if (text === null || source === 'unavailable') return NOT_RECORDED;
  return source === 'current' ? `${text} (current name)` : text;
}

function lineName(name: string): string {
  return clean(name) ?? NOT_RECORDED;
}

// ── Duplicate ────────────────────────────────────────────────────────────────

function wholeOrNull(quantity: string): number | null {
  return parseWholeQuantity(quantity);
}

function receiptLines(detail: SaleHistoryDetail): ReceiptLineItem[] | null {
  const lines: ReceiptLineItem[] = [];
  const ordered = [...detail.lines].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  for (const line of ordered) {
    const quantity = wholeOrNull(line.quantity);
    if (quantity === null || line.sequence === null) return null;
    lines.push({
      item_ref: line.line_ref,
      display_name: lineName(line.name),
      quantity,
      unit_price_minor: line.unit_price_minor,
      line_subtotal_minor: line.line_minor,
      note: null,
    });
  }
  return lines;
}

/**
 * The tenders as the original receipt printed them, or null when they cannot be
 * rebuilt. Backend-Core records each tender net of change (`capture-payload`
 * sends `applied − change`), while the receipt printed the cash handed over:
 * the change goes back onto the last cash tender. Change with no cash tender
 * to carry it cannot be reproduced, so no duplicate is built.
 */
function receiptTenders(
  detail: SaleHistoryDetail,
  changeMinor: number,
): TenderLineSummary[] | null {
  const ordered = [...detail.tenders].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const lastCash = ordered.map((t) => t.method).lastIndexOf('cash');
  if (lastCash === -1 && changeMinor > 0) return null;
  return ordered.map((tender, index) => ({
    tender_type: tender.method === 'cash' ? 'cash' : 'external_card_terminal',
    amount_applied_minor:
      index === lastCash ? tender.amount_minor + changeMinor : tender.amount_minor,
    ...(index === lastCash ? { change_due_minor: changeMinor } : {}),
    ...(tender.reference === null ? {} : { external_reference: lineName(tender.reference) }),
  }));
}

/** Every receipt fact a true duplicate needs, or null when any is missing. */
function recordedFacts(detail: SaleHistoryDetail) {
  const { summary, receipt_header: header } = detail;
  const complete =
    detail.receipt_facts === 'complete' &&
    detail.tender_state === 'recorded' &&
    summary.device_label_source === 'snapshot' &&
    summary.operator_name_source === 'snapshot';
  const values = {
    header,
    saleNumber: clean(summary.sale_number),
    receiptNumber: clean(detail.receipt_number),
    terminal: clean(summary.device_label),
    operator: clean(summary.operator_display_name),
    settledAt: detail.settled_at,
    change: detail.change_minor,
  };
  if (!complete || Object.values(values).includes(null)) return null;
  return values as { [K in keyof typeof values]: NonNullable<(typeof values)[K]> };
}

/**
 * A duplicate built from Backend-Core's recorded receipt facts, or null when a
 * fact the original printed is not recorded (then only a sale record prints).
 */
export function duplicateFromDetail(
  detail: SaleHistoryDetail,
  copyNumber: number,
  reprintedAt: string,
): ReceiptPayload | null {
  const facts = recordedFacts(detail);
  const lines = receiptLines(detail);
  if (facts === null || lines === null) return null;
  const tenders = receiptTenders(detail, facts.change);
  if (tenders === null) return null;
  // The VAT block is a receipt fact: never print a duplicate over unrecorded tax.
  if (detail.lines.some((line) => line.tax_minor === null)) return null;
  const subtotal = detail.summary.total_minor;
  // Fail closed: the printed lines must add up to the recorded total.
  if (lines.reduce((sum, line) => sum + line.line_subtotal_minor, 0) !== subtotal) return null;
  const tax = detail.lines.reduce((sum, line) => sum + (line.tax_minor ?? 0), 0);
  return {
    variant: 'reprint_duplicate',
    duplicate_copy_sequence_number: copyNumber,
    reprinted_at: reprintedAt,
    sale_id: detail.summary.sale_ref as SaleId,
    sale_number: facts.saleNumber as SaleNumber,
    receipt_number: facts.receiptNumber,
    tenant_tax_registration_id: lineName(facts.header.tax_registration_id),
    branch_name: lineName(facts.header.branch_name),
    branch_address: lineName(facts.header.branch_address),
    terminal_label: facts.terminal,
    selling_operator_display_name: facts.operator,
    subtotal_minor: subtotal,
    total_tax_minor: tax,
    total_change_due_minor: facts.change,
    lines,
    tender_lines_summary: tenders,
    settled_at: facts.settledAt,
    finalized_at: detail.summary.occurred_at,
    local_calendar_day: detail.summary.business_day,
  };
}

/** A duplicate from this terminal's own record, or null when it cannot be read. */
export function duplicateFromLocal(
  row: SaleRow,
  copyNumber: number,
  reprintedAt: string,
): ReceiptPayload | null {
  try {
    return deriveReceiptPayload(row, {
      variant: 'reprint_duplicate',
      duplicate_copy_sequence_number: copyNumber,
      reprinted_at: reprintedAt,
    });
  } catch {
    return null;
  }
}

// ── Marks and returns ────────────────────────────────────────────────────────

function markBands(slip: SlipBuilder, ctx: SlipContext): void {
  if (ctx.marks.includes('voided')) {
    slip.text('ملغي', 'rtl', true);
    slip.text('VOIDED', 'center', true);
    const voidedAt = ctx.detail.void?.voided_at;
    if (voidedAt !== undefined) slip.text(`Voided: ${storeStamp(voidedAt)}`, 'ltr');
  }
  if (ctx.marks.includes('returned')) {
    slip.text('مرتجع', 'rtl', true);
    slip.text('RETURNED', 'center', true);
  }
}

function returnsBands(slip: SlipBuilder, detail: SaleHistoryDetail): void {
  if (detail.returns.length === 0) return;
  const names = new Map(detail.lines.map((line) => [line.line_ref, lineName(line.name)]));
  slip.rule('=');
  slip.text('المرتجعات — RETURNS', 'center', true);
  slip.rule('-');
  for (const entry of detail.returns) {
    slip.text(`Returned: ${storeStamp(entry.recorded_at)}`, 'ltr');
    for (const line of entry.lines) {
      slip.value(`${line.quantity}× ${names.get(line.line_ref) ?? NOT_RECORDED}`, 'rtl');
      slip.text(egp(line.line_minor), 'ltr');
    }
    slip.text(`Return total: ${egp(entry.total_minor)}`, 'ltr');
  }
}

/** The duplicate's bands, with the returned mark and the returns when recorded. */
export function duplicateBands(payload: ReceiptPayload, ctx: SlipContext): Band[] {
  const slip = new SlipBuilder();
  slip.bands.push(...composeReceiptBands(payload));
  if (ctx.marks.length === 0) return slip.bands;
  slip.rule('#');
  markBands(slip, ctx);
  returnsBands(slip, ctx.detail);
  slip.rule('#');
  return slip.bands;
}

// ── Sale record ──────────────────────────────────────────────────────────────

function recordHeader(slip: SlipBuilder, ctx: SlipContext): void {
  const { detail } = ctx;
  slip.rule('#');
  slip.text('سجل بيع — ليس نسخة من الإيصال', 'rtl', true);
  slip.text('SALE RECORD — NOT A RECEIPT COPY', 'center', true);
  markBands(slip, ctx);
  slip.text(`Copy # ${String(ctx.copyNumber)}`, 'center', true);
  slip.rule('#');
  const header = detail.receipt_header;
  slip.value(header === null ? `Branch: ${NOT_RECORDED}` : lineName(header.branch_name), 'rtl');
  slip.rule('-');
  slip.value(`Sale # ${clean(detail.summary.sale_number) ?? NOT_RECORDED}`, 'ltr', true);
  slip.value(
    `Terminal: ${named(detail.summary.device_label, detail.summary.device_label_source)}`,
    'ltr',
  );
  slip.value(
    `Cashier: ${named(detail.summary.operator_display_name, detail.summary.operator_name_source)}`,
    'rtl',
  );
  slip.text(`Sale time: ${storeStamp(detail.settled_at ?? detail.summary.occurred_at)}`, 'ltr');
  slip.text(`Printed: ${storeStamp(ctx.printedAt)}`, 'ltr');
}

function recordItems(slip: SlipBuilder, detail: SaleHistoryDetail): void {
  slip.rule('=');
  slip.text('العناصر', 'rtl');
  if (detail.line_order === 'not_recorded') slip.text(`Line order: ${NOT_RECORDED}`, 'ltr');
  slip.rule('-');
  for (const line of detail.lines) {
    slip.value(`${line.quantity}× ${lineName(line.name)}`, 'rtl');
    slip.text(egp(line.line_minor), 'ltr');
  }
  slip.rule('-');
  slip.text(`Total: ${egp(detail.summary.total_minor)}`, 'ltr', true);
}

function recordTenders(slip: SlipBuilder, detail: SaleHistoryDetail): void {
  slip.rule('=');
  slip.text('طريقة الدفع', 'rtl');
  slip.rule('-');
  if (detail.tender_state === 'unknown') {
    slip.text(`Payment: ${NOT_RECORDED}`, 'ltr');
    return;
  }
  for (const tender of detail.tenders) {
    const label = tender.method === 'cash' ? 'Cash — نقدي' : 'Card — بطاقة';
    slip.text(`${label}   ${egp(tender.amount_minor)}`, 'ltr');
  }
  const change = detail.change_minor;
  slip.text(`Change — الباقي   ${change === null ? NOT_RECORDED : egp(change)}`, 'ltr');
}

/** The sale-record slip: never a receipt copy, never a tax document. */
export function saleRecordBands(ctx: SlipContext): Band[] {
  const slip = new SlipBuilder();
  recordHeader(slip, ctx);
  recordItems(slip, ctx.detail);
  recordTenders(slip, ctx.detail);
  returnsBands(slip, ctx.detail);
  slip.rule('=');
  slip.text('سجل للمراجعة فقط — ليس إيصالاً', 'center');
  slip.text('For review only — not a receipt', 'center');
  slip.rule('=');
  return slip.bands;
}
