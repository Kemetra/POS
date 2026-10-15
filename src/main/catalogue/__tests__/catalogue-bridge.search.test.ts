import { beforeAll, describe, expect, it } from 'vitest';

import { createCatalogueBridge } from '../catalogue-bridge.js';
import { createProductRepo } from '../product-repo.js';
import type { OperatorSessionForCatalogue } from '../require-catalogue-session.js';
import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
  seedProduct,
} from './__helpers__/catalogue-fixture.js';
import type { Database as SqlJsDatabase } from 'sql.js';

/**
 * 009 T034 — `catalogue.search` handler wired to the repo.
 *
 * Handler: gate first (NFR-6a) → enforce the min-length guard on the NORMALIZED
 * query (FR-16; bridge-side defense-in-depth even though the input debounces)
 * → repo.search → map to results / not_found / catalogue_unavailable. The
 * repo's `unavailable` becomes `{ kind: 'catalogue_unavailable' }`. A query whose
 * normalized form is shorter than 2 chars (empty, whitespace-only, or
 * diacritic-only) returns `too_short` WITHOUT scanning.
 */

const SESSION: OperatorSessionForCatalogue = {
  role: 'cashier',
  operator_id: 'op-1',
  operator_session_id: 'sess-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
};

beforeAll(async () => {
  await initCatalogueSql();
});

function bridgeFor(db: SqlJsDatabase, session: OperatorSessionForCatalogue | null = SESSION) {
  return createCatalogueBridge({
    getCurrentSession: () => session,
    productRepo: createProductRepo(handleFor(db)),
  });
}

describe('T034 — catalogue.search wired to the repo', () => {
  it('returns ranked results with the truncated flag for a matching query', async () => {
    const db = freshCatalogueDb();
    seedProduct(db, { product_id: 'p-1', name_ar: 'بنادول', name_en: 'Panadol' });
    const r = await bridgeFor(db).search({ query: 'بنادول' });

    expect(r.kind).toBe('results');
    if (r.kind === 'results') {
      expect(r.items.map((p) => p.product_id)).toEqual(['p-1']);
      expect(r.truncated).toBe(false);
    }
    db.close();
  });

  it('returns not_found for a populated catalogue with zero matches', async () => {
    const db = freshCatalogueDb();
    seedProduct(db, { product_id: 'p-1', name_en: 'Aspirin' });

    expect((await bridgeFor(db).search({ query: 'zzzznope' })).kind).toBe('not_found');
    db.close();
  });

  it('returns catalogue_unavailable for an empty read model (distinct from not_found)', async () => {
    const db = freshCatalogueDb();
    expect((await bridgeFor(db).search({ query: 'بنادول' })).kind).toBe('catalogue_unavailable');
    db.close();
  });

  it.each([
    {
      name: 'returns too_short for a single-character query (min 2, FR-16)',
      query: 'a',
      seed: { product_id: 'p-1', name_en: 'Aspirin' },
    },
    {
      name: 'returns too_short for an empty query',
      query: '',
      seed: { product_id: 'p-1', name_en: 'Aspirin' },
    },
    {
      name: 'returns too_short for a whitespace-only query (normalizes to empty)',
      query: '   ',
      seed: { product_id: 'p-1', name_en: 'Aspirin' },
    },
    {
      // A lone harakat (combining mark) is stripped by normalize() → empty.
      name: 'returns too_short for a diacritic-only query (normalizes below 2 chars)',
      query: 'ـً',
      seed: { product_id: 'p-1', name_ar: 'بنادول' },
    },
  ])('$name', async ({ query, seed }) => {
    const db = freshCatalogueDb();
    seedProduct(db, seed);

    expect((await bridgeFor(db).search({ query })).kind).toBe('too_short');
    db.close();
  });

  it('does NOT treat a valid 2-char query as too_short', async () => {
    const db = freshCatalogueDb();
    seedProduct(db, { product_id: 'p-1', name_en: 'Abacavir' });

    expect((await bridgeFor(db).search({ query: 'ab' })).kind).toBe('results');
    db.close();
  });

  it('refuses no_session before touching the repo or the min-length guard', async () => {
    const db = freshCatalogueDb();
    seedProduct(db, { product_id: 'p-1', name_en: 'Aspirin' });

    await expect(bridgeFor(db, null).search({ query: 'aspirin' })).resolves.toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    db.close();
  });
});
