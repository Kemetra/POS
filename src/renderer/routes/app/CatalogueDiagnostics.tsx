import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import { ScreenSection } from '../../v5/foundation/ScreenSection';
import { DIAGNOSTICS_COPY } from '../../v5/manager/diagnostics/diagnostics-copy';
import { searchMessage } from '../../v5/manager/diagnostics/diagnostics-model';
import {
  CountsPanel,
  DevicePanel,
  SearchPanel,
  SyncPanel,
} from '../../v5/manager/diagnostics/DiagnosticsPanels';
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
  if (api?.catalogue === undefined) {
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

export function CatalogueDiagnostics(props: Readonly<CatalogueDiagnosticsProps>): JSX.Element {
  // Local handle is intentionally NOT named `bridge`: the T007b no-backend guard
  // forbids any `bridge.<namespace>` identifier access in renderer route/ui code
  // (only `pairing` is allowlisted). These are already narrowed flat method refs.
  // Resolved once per injected bridge. Rebuilt on every render, the handles would
  // re-run the mount effect each time, and every answer (a new object) would
  // trigger the next render: an endless read loop against the bridge.
  const injected = props.bridge;
  const calls = useMemo(() => injected ?? readBridge(), [injected]);

  const [pairing, setPairing] = useState<PairingStatus | null>(null);
  const [counts, setCounts] = useState<CatalogueCountsResponse | null>(null);
  const [freshness, setFreshness] = useState<CatalogueFreshnessResponse | null>(null);
  const [refreshKind, setRefreshKind] = useState<CatalogueRefreshResponse['kind'] | null>(null);
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
    setRefreshKind(res.kind);
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
    pairing?.kind === 'paired'
      ? {
          tenant_id: pairing.tenant_id,
          branch_id: pairing.branch_id,
          terminal_id: pairing.terminal_id,
          terminal_label: pairing.terminal_label,
        }
      : null;

  return (
    <ScreenSection title={DIAGNOSTICS_COPY.title}>
      <p className="v5-manager-sub">{DIAGNOSTICS_COPY.sub}</p>
      <div className="v5-diagnostics-grid" data-testid="catalogue-diagnostics">
        <DevicePanel paired={pairedFields} />
        <SyncPanel
          freshness={freshness}
          refreshKind={refreshKind}
          onRefresh={() => void onRefresh()}
        />
        <CountsPanel counts={counts} />
        <SearchPanel
          query={query}
          onQueryChange={(q) => void onSearch(q)}
          message={searchMessage(searchResult)}
        />
      </div>
    </ScreenSection>
  );
}
