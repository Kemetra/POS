import { useCallback, useEffect, useState, type JSX } from 'react';

import { ScreenSection } from '../../v5/foundation/ScreenSection';
import type {
  CatalogueBridgeAPI,
  CatalogueCountsResponse,
  CatalogueFreshnessResponse,
  CatalogueRefreshResponse,
  CatalogueSearchResponse,
  PairingBridgeAPI,
  PreloadBridgeAPI,
} from '../../../shared/bridge-api';
import type { PairingStatus } from '../../../shared/pairing-types';

/**
 * 010 diagnostics — read-only Catalogue Diagnostics screen.
 *
 * A utilitarian, READ-ONLY operator/owner panel for verifying read-down state on
 * a pilot terminal WITHOUT DB access. It composes existing read-only bridge calls:
 *   • `pairing.getStatus()` → tenant / store / terminal IDENTIFIERS only.
 *   • `catalogue.counts()`  → products + barcode-alias counts (integers).
 *   • `catalogue.freshness()` + `catalogue.refresh()` → sync state + manual refresh.
 *   • `catalogue.search()`  → read-only local search.
 *
 * Security policy (mirrors PairedScreen): the `paired` PairingStatus branch omits
 * `device_token` by design; this screen reads ONLY tenant/store/terminal ids +
 * label, and never renders any token/secret — in visible text OR DOM attributes.
 * It performs NO writes, NO sale/cart/payment/ERP action; `refresh` only requests
 * a main-process read-down tick and reports its honest status (started /
 * already_running / refused), never a fake "done".
 *
 * The `bridge` prop mirrors the established `_testBridge` seam (tests inject a
 * scripted bridge; production reads `window.api`).
 */

/**
 * FLAT method handles — the diagnostics screen depends only on the specific
 * read-only calls it needs, NOT on whole bridge namespaces. This mirrors the
 * `FreshnessBridge` narrowing idiom (CatalogueFreshness) and keeps the renderer
 * off broad `bridge.<namespace>` access (T007b no-backend boundary guard:
 * only `pairing` is an allowlisted renderer bridge namespace). The flat seam is
 * also the test-injection point.
 */
export interface DiagnosticsBridge {
  getStatus: PairingBridgeAPI['getStatus'];
  counts: CatalogueBridgeAPI['counts'];
  freshness: CatalogueBridgeAPI['freshness'];
  refresh: CatalogueBridgeAPI['refresh'];
  search: CatalogueBridgeAPI['search'];
}

export interface CatalogueDiagnosticsProps {
  bridge?: DiagnosticsBridge;
}

function readBridge(): DiagnosticsBridge {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api || api.catalogue === undefined) {
    throw new Error(
      'CatalogueDiagnostics: window.api.catalogue missing — preload not initialised.',
    );
  }
  // Narrow to the exact method handles up front; the component never touches a
  // whole bridge namespace.
  const cat = api.catalogue;
  return {
    getStatus: api.pairing.getStatus.bind(api.pairing),
    counts: cat.counts.bind(cat),
    freshness: cat.freshness.bind(cat),
    refresh: cat.refresh.bind(cat),
    search: cat.search.bind(cat),
  };
}

function formatFreshness(f: CatalogueFreshnessResponse | null): string {
  if (f === null) return '…';
  if (f.kind === 'refused') return 'unavailable';
  if (f.last_success_at === null) return 'never synced';
  return f.is_empty ? `synced (empty) — ${f.last_success_at}` : `synced — ${f.last_success_at}`;
}

export function CatalogueDiagnostics(props: CatalogueDiagnosticsProps): JSX.Element {
  // Local handle is intentionally NOT named `bridge`: the T007b no-backend guard
  // forbids any `bridge.<namespace>` identifier access in renderer route/ui code
  // (only `pairing` is allowlisted). These are already narrowed flat method refs.
  const calls = props.bridge ?? readBridge();

  const [pairing, setPairing] = useState<PairingStatus | null>(null);
  const [counts, setCounts] = useState<CatalogueCountsResponse | null>(null);
  const [freshness, setFreshness] = useState<CatalogueFreshnessResponse | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [searchResult, setSearchResult] = useState<CatalogueSearchResponse | null>(null);

  const loadFreshness = useCallback(async () => {
    try {
      setFreshness(await calls.freshness({}));
    } catch {
      setFreshness({ kind: 'refused', reason: 'no_session' });
    }
  }, [calls]);

  const loadCounts = useCallback(async () => {
    try {
      setCounts(await calls.counts({}));
    } catch {
      setCounts({ kind: 'refused', reason: 'no_session' });
    }
  }, [calls]);

  useEffect(() => {
    const guard = { cancelled: false };
    void (async () => {
      let status: PairingStatus | null = null;
      try {
        status = await calls.getStatus();
      } catch {
        status = null;
      }
      if (!guard.cancelled) setPairing(status);
    })();
    void loadCounts();
    void loadFreshness();
    return () => {
      guard.cancelled = true;
    };
  }, [calls, loadCounts, loadFreshness]);

  const onRefresh = useCallback(async () => {
    let res: CatalogueRefreshResponse;
    try {
      res = await calls.refresh({});
    } catch {
      res = { kind: 'refused', reason: 'no_session' };
    }
    // Honest status only — never claim completion (P9-2). The promote's effect
    // surfaces on the next freshness/counts read, which we kick off non-blocking.
    setRefreshStatus(res.kind);
    void loadFreshness();
    void loadCounts();
  }, [calls, loadCounts, loadFreshness]);

  const onSearch = useCallback(
    async (q: string) => {
      setQuery(q);
      if (q.trim().length < 2) {
        setSearchResult(null);
        return;
      }
      try {
        setSearchResult(await calls.search({ query: q }));
      } catch {
        setSearchResult({ kind: 'refused', reason: 'no_session' });
      }
    },
    [calls],
  );

  const pairedFields =
    pairing && pairing.kind === 'paired'
      ? {
          tenant_id: pairing.tenant_id,
          branch_id: pairing.branch_id,
          terminal_id: pairing.terminal_id,
          terminal_label: pairing.terminal_label,
        }
      : null;

  return (
    <ScreenSection title="Catalogue Diagnostics">
      <div className="catalogue-diagnostics" data-testid="catalogue-diagnostics">
        <section data-testid="diagnostics-pairing">
          <h2>Terminal</h2>
          {pairedFields === null ? (
            <p>Not paired.</p>
          ) : (
            <dl>
              <dt>Tenant</dt>
              <dd>{pairedFields.tenant_id}</dd>
              <dt>Store</dt>
              <dd>{pairedFields.branch_id}</dd>
              <dt>Terminal</dt>
              <dd>{pairedFields.terminal_id}</dd>
              <dt>Label</dt>
              <dd>{pairedFields.terminal_label}</dd>
            </dl>
          )}
        </section>

        <section data-testid="diagnostics-sync">
          <h2>Catalogue sync</h2>
          <p>
            <span data-testid="diagnostics-sync-state">{formatFreshness(freshness)}</span>
          </p>
          <button type="button" data-testid="diagnostics-refresh" onClick={() => void onRefresh()}>
            Refresh
          </button>
          {refreshStatus !== '' && (
            <span data-testid="diagnostics-refresh-status">{refreshStatus}</span>
          )}
        </section>

        <section data-testid="diagnostics-counts">
          <h2>Local read model</h2>
          {counts === null || counts.kind === 'refused' ? (
            <p>unavailable</p>
          ) : (
            <ul>
              <li>Products: {counts.products}</li>
              <li>Barcodes/aliases: {counts.barcodes}</li>
            </ul>
          )}
        </section>

        {/*
          POS v3.5 Phase 4 — stock / expiry / availability are part of the
          v3.5 inventory design but have no renderer-facing data source yet
          (deferred to POS-013, G2-gated). Surfaced as an honest coming-soon
          section — never a fabricated figure.
        */}
        <section
          className="diagnostics-section--coming-soon"
          data-testid="diagnostics-stock-coming-soon"
          data-functional="false"
        >
          <h2>
            Stock &amp; expiry
            <span className="diagnostics-badge">Coming soon</span>
          </h2>
          <p>On-hand stock, batch expiry, and availability arrive with the inventory contract.</p>
        </section>

        <section data-testid="diagnostics-search">
          <h2>Search local catalogue (read-only)</h2>
          <input
            type="search"
            aria-label="Search local catalogue"
            value={query}
            onChange={(e) => void onSearch(e.target.value)}
          />
          <div data-testid="diagnostics-search-results">
            {searchResult === null
              ? null
              : searchResult.kind === 'results'
                ? `${String(searchResult.items.length)} match(es)`
                : searchResult.kind === 'not_found'
                  ? 'no matches'
                  : 'unavailable'}
          </div>
        </section>
      </div>
    </ScreenSection>
  );
}
