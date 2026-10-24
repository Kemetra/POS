/**
 * T033 — 008 Slice 1b shared receipt-payload types.
 *
 * The `ReceiptPayload` shape consumed by the template engine (T160 in
 * Slice 2) and projected over the bridge by `receipts.preview` (Slice 2
 * onward). Mirrors `specs/008-sale-finalization-and-receipts/spec.md
 * §FR-017` (canonical receipt fields) and `data-model.md §"Entity: Sale"`
 * (the persisted source from which the payload is derived).
 *
 * **Byte-stability commitment (AD-6).** The payload is the SINGLE source
 * for both the ESC/POS byte stream and the HTML/canvas preview render.
 * Adding a preview-only branch in any consumer is forbidden — the
 * template engine reads this struct and emits BOTH outputs from one
 * composition pass.
 *
 * **Sensitive-data exclusion.** This module declares ONLY the
 * non-sensitive fields. PAN, voucher codes, voucher PII, PIN record ids,
 * issuer names are forbidden per FR-070 / FR-071 / CR3 / Constitution
 * §P6 / §P7.
 */

import type { SaleId, SaleNumber, TenderLineSummary } from '../sales/types.js';
import type { ReceiptLineDiscount } from '../sales/sale-line-discount.js';

// ── Template variant (closed-set) ────────────────────────────────────────────

/**
 * The 3 template variants in 008 v1. Per spec §FR-017 + the §A1 sign-off
 * sub-items in `specs/008-sale-finalization-and-receipts/visual-direction/README.md`:
 *
 *   • `first_print`       — the original receipt; no duplicate-copy marker.
 *   • `reprint_duplicate` — carries the bilingual duplicate-copy marker
 *                           (FR-029) + the duplicate-copy sequence number
 *                           (FR-031) + the reprint timestamp.
 *   • `preview`           — byte-equal to (a) `first_print` content (or to
 *                           (b) `reprint_duplicate` content if the sale has
 *                           ≥ 1 successful print event); rendered to the
 *                           canvas in the `<ReceiptPreview>` UI panel.
 */
export const RECEIPT_TEMPLATE_VARIANTS = ['first_print', 'reprint_duplicate', 'preview'] as const;
export type ReceiptTemplateVariant = (typeof RECEIPT_TEMPLATE_VARIANTS)[number];

// ── Receipt line item (the itemised slip body; FR-017) ───────────────────────

/**
 * One item line on the printed slip body, derived from the Sale row's
 * `lines_json` snapshot (the frozen `LineSnapshot[]` captured at finalize per
 * T028a). Carries ONLY the non-sensitive display fields the §(a) layout
 * renders.
 *
 * **v1 single-name note (Ahmed 2026-05-28):** the durable cart snapshot carries
 * a single `display_name` per line — there is no `name_ar`/`name_en` split in
 * 005's cart schema (catalogue integration is a stub). So v1 renders one name
 * line per item; the bilingual two-name composition in the §(a) layout
 * (decision 8) is a v2 item pending catalogue integration. See
 * slice2-mapping-pass.md.
 */
export interface ReceiptLineItem {
  item_ref: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
  /** The line GROSS (`quantity × unit_price_minor`). */
  line_subtotal_minor: number;
  note: string | null;
  /**
   * RT-856 (OD-28-11): the line's manual discount, from the frozen
   * `lines_json`. Only kind, value and amount: no placeholder, reason or
   * approver reaches the slip or the preview bridge. Absent when undiscounted.
   */
  discount?: ReceiptLineDiscount;
}

// ── ReceiptPayload (FR-017 canonical fields) ─────────────────────────────────

/**
 * The canonical receipt payload struct. The template engine (T160) takes
 * this as input and emits both ESC/POS bytes and HTML/canvas raster.
 *
 * Fields are sourced from the persisted Sale row (per `data-model.md
 * §"Entity: Sale"`) + the latest PrintEvent / DrawerEvent projections
 * for variants that reference them.
 *
 * Per spec §"Sensitive-data minimisation": NO voucher code, NO PAN, NO
 * PII beyond `selling_operator_display_name`, NO main-only fields
 * (envelope_handoff_action_id, payment_attempt_id, envelope_cart_id).
 */
export interface ReceiptPayload {
  // ── Variant + reprint-only fields ───────────────────────────────────────
  variant: ReceiptTemplateVariant;
  /**
   * 1 for the first reprint of a sale, 2 for the second, etc. Required
   * when `variant === 'reprint_duplicate'`. NULL/undefined otherwise.
   */
  duplicate_copy_sequence_number?: number;
  /**
   * ISO-8601 UTC timestamp of the reprint event. Required when
   * `variant === 'reprint_duplicate'`. NULL/undefined otherwise.
   */
  reprinted_at?: string;

  // ── Identity ────────────────────────────────────────────────────────────
  sale_id: SaleId;
  sale_number: SaleNumber;
  receipt_number: string;

  // ── Pharmacy / tenant header (cached from terminal config; FR-017) ─────
  tenant_tax_registration_id: string;
  branch_name: string;
  branch_address: string;
  terminal_label: string;

  // ── Operator attribution (FR-013 / FR-014 / FR-024) ────────────────────
  selling_operator_display_name: string;

  // ── Monetary totals (INTEGER minor units; Constitution §II) ────────────
  /** The Sale's `subtotal_minor`: the NET charged before tax since RT-854 / RT-856. */
  subtotal_minor: number;
  total_tax_minor: number;
  total_change_due_minor: number;

  // ── Itemised body (FR-017; derived from the Sale row's lines_json) ──────
  lines: readonly ReceiptLineItem[];

  // ── Tender breakdown (non-sensitive only; FR-017) ──────────────────────
  tender_lines_summary: TenderLineSummary[];

  // ── Timestamps (FR-017 + Constitution Localization) ────────────────────
  settled_at: string;
  finalized_at: string;
  local_calendar_day: string;
}
