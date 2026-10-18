/**
 * 009-product-search-and-barcode-lookup T033 — folded substring search query.
 *
 * The SQL + ranking for `catalogue.search` (FR-11/12/14/17, research §R4). Kept
 * separate from `product-repo.ts` so the query shape — the load-bearing ranking
 * and the LIKE-escape — is independently legible; the repo wires it to the
 * `DatabaseHandle` and reuses the S2 availability detection.
 *
 * Match:    substring of the prefolded `name_fold` OR `alias_fold` (both folded
 *           by the same `normalize()` the query is folded with, FR-12b).
 * Rank:     exact-PREFIX before mid-string (FR-14). A product is a prefix match
 *           if EITHER fold column starts with the query.
 * Order:    deterministic TOTAL order — (rank tier, name_fold, product_id) — so
 *           the list is stable; SQLite returns rows unordered otherwise.
 * Cap:      fetch `CAP + 1` (21); ≥ 21 rows ⇒ `truncated`, return the first 20.
 * Escape:   `%` and `_` in the folded query are LIKE metacharacters; pharma
 *           names carry `%` ("0.9%"). They are escaped so the query matches
 *           literally (ESCAPE '\').
 */

export const SEARCH_CAP = 20;
const LIKE_ESCAPE = '\\';

/**
 * Escape LIKE metacharacters (`%`, `_`) and the escape char itself in a folded
 * query, so the query is matched as a literal substring under `LIKE … ESCAPE`.
 */
export function escapeLike(folded: string): string {
  return folded.replaceAll(/[\\%_]/g, (ch) => `${LIKE_ESCAPE}${ch}`);
}

/**
 * The search SQL. Selects the product columns plus a `rank` tier (0 = prefix,
 * 1 = mid-string) for active, tenant-scoped products whose `name_fold` or
 * `alias_fold` contains the folded query. Ordered to a stable total order and
 * limited to `CAP + 1` so the caller can compute `truncated` without a second
 * COUNT.
 *
 * Bind order: [tenantId, contains, contains, prefix, prefix, prefix, prefix].
 *   contains = `%<escaped>%`   prefix = `<escaped>%`
 */
export function buildSearchSql(productColumns: string): string {
  return `
    SELECT ${productColumns},
      CASE WHEN p.name_fold LIKE ? ESCAPE '${LIKE_ESCAPE}'
             OR p.alias_fold LIKE ? ESCAPE '${LIKE_ESCAPE}'
           THEN 0 ELSE 1 END AS rank
    FROM products p
    WHERE p.tenant_id = ?
      AND p.active = 1
      AND ( p.name_fold  LIKE ? ESCAPE '${LIKE_ESCAPE}'
         OR p.alias_fold LIKE ? ESCAPE '${LIKE_ESCAPE}' )
    ORDER BY rank ASC, p.name_fold ASC, p.product_id ASC
    LIMIT ${String(SEARCH_CAP + 1)}
  `;
}

/**
 * Build the positional bind parameters for `buildSearchSql`, given the already-
 * folded query. Order matches the `?` placeholders in the SQL: the two SELECT
 * `rank` prefix patterns, then `tenant_id`, then the two WHERE contains patterns.
 */
export function buildSearchParams(tenantId: string, foldedQuery: string): string[] {
  const escaped = escapeLike(foldedQuery);
  const prefix = `${escaped}%`;
  const contains = `%${escaped}%`;
  // SQL placeholder order: rank-name-prefix, rank-alias-prefix, tenant,
  // where-name-contains, where-alias-contains.
  return [prefix, prefix, tenantId, contains, contains];
}
