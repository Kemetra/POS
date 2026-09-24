import { useCallback, useRef, type JSX } from 'react';

import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api.js';
import type { AddedLineResult } from '../../sale/useSaleCartController.js';
import { useSaleCatalogueController } from '../../sale/useSaleCatalogueController.js';
import { ProductSearchInput, type ProductSearchInputHandle } from './ProductSearchInput.js';
import { ScanCaptureField } from './ScanCaptureField.js';
import { SearchResultList } from './SearchResultList.js';
import { CatalogueAddController } from './CatalogueAddController.js';
import { NotFoundState } from './NotFoundState.js';
import { AmbiguousBarcodeState } from './AmbiguousBarcodeState.js';
import { CatalogueUnavailableState } from './CatalogueUnavailableState.js';
import { CatalogueFreshness } from './CatalogueFreshness.js';
import { CatalogueEnrichmentShell } from './CatalogueEnrichmentShell.js';

/**
 * 009 Slice S5 (T049a) — the live catalogue sale surface.
 *
 * Composition root: (a) typed search → `catalogue.search`; scan →
 * `catalogue.lookupBarcode`; each response maps to the `catalogueSearchStore`
 * FSM. (b) cart lifecycle + `onLineAdded` thread lands in the next task.
 *
 * Bridges are injected (`catalogueBridge`/`cartBridge`) mirroring CartPane's
 * `_testBridge` seam; production reads `window.api`. The FSM's `searching`-guard
 * drops stale responses, so no extra race handling is needed here.
 */
export interface CatalogueSalePaneProps {
  /** The active cart to add into. Optional — the pane sources/creates one from the store. */
  cartId?: string;
  onLineAdded: (res: AddedLineResult) => void;
  catalogueBridge?: CatalogueBridgeAPI;
  cartBridge?: CartBridgeAPI;
}

export function CatalogueSalePane({
  cartId,
  onLineAdded,
  catalogueBridge,
  cartBridge,
}: CatalogueSalePaneProps): JSX.Element {
  const { state, effectiveCartId, runTypedSearch, runScan, selectResult, recover } =
    useSaleCatalogueController({
      ...(cartId !== undefined ? { cartId } : {}),
      ...(cartBridge !== undefined ? { cartBridge } : {}),
      ...(catalogueBridge !== undefined ? { catalogueBridge } : {}),
    });
  const searchInputRef = useRef<ProductSearchInputHandle>(null);

  // Clear the FSM to idle and return focus to the search input — the S0
  // recovery contract for every terminal error surface (FR-6/7 keyboard
  // recovery: "every terminal state returns focus to the input").
  const recoverToInput = useCallback((): void => {
    recover();
    searchInputRef.current?.focus();
  }, [recover]);

  const items = state.kind === 'results' ? state.items : [];
  const truncated = state.kind === 'results' ? state.truncated : false;

  return (
    <div className="catalogue-sale-pane" data-testid="catalogue-sale-pane" dir="rtl">
      {/* 010 — catalogue freshness header (FR-16): the truthful last-updated
          line + manual refresh. Reads window.api.catalogue itself; in tests a
          `catalogueBridge` is injected, so honour the same seam to avoid hitting
          window.api under jsdom. */}
      <CatalogueFreshness {...(catalogueBridge !== undefined ? { bridge: catalogueBridge } : {})} />
      <ProductSearchInput
        ref={searchInputRef}
        onSearch={(query) => {
          void runTypedSearch(query);
        }}
      />
      <ScanCaptureField
        onScan={(barcode) => {
          void runScan(barcode);
        }}
      />
      {/* In-flight surface (T050 F2 / Surface 2): the bridge call is pending.
          `aria-busy` announces the wait; no spin glyph so reduced-motion is
          honoured by construction. No controls of its own (a new scan/keystroke
          supersedes via the input). */}
      {state.kind === 'searching' && (
        <p
          className="catalogue-searching"
          data-testid="catalogue-searching"
          role="status"
          aria-busy="true"
        >
          جارٍ البحث… (searching…)
        </p>
      )}
      {state.kind === 'results' && (
        <SearchResultList
          items={items}
          truncated={truncated}
          onSelect={(product) => {
            selectResult(product);
          }}
        />
      )}
      {/* Error-state surfaces (T050 F1): the FSM reaches these via the bridge
          response mappings above, so the live pane MUST mount them or the screen
          goes blank. `onEdit` clears the FSM to idle for the next scan (FR-6/7
          recovery). The danger/warning/muted treatments are owned by the
          components (SC-10 — three distinct error states). */}
      {state.kind === 'not_found' && <NotFoundState query={state.query} onEdit={recoverToInput} />}
      {state.kind === 'ambiguous' && <AmbiguousBarcodeState onEdit={recoverToInput} />}
      {state.kind === 'catalogue_unavailable' && <CatalogueUnavailableState />}
      {/* POS v3.5 — deferred-enrichment honesty shell. The prototype fills this
          zone (below the search, when idle/not searching) with category chips +
          a quick-item browse grid. The live `catalogue` contract has NO
          list/browse/by-category method and NO stock/expiry/interaction/
          bought-together data (POS-013, deferred), so this holds the layout slot
          with a truthful "not available yet" placeholder rather than fabricating
          data. Shown only in idle — the search/error surfaces own the pane
          otherwise. */}
      {state.kind === 'idle' && <CatalogueEnrichmentShell />}
      {effectiveCartId !== '' && (
        <CatalogueAddController
          cartId={effectiveCartId}
          onLineAdded={onLineAdded}
          onResolved={() => searchInputRef.current?.focus()}
          {...(cartBridge !== undefined ? { bridge: cartBridge } : {})}
        />
      )}
    </div>
  );
}
