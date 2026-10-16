/**
 * T032 — 008 Slice 1b shared sale types.
 *
 * Closed enums + canonical types consumed by both the main process and the
 * renderer through `src/shared/bridge-api.ts`. Mirrors
 * `specs/008-sale-finalization-and-receipts/data-model.md §"Entity: Sale"` +
 * `contracts/bridge-api.md §"Namespace: sales.*"`.
 *
 * Constitution §VII (no leakage): only display-safe / structural values
 * appear here. The main-only fields explicitly excluded from the renderer
 * surface — `envelope_handoff_action_id`, `payment_attempt_id`,
 * `envelope_cart_id`, `tenant_tax_registration_id` — are NEVER typed here.
 * Pattern mirrors `src/shared/payments/types.ts` (006 S3b).
 *
 * **Closed-set discipline.** Each exported `as const` tuple drives a
 * derived union; tests assert exhaustive membership at runtime.
 */

// ── Branded primitives ───────────────────────────────────────────────────────

/**
 * Branded `string` for sale identifiers. Prevents accidentally passing a
 * raw string where a `SaleId` is expected. Cast via `'…' as SaleId` at
 * the trust boundary.
 */
export type SaleId = string & { readonly __brand: 'SaleId' };

/**
 * Branded `string` for the canonical sale-number format
 * `<terminal_label>-<YYYY-MM-DD>-<NNNNNN>` per AD-7. Treated as opaque by
 * the renderer; the main-side allocator is the only producer.
 */
export type SaleNumber = string & { readonly __brand: 'SaleNumber' };

// ── Tender-line summary (cached on Sale; FR-017 minimum) ─────────────────────

/**
 * The 3 tender types from 006 (per `src/shared/payments/types.ts`
 * TENDER_TYPES). Re-declared here narrowly so the 008 contract is
 * self-contained for the renderer; matching the 006 surface verbatim.
 */
export const SALES_TENDER_TYPES = ['cash', 'external_card_terminal', 'internal_voucher'] as const;
export type SalesTenderType = (typeof SALES_TENDER_TYPES)[number];

/**
 * Cached per-line summary carried on the Sale row + crossing the bridge to
 * the renderer (`sales.read` response). Per FR-017 + spec §"Sensitive-data
 * minimisation":
 *
 *   • `tender_type` + `amount_applied_minor` always present.
 *   • `change_due_minor` populated for cash lines ONLY (FR-017).
 *   • `external_reference` populated for external_card_terminal lines
 *     ONLY (006 OQ-PLAN-5 permissive resolution).
 *   • `voucher_authority_redemption_id` populated for internal_voucher
 *     lines ONLY (006 FR-017 / OQ-PLAN-7 permissive resolution).
 *
 * **NO voucher code. NO PAN. NO PIN record id. NO issuer name. NO
 * envelope_handoff_action_id.** Constitution §P6/§P7 + spec FR-071 +
 * 008 CR3 forbidden-fields.
 */
export interface TenderLineSummary {
  tender_type: SalesTenderType;
  amount_applied_minor: number;
  change_due_minor?: number;
  external_reference?: string;
  voucher_authority_redemption_id?: string;
}

// ── Print-event projection (latest by timestamp) ─────────────────────────────

export const PRINT_EVENT_OUTCOMES = ['success', 'failure', 'manual_override'] as const;
export type PrintEventOutcome = (typeof PRINT_EVENT_OUTCOMES)[number];

export const PRINT_EVENT_PURPOSES = ['first_print', 'reprint', 'retry_after_failure'] as const;
export type PrintEventPurpose = (typeof PRINT_EVENT_PURPOSES)[number];

/**
 * Latest PrintEvent projection — the renderer uses this to gate the
 * reprint affordance (AD-10) and to project the printer-failure banner.
 * NOT the full row; `failure_reason`, `previous_failed_print_event_ids`,
 * and `render_path` stay main-side per Constitution §P15 (minimised
 * state to renderer).
 */
export interface PrintEventSummary {
  print_event_id: string;
  outcome: PrintEventOutcome;
  purpose: PrintEventPurpose;
  printed_at: string;
  duplicate_copy_sequence_number?: number;
}

// ── Drawer-event projection (latest by timestamp) ────────────────────────────

export const DRAWER_EVENT_OUTCOMES = ['opened', 'suppressed', 'failed'] as const;
export type DrawerEventOutcome = (typeof DRAWER_EVENT_OUTCOMES)[number];

/**
 * Latest DrawerEvent projection. The renderer uses `outcome='failed'` to
 * project the drawer-failure banner. The full row (suppression_reason,
 * failure_reason, last_successful_open_at_for_terminal,
 * triggering_print_event_id) stays main-side until a UI surface
 * actually needs each field.
 */
export interface DrawerEventSummary {
  drawer_event_id: string;
  outcome: DrawerEventOutcome;
  attempted_at: string;
}

// ── Banner state (sales.subscribe topic='banner_state' projection) ───────────

/**
 * Printer-failure slice of `BannerState` — the sale whose own latest print
 * event is an unresolved `outcome='failure'`. Carries the fields
 * `<PrinterFailureBanner>` needs (Slice 3 / T290).
 */
export interface PrinterBannerFailure {
  sale_id: string;
  failure_reason: string;
  /** AD-10: whether the sale already has a prior successful print. */
  has_successful_print: boolean;
}

/**
 * Drawer-failure slice of `BannerState` — the sale whose own drawer event is
 * `outcome='failed'`. Carries `last_successful_open_at` for the banner's
 * relative-timestamp display (Slice 4 / T360); null when the terminal has no
 * prior successful drawer open on record. UTC ISO-8601.
 */
export interface DrawerBannerFailure {
  sale_id: string;
  last_successful_open_at: string | null;
}

/**
 * The renderer's persistent-banner projection for the current terminal.
 * Computed PER-SALE (never terminal-global-latest — that would silently mask
 * an older unresolved failure behind a newer sale's success; see coordination
 * §S3c projection rule): the terminal surfaces, per failure class, the
 * most-recently-finalized sale whose OWN latest print/drawer event is still an
 * unresolved failure.
 *
 * **Coexistence record, NOT a single-kind union** (Slice 4 decision, Ahmed
 * 2026-05-29): the printer-failure and drawer-failure banners can be on screen
 * AT THE SAME TIME (T330 / T361 / NFR-008). A single discriminated union could
 * only ever report ONE banner, so a printer failure would silently hide a
 * concurrent drawer failure. Each slice is projected and consumed
 * independently:
 *
 *   • `printer_failure: null`   — no unresolved print failure → no printer banner.
 *   • `printer_failure: {...}`   — `<PrinterFailureBanner>` mounts (`useBannerState`).
 *   • `drawer_failure: null`     — no unresolved drawer failure → no drawer banner.
 *   • `drawer_failure: {...}`     — `<DrawerFailureBanner>` mounts (`useDrawerBannerState`).
 *
 * `{ printer_failure: null, drawer_failure: null }` is the no-banner state.
 */
export interface BannerState {
  printer_failure: PrinterBannerFailure | null;
  drawer_failure: DrawerBannerFailure | null;
}

// ── Recent-sale summary (sales.subscribe topic='recent' projection) ──────────

/** Compact most-recent-finalized-sale summary (FR-046 "recent sale" UI). */
export interface RecentSaleSummary {
  sale_id: string;
  sale_number: string;
  finalized_at: string;
}

// ── Sale lines (RT-541 detail projection) ────────────────────────────────────

/**
 * One recorded line of a sale, from the frozen `sales.lines_json` snapshot
 * (008 T028a). Display fields only; snapshot bookkeeping (line_id, version,
 * last_action_id) stays main-side. Money is integer minor units.
 */
export interface SaleLineView {
  item_ref: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
  line_subtotal_minor: number;
  note: string | null;
}

/**
 * The lines of a sale, or why they cannot be shown (RT-541):
 *   • `recorded`     — the snapshot finalize wrote;
 *   • `not_recorded` — a sale finalized before migration 0028, whose column
 *     holds the default '[]': show "lines not recorded", never an empty sale;
 *   • `unreadable`   — the snapshot is present but malformed; nothing is guessed.
 */
export type SaleLinesView =
  | { state: 'recorded'; items: SaleLineView[] }
  | { state: 'not_recorded' }
  | { state: 'unreadable' };

// ── Local sales history (RT-541 `sales.list`) ────────────────────────────────

/** OD-534-4: at most 31 inclusive business days per query; wider is refused. */
export const SALES_LIST_MAX_SPAN_DAYS = 31;
/** OD-534-4: rows per page by default. */
export const SALES_LIST_DEFAULT_PAGE_SIZE = 50;
/** OD-534-4: the page-size cap. */
export const SALES_LIST_MAX_PAGE_SIZE = 100;

/**
 * What a history answer covers. The local SQLite holds this device's sales
 * only, so a local answer is always `this_device_only`: the screen must say
 * "this device only / incomplete store view" (RT-534 comment 12023).
 */
export type SalesHistoryCoverage = 'this_device_only';

// ── Refusal reason (closed enum — contract §"Refusal envelope") ──────────────

/**
 * The closed `reason` enum across all 008 sales.* + receipts.* handlers.
 * Per `contracts/bridge-api.md §"Refusal envelope"`. Adding a value here
 * requires also extending every exhaustive-switch consumer.
 *
 * The renderer translates each reason to **generic** copy (Constitution
 * §P11 — no factor-distinguishing variants). Per-reason diagnostic context
 * lives in the audit payload only.
 */
export const SALES_REFUSAL_REASONS = [
  'no_session',
  'role_denied',
  'tenant_isolation',
  'sale_not_found',
  'not_yet_printed',
  'idempotency_payload_mismatch',
  'printer_unavailable',
  'forbidden_field_in_request',
  // S1c.2 addition — mirrors 005's CartRefusalReason posture for the
  // sales.subscribe stub. The push-subscription primitive isn't yet
  // implemented; subscribe refuses with this reason until a follow-up
  // task lands the webContents.send + token registry.
  'not_implemented',
  // RT-541 `sales.list`: a malformed day, page size, cursor or key, or
  // to_day before from_day.
  'invalid_request',
  // RT-541 `sales.list`: more than SALES_LIST_MAX_SPAN_DAYS days (OD-534-4).
  'range_too_wide',
  // RT-542 `receipts.reprint`: the sale has a live void; OD-534-8 B allows no
  // unmarked duplicate of it.
  'sale_voided',
] as const;
export type SalesRefusalReason = (typeof SALES_REFUSAL_REASONS)[number];

// ── Finalization-internal refusal reason (main-side T091 vocabulary) ─────────

/**
 * Refusal reasons emitted by the AD-2 atomic finalize transaction
 * (`src/main/sales/finalize-transaction.ts`). These NEVER cross the bridge
 * to the renderer — they're audit-payload values only, recorded in the
 * `sale.finalization_refused` audit event per data-model.md §
 * "sale.finalization_refused payload".
 *
 * Distinct from `SALES_REFUSAL_REASONS` (above), which is the
 * bridge-handler refusal vocabulary visible to the renderer. The two
 * vocabularies are deliberately separate:
 *   • `SALES_REFUSAL_REASONS` covers session / role / tenant / not-found /
 *     reprint-precondition / IPC-input-defensive refusals — things the
 *     cashier sees as a generic refusal copy.
 *   • `SALE_FINALIZATION_REFUSAL_REASONS` covers source-006-attempt
 *     conditions + tender-summary forbidden-field hits — things the
 *     cashier never sees because the finalize is a background AD-2
 *     listener, not a renderer-initiated action.
 */
export const SALE_FINALIZATION_REFUSAL_REASONS = [
  'force_failed_attempt',
  'reversal_pending_line',
  'source_attempt_not_settled',
  'forbidden_field_in_tender_summary',
] as const;
export type SaleFinalizationRefusalReason = (typeof SALE_FINALIZATION_REFUSAL_REASONS)[number];
