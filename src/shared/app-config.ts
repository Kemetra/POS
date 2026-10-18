/**
 * Phase 9 / US7 — runtime config shape exposed to the renderer.
 *
 * The renderer cannot read `process.env` safely under sandbox. The
 * preload bridge calls `app:config` once at startup to learn its
 * runtime configuration (the feature flags). RT-634: the Sentry DSN is
 * no longer part of it — renderer errors go to main over
 * `app:report-error`, and only main holds the DSN.
 *
 * SECURITY: this shape is deliberately narrow. Only values the
 * renderer genuinely needs at runtime cross the bridge — never raw
 * env, never SecretStore values, never tokens fetched from the
 * platform. Each field added here MUST be reviewed for whether the
 * renderer truly needs it (Constitution III).
 */

export interface AppConfig {
  /**
   * 005-sales-cart T001 — per-feature flag map.
   *
   * `cart` defaults to `false`. The renderer reads it once at boot and
   * conditionally mounts the Sale cart at /app/cart
   * (FR-033 / §A5). Enabling the flag is a per-tenant, per-branch
   * production decision — flipping it in dev is the only path to
   * exercise the cart UI surfaces until §A5 sign-off.
   *
   * SECURITY: feature flag values are non-sensitive boolean toggles.
   * Sourced from `POS_PULSE_FEATURE_CART` in main; the env var name is
   * the contract for ops scripts. Disabled-by-default is the fail-safe.
   */
  features?: {
    cart?: boolean;
    /**
     * 006-payments-tender S1 — enables PaymentSurface in the cart region.
     *
     * Defaults to `false`. Flip via `POS_PULSE_FEATURE_PAYMENTS` in main.
     */
    payments?: boolean;
    /**
     * 008-sale-finalization-and-receipts T002 — enables the 008 finalize
     * listener + receipts preview/print/reprint UI surfaces.
     *
     * Defaults to `false`. Flip via `POS_PULSE_FEATURE_SALE_FINALIZATION`
     * in main. Disabled-by-default is the fail-safe per Constitution
     * (Production Readiness Gates): in disabled state 008's finalize
     * listener short-circuits — no Sale row, receipt, drawer kick, outbox
     * entry or audit-event emit.
     *
     * RT-162 / D-1: `payments` on with this flag off is an INVALID cashier
     * profile — main refuses to start (`src/main/app/feature-flags.ts`)
     * rather than settle money it cannot record. The renderer may still see
     * `payments: true, saleFinalization: false` only in tests/historical
     * paths; its post-settlement truthfulness copy is kept for that case.
     * See `docs/runbook/008-sale-finalization-and-receipts.md` T525 for the
     * rollback path (both flags off).
     */
    saleFinalization?: boolean;
    /**
     * 009-product-search-and-barcode-lookup T049a — enables the catalogue
     * search/scan/confirm/add surface in the Cart workspace.
     *
     * Defaults to `false`. Flip via `POS_PULSE_FEATURE_PRODUCT_SEARCH` in main.
     * Fail-closed: disabled keeps the cart surface search-free. Independent of
     * the `cart` flag, but the surface mounts only when BOTH are on (it needs
     * the Sale cart present to receive added lines).
     */
    productSearch?: boolean;
    /**
     * RT-103 — enables the internal voucher tender tile at checkout.
     *
     * Defaults to `false`. Flip via `POS_PULSE_FEATURE_VOUCHER_TENDER` in main.
     * Fail-closed: vouchers are excluded from the pilot (RT-10 D2), so the tile
     * renders disabled and a voucher sale cannot be started. The sync side
     * (RT-79) still dead-letters any voucher-tendered sale regardless.
     */
    voucherTender?: boolean;
    /**
     * RT-15 S2 — enables the cashier return flow (`returns.*`).
     *
     * Defaults to `false` (AC1). Flip via `POS_PULSE_FEATURE_RETURNS` in main.
     * Fail-closed: with it off every `returns.*` call is refused
     * `feature_disabled` and nothing is journaled or sent. Backend-Core has
     * its own gate (`POS_RETURNS_ENABLED`, 404 while off).
     */
    returns?: boolean;
    /**
     * RT-17 slice 3 — enables the main-process shift cash-up service (open,
     * pay-in / pay-out, close) and starts the shift sync engine.
     *
     * Defaults to `false` (owner approval, Jira RT-17 comment 10920). Flip via
     * `POS_PULSE_FEATURE_SHIFT_CASHUP` in main. Fail-closed: with it off every
     * service call is refused `feature_disabled` and the engine is never
     * started. Stays off until the slice 4 UI and verification are done.
     */
    shiftCashup?: boolean;
    /**
     * RT-530 — enables the manager-approved void of a finalized sale
     * (`saleVoid.*`, the void screen and the queued-void notices).
     *
     * Defaults to `false`. Flip via `POS_PULSE_FEATURE_SALE_VOID` in main.
     * Fail-closed: with it off every `saleVoid.*` call is refused
     * `feature_disabled` and nothing is journaled or sent. Turn it on only
     * after Backend-Core's `sales.yaml` 1.8.0-draft void enforcement is
     * deployed: a void without it is refused by an older server.
     */
    saleVoid?: boolean;
    /**
     * RT-700 (P-26-1, OD-26-1 option A) — enables the external card terminal
     * tender at checkout.
     *
     * Defaults to `false`. Flip via `POS_PULSE_FEATURE_CARD_TENDER` in main.
     * Fail-closed: card is out of the pilot (RT-536 D4), so the «بطاقة» tile is
     * not rendered and main refuses a `tender.apply` with
     * `tender_type = external_card_terminal` as `card_tender_disabled`, audited
     * as `tender.refused`. `payments.start` is tender-neutral and unaffected.
     */
    cardTender?: boolean;
  };
}
