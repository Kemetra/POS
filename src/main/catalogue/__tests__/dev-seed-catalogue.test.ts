import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  applyDevSeedCatalogueIfRequested,
  DEV_CATALOGUE_FIXTURE,
  DEV_SEED_TENANT_ID,
} from '../dev-seed-catalogue.js';
import { createProductRepo } from '../product-repo.js';
import { isShippedApp } from '../../app/shipped-app.js';
import { freshCatalogueDb, handleFor, initCatalogueSql } from './__helpers__/catalogue-fixture.js';

let db: SqlJsDatabase | undefined;

beforeAll(async () => {
  await initCatalogueSql();
});

afterEach(() => {
  if (db !== undefined) {
    db.close();
    db = undefined;
  }
});

function silentLogger(): { warn: (payload: object, msg: string) => void } {
  return { warn: vi.fn() };
}

function countRows(d: SqlJsDatabase, table: string): number {
  const stmt = d.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
  stmt.step();
  const n = (stmt.getAsObject() as { n: number }).n;
  stmt.free();
  return n;
}

describe('applyDevSeedCatalogueIfRequested — gating (fail-closed)', () => {
  it('NO-OPs in a packaged build even when the env flag is set', () => {
    db = freshCatalogueDb();
    const seeded = applyDevSeedCatalogueIfRequested({
      isShippedApp: true,
      env: { POS_PULSE_DEV_SEED_CATALOGUE: '1' },
      db: handleFor(db),
      logger: silentLogger(),
    });
    expect(seeded).toBe(false);
    expect(countRows(db, 'products')).toBe(0);
  });

  // RT-165 — a renamed copy of the shipped exe reports app.isPackaged=false
  // but still runs resources/app.asar; it must never seed fixture products.
  it('NO-OPs for a renamed shipped exe (isPackaged=false, app.asar) with the flag set', () => {
    db = freshCatalogueDb();
    const seeded = applyDevSeedCatalogueIfRequested({
      isShippedApp: isShippedApp({ isPackaged: false, appPath: 'C:\\copy\\resources\\app.asar' }),
      env: { POS_PULSE_DEV_SEED_CATALOGUE: '1' },
      db: handleFor(db),
      logger: silentLogger(),
    });
    expect(seeded).toBe(false);
    expect(countRows(db, 'products')).toBe(0);
  });

  it('NO-OPs when the env flag is absent (unpackaged)', () => {
    db = freshCatalogueDb();
    const seeded = applyDevSeedCatalogueIfRequested({
      isShippedApp: false,
      env: {},
      db: handleFor(db),
      logger: silentLogger(),
    });
    expect(seeded).toBe(false);
    expect(countRows(db, 'products')).toBe(0);
  });

  it('SEEDS when unpackaged and the env flag is truthy', () => {
    db = freshCatalogueDb();
    const seeded = applyDevSeedCatalogueIfRequested({
      isShippedApp: false,
      env: { POS_PULSE_DEV_SEED_CATALOGUE: '1' },
      db: handleFor(db),
      logger: silentLogger(),
    });
    expect(seeded).toBe(true);
    expect(countRows(db, 'products')).toBe(DEV_CATALOGUE_FIXTURE.length);
    expect(countRows(db, 'product_barcodes')).toBeGreaterThanOrEqual(DEV_CATALOGUE_FIXTURE.length);
  });
});

describe('applyDevSeedCatalogueIfRequested — idempotency', () => {
  it('does not duplicate rows when run twice', () => {
    db = freshCatalogueDb();
    const args = {
      isShippedApp: false,
      env: { POS_PULSE_DEV_SEED_CATALOGUE: '1' },
      db: handleFor(db),
      logger: silentLogger(),
    };
    expect(applyDevSeedCatalogueIfRequested(args)).toBe(true);
    const after1 = countRows(db, 'products');
    expect(applyDevSeedCatalogueIfRequested(args)).toBe(false);
    expect(countRows(db, 'products')).toBe(after1);
  });
});

describe('applyDevSeedCatalogueIfRequested — feeds the production read path', () => {
  it('a seeded product is findable via ProductRepo.search (fold came from normalize())', () => {
    db = freshCatalogueDb();
    applyDevSeedCatalogueIfRequested({
      isShippedApp: false,
      env: { POS_PULSE_DEV_SEED_CATALOGUE: '1' },
      db: handleFor(db),
      logger: silentLogger(),
    });
    const repo = createProductRepo(handleFor(db));
    const first = DEV_CATALOGUE_FIXTURE[0];
    if (first === undefined) throw new Error('fixture is empty');
    const query = first.name_ar.slice(0, 3);
    const res = repo.search(DEV_SEED_TENANT_ID, query);
    expect(res.kind).toBe('results');
    if (res.kind !== 'results') return;
    expect(res.items.some((p) => p.product_id === first.product_id)).toBe(true);
  });

  it('a seeded barcode resolves via ProductRepo.lookupByBarcode', () => {
    db = freshCatalogueDb();
    applyDevSeedCatalogueIfRequested({
      isShippedApp: false,
      env: { POS_PULSE_DEV_SEED_CATALOGUE: '1' },
      db: handleFor(db),
      logger: silentLogger(),
    });
    const repo = createProductRepo(handleFor(db));
    // An ACTIVE product with a unique barcode → deterministic `one` (FR-4). The
    // active guard ensures we never pick the inactive fixture row (→ not_found).
    const withBarcode = DEV_CATALOGUE_FIXTURE.find((p) => p.active === 1 && p.barcodes.length > 0);
    if (withBarcode === undefined) throw new Error('no active fixture product has a barcode');
    const firstBarcode = withBarcode.barcodes[0];
    if (firstBarcode === undefined) throw new Error('barcode list empty');
    const res = repo.lookupByBarcode(DEV_SEED_TENANT_ID, firstBarcode.barcode);
    expect(res.kind).toBe('one');
  });
});

describe('DEV_CATALOGUE_FIXTURE — review-surface coverage', () => {
  it('includes a controlled, an Rx, and an inactive product', () => {
    expect(DEV_CATALOGUE_FIXTURE.some((p) => p.controlled_substance === 1)).toBe(true);
    expect(DEV_CATALOGUE_FIXTURE.some((p) => p.prescription_required === 1)).toBe(true);
    expect(DEV_CATALOGUE_FIXTURE.some((p) => p.active === 0)).toBe(true);
  });

  it('uses the dev tenant constant', () => {
    expect(DEV_SEED_TENANT_ID).toBe('dev-tenant');
  });
});
