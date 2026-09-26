/**
 * Phase 9 / US7 — runtime config shape exposed to the renderer.
 *
 * The renderer cannot read `process.env` safely under sandbox. The
 * preload bridge calls `app:config` once at startup to learn its
 * runtime configuration, currently just the Sentry DSN.
 *
 * SECURITY: this shape is deliberately narrow. Only values the
 * renderer genuinely needs at runtime cross the bridge — never raw
 * env, never SecretStore values, never tokens fetched from the
 * platform. Each field added here MUST be reviewed for whether the
 * renderer truly needs it (Constitution III).
 */

export interface AppConfig {
  /**
   * Sentry DSN. Optional — when absent, Sentry stays inert in the
   * renderer (no `Sentry.init` call, no network traffic). Sourced
   * from `process.env.SENTRY_DSN` in main; never read in renderer.
   */
  sentryDsn?: string;
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
     * (Production Readiness Gates): in disabled state, 006 still settles
     * payments but 008's finalize listener short-circuits — no receipt
     * prints, no drawer kicks, no audit-event emits. The cashier falls
     * back to manual receipts. See `docs/runbook/008-sale-finalization-and-receipts.md`
     * (authored at Slice 6 T524 / T525) for the rollback path.
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
  };
}
