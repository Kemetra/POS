/**
 * T164 — derive the canonical `ReceiptPayload` from a persisted Sale row.
 *
 * The single seam between durable storage and the AD-6 template engine
 * (T160). Reads ONLY the `sales` row passed in — never re-reads `cart_lines`,
 * never calls the catalogue API, never re-validates a voucher (FR-015). The
 * itemised body comes from parsing the row's `lines_json` snapshot (the frozen
 * `LineSnapshot[]` captured at finalize per T028a); the tender breakdown from
 * `tender_lines_summary_json`.
 *
 * Pure function: the same row + opts always yield a deeply-equal payload, which
 * is the foundation of the FR-016 byte-stability guarantee the engine builds on.
 *
 * v1 decisions (Ahmed 2026-05-28, slice2-mapping-pass.md):
 *   • single `display_name` per line (the durable snapshot has no name_ar/en
 *     split — bilingual is a v2 item pending catalogue integration);
 *   • no shift line (the sales row carries no shift link — v2 item).
 */

import type { SaleRow } from '../sales/repositories/sales.repository.js';
// The shape of one `lines_json` element, shared with the sale detail (RT-541).
import type { LineSnapshotJson } from '../sales/sale-lines.js';
import type {
  ReceiptPayload,
  ReceiptLineItem,
  ReceiptTemplateVariant,
} from '../../shared/receipts/types.js';
import type { SaleId, SaleNumber, TenderLineSummary } from '../../shared/sales/types.js';

export interface DeriveReceiptPayloadOptions {
  variant: ReceiptTemplateVariant;
  /** Required when `variant === 'reprint_duplicate'`. */
  duplicate_copy_sequence_number?: number;
  /** Required when `variant === 'reprint_duplicate'`. ISO-8601 UTC. */
  reprinted_at?: string;
}

/**
 * Thrown when a persisted JSON column on the Sale row is structurally
 * unparseable. The Sale row's JSON is always engine-written
 * (`JSON.stringify`), so this is defence-in-depth — but `receipts.preview` is
 * renderer-facing, so a corrupt row must surface as a controlled failure the
 * bridge can map to a refusal, never an unstructured throw across IPC.
 */
export class ReceiptPayloadDerivationError extends Error {
  constructor(field: string, options?: { cause?: unknown }) {
    super(`deriveReceiptPayload: invalid ${field}`, options);
    this.name = 'ReceiptPayloadDerivationError';
  }
}

function parseJsonArray<T>(raw: string, field: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ReceiptPayloadDerivationError(field, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new ReceiptPayloadDerivationError(field);
  }
  return parsed as T[];
}

export function deriveReceiptPayload(
  row: SaleRow,
  opts: DeriveReceiptPayloadOptions,
): ReceiptPayload {
  const snapshot = parseJsonArray<LineSnapshotJson>(row.lines_json, 'lines_json');
  const lines: ReceiptLineItem[] = snapshot.map((l) => ({
    item_ref: l.item_ref,
    display_name: l.display_name,
    quantity: l.quantity,
    unit_price_minor: l.unit_price_minor,
    line_subtotal_minor: l.line_subtotal_minor,
    note: l.note,
  }));

  const tender_lines_summary = parseJsonArray<TenderLineSummary>(
    row.tender_lines_summary_json,
    'tender_lines_summary_json',
  );

  const payload: ReceiptPayload = {
    variant: opts.variant,
    sale_id: row.sale_id as SaleId,
    sale_number: row.sale_number as SaleNumber,
    receipt_number: row.receipt_number,
    tenant_tax_registration_id: row.tenant_tax_registration_id,
    branch_name: row.branch_name,
    branch_address: row.branch_address,
    terminal_label: row.terminal_label,
    selling_operator_display_name: row.selling_operator_display_name,
    subtotal_minor: row.subtotal_minor,
    total_tax_minor: row.total_tax_minor,
    total_change_due_minor: row.total_change_due_minor,
    lines,
    tender_lines_summary,
    settled_at: row.settled_at,
    finalized_at: row.finalized_at,
    local_calendar_day: row.local_calendar_day,
  };

  if (opts.variant === 'reprint_duplicate') {
    if (opts.duplicate_copy_sequence_number !== undefined) {
      payload.duplicate_copy_sequence_number = opts.duplicate_copy_sequence_number;
    }
    if (opts.reprinted_at !== undefined) {
      payload.reprinted_at = opts.reprinted_at;
    }
  }

  return payload;
}
