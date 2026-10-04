/**
 * 009-product-search-and-barcode-lookup T015 — `catalogue.*` bridge skeleton.
 *
 * The renderer-facing trust boundary for product lookup (read-only; AD-2 — no
 * insert/update/delete handler exists). Four handlers:
 *
 *   • `catalogue.lookupBarcode({ barcode })` — exact barcode lookup (FR-4).
 *   • `catalogue.lookupSku({ sku })`         — exact SKU lookup (FR-9).
 *   • `catalogue.search({ query })`          — folded substring search (FR-11/12/13).
 *   • `catalogue.resolve({ product_id })`    — resolve to confirm-and-add snapshot.
 *
 * Slice S1 ships the SKELETON only: every handler's first step is the session
 * gate (`requireCatalogueSession`, NFR-6a), then returns the honest
 * `catalogue_unavailable` stub — the read model is not wired until S2, so the
 * catalogue genuinely IS unavailable. The real lookup/search/resolve logic
 * lands in S2 (exact lookup + repo, §A2), S3 (folded search, §A2), and S4
 * (resolve + 005 seam wiring, §A1). Mirrors the `createSalesBridge` factory
 * discipline (008): DI'd `getCurrentSession`, discriminated-union responses
 * that never throw, generic refusals.
 */

import type {
  CatalogueBridgeAPI,
  CatalogueLookupBarcodeRequest,
  CatalogueLookupSkuRequest,
  CatalogueLookupResponse,
  CatalogueSearchRequest,
  CatalogueSearchResponse,
  CatalogueResolveResponse,
  CatalogueRefreshResponse,
  CatalogueFreshnessResponse,
  CatalogueCountsResponse,
} from '../../shared/bridge-api.js';
import {
  requireCatalogueSession,
  type OperatorSessionForCatalogue,
} from './require-catalogue-session.js';
import type { ProductLookupResult, ProductRepo, ProductSearchResult } from './product-repo.js';
import type { ReadDownDriver } from './read-down/read-down-driver.js';
import type { CatalogueSyncStateRow } from './catalogue-sync-state-repo.js';
import { normalize } from './normalize.js';

export type CatalogueBridge = CatalogueBridgeAPI;

/** Minimum NORMALIZED query length for a name search (FR-16). */
const MIN_SEARCH_LENGTH = 2;

/**
 * 010 — the tenant-scoped freshness read source for `catalogue.freshness`
 * (§A4 RD-1 / P17-1). A pure read of secret-free state: the sync-state row
 * (timestamps + opaque snapshot id only — §A2 §8) and a tenant-scoped live
 * `products`-has-rows check (`is_empty`). Both MUST filter the session tenant.
 */
export interface CatalogueFreshnessSource {
  /** The session tenant's sync-state row, or null if no read-down ever ran. */
  readSyncState(tenantId: string): CatalogueSyncStateRow | null;
  /** The session tenant's live product count (for the `is_empty` discriminator). */
  countProducts(tenantId: string): number;
  /**
   * The session tenant's live product_barcodes (alias) count — diagnostics only.
   * Optional so existing freshness-only sources stay valid; `counts` refuses if
   * the source cannot supply it.
   */
  countBarcodes?(tenantId: string): number;
}

export interface CatalogueBridgeDependencies {
  /** The current operator session, or null when none is active (NFR-6a gate). */
  getCurrentSession: () => OperatorSessionForCatalogue | null;
  /**
   * The read-only product repo (S2). Tenant scoping flows through the session's
   * `tenant_id` into the repo's `WHERE tenant_id = ?` (P17). Optional: when
   * absent (the S1 skeleton), every lookup returns the honest
   * `catalogue_unavailable` stub — the read model is genuinely not wired.
   * `search` / `resolve` remain stubs until S3 / S4.
   */
  productRepo?: ProductRepo;
  /**
   * 010 — the read-down driver behind `catalogue.refresh`. The bridge only ever
   * ADMITS a tick (`runTickOnce`) — it never starts/stops the interval (that is
   * the composition root's job, T039) — so it depends on just that method, not
   * the full driver (minimal-coupling). Optional: when absent (e.g. the
   * live-client wiring is deferred on #349), `refresh` refuses rather than claim
   * a tick it cannot start (P9-2 — no fake "done").
   */
  readDownDriver?: Pick<ReadDownDriver, 'runTickOnce'>;
  /**
   * RT-202 — resolves the driver at call time, for a terminal that pairs
   * in-process: the driver does not exist when the bridge is built, and exists
   * once the paired-only workers have started. Takes precedence over
   * `readDownDriver` when it returns one; `undefined` still refuses.
   */
  getReadDownDriver?: () => Pick<ReadDownDriver, 'runTickOnce'> | undefined;
  /**
   * 010 — the tenant-scoped freshness source behind `catalogue.freshness`.
   * Optional: when absent, `freshness` refuses (it cannot read truthfully) — it
   * never throws or leaks (IPC-1).
   */
  freshness?: CatalogueFreshnessSource;
}

/** Map the repo's discriminated result to the bridge lookup response. */
function lookupResultToResponse(result: ProductLookupResult): CatalogueLookupResponse {
  switch (result.kind) {
    case 'one':
      return { kind: 'one', product: result.product };
    case 'not_found':
      return { kind: 'not_found' };
    case 'ambiguous':
      return { kind: 'ambiguous' };
    case 'unavailable':
      return { kind: 'catalogue_unavailable' };
  }
}

/** Map the repo's search result to the bridge search response. */
function searchResultToResponse(result: ProductSearchResult): CatalogueSearchResponse {
  switch (result.kind) {
    case 'results':
      return { kind: 'results', items: result.items, truncated: result.truncated };
    case 'not_found':
      return { kind: 'not_found' };
    case 'unavailable':
      return { kind: 'catalogue_unavailable' };
  }
}

export function createCatalogueBridge(deps: CatalogueBridgeDependencies): CatalogueBridge {
  const { getCurrentSession, productRepo, freshness } = deps;

  // S2: `lookupBarcode` / `lookupSku` gate first (NFR-6a), then query the
  // tenant-scoped repo (the session's `tenant_id` is the only tenant the repo
  // ever sees, P17) and map the result. With no repo wired (S1 skeleton) the
  // catalogue is genuinely unavailable. `search` / `resolve` stay stubs until
  // S3 / S4. (`await Promise.resolve` on the stubs keeps them async per the
  // interface without an unused-await lint, mirroring the sales bridge.)
  return {
    async lookupBarcode(req: CatalogueLookupBarcodeRequest): Promise<CatalogueLookupResponse> {
      const gate = requireCatalogueSession(getCurrentSession());
      if (gate.kind === 'refused') return gate;
      if (productRepo === undefined)
        return await Promise.resolve({ kind: 'catalogue_unavailable' });
      const result = productRepo.lookupByBarcode(gate.session.tenant_id, req.barcode);
      return await Promise.resolve(lookupResultToResponse(result));
    },

    async lookupSku(req: CatalogueLookupSkuRequest): Promise<CatalogueLookupResponse> {
      const gate = requireCatalogueSession(getCurrentSession());
      if (gate.kind === 'refused') return gate;
      if (productRepo === undefined)
        return await Promise.resolve({ kind: 'catalogue_unavailable' });
      const result = productRepo.lookupBySku(gate.session.tenant_id, req.sku);
      return await Promise.resolve(lookupResultToResponse(result));
    },

    async search(req: CatalogueSearchRequest): Promise<CatalogueSearchResponse> {
      const gate = requireCatalogueSession(getCurrentSession());
      if (gate.kind === 'refused') return gate;
      // FR-16: guard on the NORMALIZED length (defense-in-depth — the input also
      // debounces + min-length-guards renderer-side). A whitespace- or
      // diacritic-only query folds below the minimum and must NOT scan.
      if (normalize(req.query).length < MIN_SEARCH_LENGTH)
        return await Promise.resolve({ kind: 'too_short' });
      if (productRepo === undefined)
        return await Promise.resolve({ kind: 'catalogue_unavailable' });
      const result = productRepo.search(gate.session.tenant_id, req.query);
      return await Promise.resolve(searchResultToResponse(result));
    },

    async resolve(): Promise<CatalogueResolveResponse> {
      const gate = requireCatalogueSession(getCurrentSession());
      if (gate.kind === 'refused') return gate;
      return await Promise.resolve({ kind: 'catalogue_unavailable' });
    },

    // 010 §A4 Addition 1 — manual read-down trigger. Session gate FIRST (AD-1);
    // only AFTER the gate passes does it touch the driver. Returns a STATUS only
    // (WR-2) and does NOT await the read-down (P9-2 / FR-12 — the tick runs on
    // the driver's `completed` promise, which the bridge deliberately ignores).
    // No catalogue payload is accepted (the request is `{}`, INP-1) or returned.
    async refresh(): Promise<CatalogueRefreshResponse> {
      const gate = requireCatalogueSession(getCurrentSession());
      if (gate.kind === 'refused') return gate;
      // No driver wired (e.g. live-client deferred on #349): refuse rather than
      // claim a tick we cannot start. Generic refusal, never a fake `started`.
      // NOTE: the `no_session` reason here is a CONVENIENCE reuse of the generic
      // refusal union, NOT literally true (the gate above already passed). It is
      // unreachable once the driver is wired (T039), and the reason is never
      // surfaced to the cashier (the renderer maps any refusal to a generic
      // `unavailable`). Do not trust this reason code as a session signal.
      const readDownDriver = deps.getReadDownDriver?.() ?? deps.readDownDriver;
      if (readDownDriver === undefined)
        return await Promise.resolve({ kind: 'refused', reason: 'no_session' });
      const admission = readDownDriver.runTickOnce();
      // Map admission → status. `completed` is intentionally dropped: the outcome
      // surfaces later via `freshness` + 009 lookups, never blocks this call.
      return await Promise.resolve(
        admission.kind === 'already_running' ? { kind: 'already_running' } : { kind: 'started' },
      );
    },

    // 010 §A4 Addition 2 — truthful last-updated read. Session gate FIRST (AD-1).
    // Pure tenant-scoped read of secret-free state (RD-1/P17-1): the session
    // tenant's sync-state row + a tenant-scoped live-products count. Three
    // truthful states (P9-1): null → never-synced; non-null + rows → updated;
    // non-null + 0 rows → synced-but-empty (SC-10). Never throws/leaks (IPC-1):
    // no freshness source wired → generic refusal.
    async freshness(): Promise<CatalogueFreshnessResponse> {
      const gate = requireCatalogueSession(getCurrentSession());
      if (gate.kind === 'refused') return gate;
      // No freshness source wired: refuse (cannot read truthfully) rather than
      // throw/leak. As with `refresh`, the `no_session` reason is a convenience
      // reuse of the generic union, not literally true; unreachable once wired,
      // never surfaced verbatim. Do not trust this reason code as a session signal.
      if (freshness === undefined)
        return await Promise.resolve({ kind: 'refused', reason: 'no_session' });
      const tenantId = gate.session.tenant_id;
      const row = freshness.readSyncState(tenantId);
      const lastSuccessAt = row?.last_success_at ?? null;
      const isEmpty = freshness.countProducts(tenantId) === 0;
      return await Promise.resolve({
        kind: 'ok',
        last_success_at: lastSuccessAt,
        is_empty: isEmpty,
      });
    },

    // 010 diagnostics — tenant-scoped LOCAL read-model counts (integers only;
    // WR-2: no catalogue rows, no secrets). Session gate FIRST (AD-1); refuse if
    // the source cannot supply both counts (cannot read truthfully → never
    // throw/leak, IPC-1). Tenant scoping flows from the session (P17-1).
    async counts(): Promise<CatalogueCountsResponse> {
      const gate = requireCatalogueSession(getCurrentSession());
      if (gate.kind === 'refused') return gate;
      if (freshness === undefined || freshness.countBarcodes === undefined)
        return await Promise.resolve({ kind: 'refused', reason: 'no_session' });
      const tenantId = gate.session.tenant_id;
      return await Promise.resolve({
        kind: 'ok',
        products: freshness.countProducts(tenantId),
        barcodes: freshness.countBarcodes(tenantId),
      });
    },
  };
}
