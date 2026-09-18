/**
 * 010-pos-catalog-read-down-consumption T020/T021 — `createReadDownClient`.
 *
 * The CONCRETE live HTTP client behind the `ReadDownClient` DI seam
 * (`read-down-client-types.ts`). It fetches the SHIPPED backend catalogue
 * snapshot (`GET /api/pos/v1/catalog/snapshot`, Data-Pulse-2 PR #490) and maps the
 * transport outcome onto the contract union (`ok` / `no_connection` / `failed`).
 *
 * Established repo pattern (mirrors `operator/backend-client.ts` + the
 * voucher-authority-client clients):
 *   • Factory `{ baseUrl, fetch, getDeviceToken, timeoutMs }`; `fetch` injected
 *     (production binds `globalThis.fetch`).
 *   • `AbortSignal.timeout(timeoutMs)`.
 *   • Resolve on EVERY reachable response (incl. non-2xx); reject ONLY on a
 *     transport fault → mapped to `{ kind:'no_connection' }`. NEVER throws.
 *   • Non-2xx / malformed body → `{ kind:'failed' }` (FR-7: prior catalogue
 *     preserved by the driver — the writer never runs on a non-`ok` result).
 *
 * Auth (the load-bearing reversal, contracts/backend-catalogue-snapshot.md banner
 * + plan AD-7): `Authorization: Bearer <device_token>`. The backend has NO
 * `X-Terminal-Token` seam — the guard reads `Authorization` only. The device token
 * is read main-process-side via the injected `getDeviceToken` and attached to the
 * outbound request only; it is a secret — NEVER logged and NEVER surfaced on the
 * returned union (P7 / NFR-3). The read-down driver is non-session-gated
 * (Constitution VIII), so the device token is the SOLE credential — no operator JWT.
 *
 * Contract note: the response shape is the binding DP2 `CatalogSnapshotPage`
 * (deployed ref 6975f67, `catalog/read-down.yaml`): a cursor-paginated page with
 * `items` (the `SellableCatalogRow[]`, mirrored locally in `map-sellable-row.ts`),
 * `cursor` (the snapshot's opaque server cursor — the same value across every
 * page; carried into `sourceSnapshotId`), and `next_page_token` (opaque
 * continuation token; null on the last page). The snapshot is cursor-paginated
 * (≤1000 rows/page): this client walks every page via the `page_token` query
 * parameter, accumulating `items` into one rows array. A full-snapshot-replace
 * (FR-7 / R3) needs the COMPLETE set, so ANY non-2xx / malformed page mid-loop
 * fails the whole fetch (`failed`), and a transport fault maps to `no_connection`
 * — never a partial snapshot.
 *
 * Type pin (#349 RESOLVED — PR #406): `api-types.ts` is now re-pinned to the
 * deployed read-down contract; its generated `SellableCatalogRow` matches this
 * client's local mirror (`map-sellable-row.ts`) field-for-field (the mirror's
 * `aliases?` is intentionally MORE lenient than the generated required `aliases`
 * — the safe direction). The page is still validated STRUCTURALLY here on
 * purpose: the generated snapshot has no `CatalogSnapshotPage` page-wrapper type
 * (the deployed backend serves no `/openapi.json`, so the snapshot was
 * merged from the contract YAML's row schema, not the paginated response
 * envelope). The local mirror remains the validated shape; the structural check
 * is the deliberate transport-boundary guard, not a #349 workaround.
 */

import type { SellableCatalogRow } from './map-sellable-row.js';
import type { ReadDownClient, ReadDownFetchResult } from './read-down-client-types.js';

const SNAPSHOT_PATH = '/api/pos/v1/catalog/snapshot';
const PAGE_TOKEN_PARAM = 'page_token';
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Default page-walk cap. The contract is ≤1000 rows/page; this bounds the loop
 * at the max-pages scale so a server that never emits a null `next_page_token`
 * fails closed instead of looping forever. See `CreateReadDownClientDeps.maxPages`.
 */
const DEFAULT_MAX_PAGES = 100_000;

export interface CreateReadDownClientDeps {
  /** Data-Pulse-2 base URL, e.g. `https://example.invalid` in tests/templates. */
  baseUrl: string;
  /** `fetch` implementation. Production binds the global; tests inject. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * In-process read of the device token (the paired-terminal credential). Returns
   * `null`/`''` when the terminal is not paired — the request is not attempted.
   * The token is read here main-process-side and never crosses the bridge.
   */
  getDeviceToken: () => Promise<string | null>;
  /** Override the request timeout in tests. */
  timeoutMs?: number;
  /**
   * Hard cap on pages walked before failing closed (default `DEFAULT_MAX_PAGES`).
   * The continuation token alone cannot bound the loop (the server issues it), so
   * this caps the walk at the contract's max-pages-at-1000-rows scale. A bad
   * server that never returns a null token exhausts the cap → `failed` (never a
   * partial snapshot). Overridable in tests to exercise the exhaustion branch.
   */
  maxPages?: number;
}

/** One reachable `CatalogSnapshotPage`. Shape mirrors the binding contract (see header). */
interface CatalogSnapshotPage {
  items?: unknown;
  cursor?: unknown;
  next_page_token?: unknown;
}

/** Narrow an unknown value to a `SellableCatalogRow` (structural; never throws). */
function isSellableCatalogRow(value: unknown): value is SellableCatalogRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const price = row['price'];
  if (typeof price !== 'object' || price === null) return false;
  const priceObj = price as Record<string, unknown>;
  return (
    typeof row['product_id'] === 'string' &&
    typeof row['sku'] === 'string' &&
    typeof row['name'] === 'string' &&
    typeof priceObj['amount'] === 'string' &&
    typeof priceObj['currency_code'] === 'string' &&
    typeof row['tax_category'] === 'string' &&
    typeof row['active'] === 'boolean' &&
    typeof row['row_cursor'] === 'string'
  );
}

/** A successfully fetched + structurally-valid single page. */
interface ValidPage {
  rows: SellableCatalogRow[];
  /** The snapshot's opaque server cursor (same across every page). */
  cursor: string;
  /** Opaque continuation token; `null` on the last page. */
  nextPageToken: string | null;
}

/** Per-page fetch outcome — mirrors the transport union plus the parsed page. */
type PageResult = { kind: 'ok'; page: ValidPage } | { kind: 'no_connection' } | { kind: 'failed' };

export function createReadDownClient(deps: CreateReadDownClientDeps): ReadDownClient {
  const { fetch: fetchImpl, baseUrl, getDeviceToken } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const root = baseUrl.replace(/\/$/, '');

  /** Fetch + structurally validate ONE page. `pageToken` advances pagination. */
  async function fetchPage(deviceToken: string, pageToken: string | null): Promise<PageResult> {
    const url = new URL(`${root}${SNAPSHOT_PATH}`);
    if (pageToken !== null) {
      url.searchParams.set(PAGE_TOKEN_PARAM, pageToken);
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${deviceToken}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Transport fault (DNS / TLS / refused / timeout) — backend unreachable.
      return { kind: 'no_connection' };
    }

    if (!response.ok) {
      // Reached but non-2xx (401/403/404/5xx). Collapse to `failed` — the raw
      // body is never surfaced (P7); the driver preserves the prior catalogue.
      return { kind: 'failed' };
    }

    let parsed: unknown;
    try {
      parsed = (await response.json()) as unknown;
    } catch {
      return { kind: 'failed' };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return { kind: 'failed' };
    }
    const page = parsed as CatalogSnapshotPage;

    // `cursor` is contract-required + minLength 1: an absent/empty cursor is a
    // malformed page (R3 needs a real snapshot cursor for freshness/provenance).
    if (typeof page.cursor !== 'string' || page.cursor.length === 0) {
      return { kind: 'failed' };
    }
    if (!Array.isArray(page.items)) {
      return { kind: 'failed' };
    }
    // A single malformed row poisons the snapshot: the full-snapshot-replace
    // model (R3) requires a complete, trustworthy set, so reject the whole
    // page rather than silently dropping rows. Per-row money/shape mapping
    // (mapSellableRow) still guards downstream in the writer.
    if (!page.items.every(isSellableCatalogRow)) {
      return { kind: 'failed' };
    }
    // `next_page_token` is `[string, "null"]`; anything else is malformed.
    const rawToken = page.next_page_token;
    if (rawToken !== null && rawToken !== undefined && typeof rawToken !== 'string') {
      return { kind: 'failed' };
    }
    const nextPageToken = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null;

    return { kind: 'ok', page: { rows: page.items, cursor: page.cursor, nextPageToken } };
  }

  return {
    async fetchSnapshot(): Promise<ReadDownFetchResult> {
      // The device token is the sole credential. No token (unpaired) → treat as a
      // reached-but-failed request: the driver records a failed attempt and the
      // working catalogue is preserved (the writer never runs).
      let deviceToken: string | null;
      try {
        deviceToken = await getDeviceToken();
      } catch {
        return { kind: 'failed' };
      }
      if (deviceToken === null || deviceToken.length === 0) {
        return { kind: 'failed' };
      }

      // Walk every page, accumulating `items`. All pages MUST share one `cursor`
      // (the snapshot's consistent point — header lines 30-31); `next_page_token`
      // advances. ANY mid-loop non-2xx / malformed page → `failed` (no partial
      // snapshot); a transport fault → `no_connection`. Both preserve the prior
      // catalogue.
      const rows: SellableCatalogRow[] = [];
      let cursor: string | null = null;
      let pageToken: string | null = null;
      // The page-walk completes ONLY when a page reports `nextPageToken === null`.
      // If the cap is exhausted first, the server never signalled the last page —
      // fail closed (no partial snapshot) rather than promoting an accumulated prefix.
      let reachedLastPage = false;

      // The token alone cannot bound the loop (the server issues it); bound on
      // `maxPages` to fail closed on a bad server that never returns a null token.
      for (let guard = 0; guard < maxPages; guard += 1) {
        const result = await fetchPage(deviceToken, pageToken);
        if (result.kind !== 'ok') {
          return result.kind === 'no_connection' ? { kind: 'no_connection' } : { kind: 'failed' };
        }
        // The cursor is pinned on the first page and MUST be identical on every
        // subsequent page. A drift (contract bug / cache mismatch) would yield a
        // snapshot stitched from two server states tagged with only the last
        // cursor — reject it rather than promote a mixed snapshot.
        if (cursor === null) {
          cursor = result.page.cursor;
        } else if (result.page.cursor !== cursor) {
          return { kind: 'failed' };
        }
        rows.push(...result.page.rows);
        if (result.page.nextPageToken === null) {
          reachedLastPage = true;
          break;
        }
        pageToken = result.page.nextPageToken;
      }

      // Cap exhausted without ever seeing the last page → fail closed.
      if (!reachedLastPage) {
        return { kind: 'failed' };
      }

      // `cursor` is set on every successful page; guard defensively for the
      // type-narrower (an empty result set still carries a real cursor).
      if (cursor === null) {
        return { kind: 'failed' };
      }

      return {
        kind: 'ok',
        sourceSnapshotId: cursor,
        rows,
      };
    },
  };
}
