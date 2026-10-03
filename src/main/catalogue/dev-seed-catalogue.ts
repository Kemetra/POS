/**
 * 009-product-search-and-barcode-lookup T049b — dev-only catalogue seed.
 *
 * `products` / `product_barcodes` ship EMPTY (AD-2). This loader fills them with
 * realistic fixture rows IN DEVELOPMENT ONLY, so the live T049a surface (and the
 * S5 review tasks T050/T056) can exercise the happy path. It mirrors the
 * `applyDevSkip*IfRequested` bootstrap pattern.
 *
 * Activated ONLY when BOTH hold:
 *   1. `isShippedApp === false`  (unpackaged `electron .` dev/lab build / CI)
 *   2. `POS_PULSE_DEV_SEED_CATALOGUE` is truthy in the environment
 *
 * SECURITY: `isShippedApp === true` short-circuits unconditionally — the env var is
 * never consulted in the shipped app (a renamed copy of the shipped exe included,
 * RT-165); this cannot seed production. The loader is
 * called from a single site in `src/main/index.ts` and is never renderer-reachable.
 *
 * The `*_norm` / `*_fold` columns are derived by calling the production
 * `normalize()` — NEVER hand-typed (a divergent fold would seed a product that
 * cannot match its own search). Rows use `DEV_SEED_TENANT_ID`, matching the dev
 * operator fixture's tenant so the tenant-scoped repo (P17) can see them.
 */

import type { DatabaseHandle } from '../db/client.js';
import { normalize } from './normalize.js';

/** Dev tenant — MUST match `DEV_OPERATOR_FIXTURE_SESSION_INPUT.tenant_id`. */
export const DEV_SEED_TENANT_ID = 'dev-tenant';

interface FixtureBarcode {
  readonly barcode_id: string;
  readonly barcode: string;
  readonly barcode_kind: 'pack' | 'unit' | null;
}

interface FixtureProduct {
  readonly product_id: string;
  readonly sku: string;
  readonly name_ar: string;
  readonly name_en: string | null;
  /** JSON array string of alias terms, or null. */
  readonly aliases_json: string | null;
  readonly price_minor: number;
  readonly tax_category: string;
  readonly unit_pack_label: string | null;
  readonly active: 0 | 1;
  readonly controlled_substance: 0 | 1;
  readonly prescription_required: 0 | 1;
  readonly barcodes: readonly FixtureBarcode[];
}

/**
 * ~12 realistic Egyptian-pharmacy fixture products. Covers: Arabic+English
 * names, aliases (FR-13), price/unit-pack range, a controlled + an Rx product
 * (C1 badges), an inactive product (disabled/excluded path), pack+unit barcodes
 * on one product, and a `%`-literal name (LIKE-escape).
 */
export const DEV_CATALOGUE_FIXTURE: readonly FixtureProduct[] = [
  {
    product_id: 'dev-p-001',
    sku: 'PARA-500',
    name_ar: 'بنادول إكسترا',
    name_en: 'Panadol Extra',
    aliases_json: JSON.stringify(['paracetamol', 'باراسيتامول']),
    price_minor: 1500,
    tax_category: 'standard',
    unit_pack_label: '×20 أقراص',
    active: 1,
    controlled_substance: 0,
    prescription_required: 0,
    barcodes: [
      { barcode_id: 'dev-bc-001a', barcode: '6221000000011', barcode_kind: 'unit' },
      { barcode_id: 'dev-bc-001b', barcode: '6221000000012', barcode_kind: 'pack' },
    ],
  },
  {
    product_id: 'dev-p-002',
    sku: 'IBUP-400',
    name_ar: 'بروفين',
    name_en: 'Brufen 400mg',
    aliases_json: JSON.stringify(['ibuprofen', 'ايبوبروفين']),
    price_minor: 2200,
    tax_category: 'standard',
    unit_pack_label: '×30 أقراص',
    active: 1,
    controlled_substance: 0,
    prescription_required: 0,
    barcodes: [{ barcode_id: 'dev-bc-002', barcode: '6221000000020', barcode_kind: 'unit' }],
  },
  {
    product_id: 'dev-p-003',
    sku: 'AMOX-250',
    name_ar: 'أموكسيسيلين',
    name_en: 'Amoxicillin 250mg',
    aliases_json: null,
    price_minor: 4500,
    tax_category: 'standard',
    unit_pack_label: '×21 كبسولة',
    active: 1,
    controlled_substance: 0,
    prescription_required: 1,
    barcodes: [{ barcode_id: 'dev-bc-003', barcode: '6221000000037', barcode_kind: 'unit' }],
  },
  {
    product_id: 'dev-p-004',
    sku: 'TRAM-50',
    name_ar: 'ترامادول',
    name_en: 'Tramadol 50mg',
    aliases_json: null,
    price_minor: 3000,
    tax_category: 'standard',
    unit_pack_label: '×10 كبسولات',
    active: 1,
    controlled_substance: 1,
    prescription_required: 1,
    barcodes: [{ barcode_id: 'dev-bc-004', barcode: '6221000000044', barcode_kind: 'unit' }],
  },
  {
    product_id: 'dev-p-005',
    sku: 'VITC-1000',
    name_ar: 'فيتامين سي ١٠٠٠',
    name_en: 'Vitamin C 1000mg',
    aliases_json: JSON.stringify(['ascorbic acid']),
    price_minor: 1800,
    tax_category: 'standard',
    unit_pack_label: '×20 فوار',
    active: 1,
    controlled_substance: 0,
    prescription_required: 0,
    barcodes: [{ barcode_id: 'dev-bc-005', barcode: '6221000000051', barcode_kind: 'unit' }],
  },
  {
    product_id: 'dev-p-006',
    sku: 'OMEP-20',
    name_ar: 'أوميبرازول',
    name_en: 'Omeprazole 20mg',
    aliases_json: null,
    price_minor: 2700,
    tax_category: 'standard',
    unit_pack_label: '×14 كبسولة',
    active: 1,
    controlled_substance: 0,
    prescription_required: 0,
    barcodes: [{ barcode_id: 'dev-bc-006', barcode: '6221000000068', barcode_kind: 'unit' }],
  },
  {
    product_id: 'dev-p-007',
    sku: 'ALCO-70',
    name_ar: 'كحول طبي ٧٠٪',
    name_en: 'Medical Alcohol 70%',
    aliases_json: null,
    price_minor: 900,
    tax_category: 'standard',
    unit_pack_label: 'زجاجة ١٢٥ مل',
    active: 1,
    controlled_substance: 0,
    prescription_required: 0,
    barcodes: [{ barcode_id: 'dev-bc-007', barcode: '6221000000075', barcode_kind: 'unit' }],
  },
  {
    product_id: 'dev-p-008',
    sku: 'CETA-10',
    name_ar: 'سيتال شراب',
    name_en: 'Cetal Syrup',
    aliases_json: JSON.stringify(['paracetamol syrup']),
    price_minor: 1200,
    tax_category: 'standard',
    unit_pack_label: 'زجاجة ١٢٠ مل',
    active: 1,
    controlled_substance: 0,
    prescription_required: 0,
    barcodes: [{ barcode_id: 'dev-bc-008', barcode: '6221000000082', barcode_kind: 'unit' }],
  },
  {
    product_id: 'dev-p-009',
    sku: 'INSU-100',
    name_ar: 'إنسولين',
    name_en: 'Insulin 100IU',
    aliases_json: null,
    price_minor: 9500,
    tax_category: 'standard',
    unit_pack_label: 'قلم',
    active: 1,
    controlled_substance: 0,
    prescription_required: 1,
    barcodes: [{ barcode_id: 'dev-bc-009', barcode: '6221000000099', barcode_kind: 'unit' }],
  },
  {
    product_id: 'dev-p-010',
    sku: 'ASPI-75',
    name_ar: 'أسبرين ٧٥',
    name_en: 'Aspirin 75mg',
    aliases_json: JSON.stringify(['acetylsalicylic acid']),
    price_minor: 800,
    tax_category: 'standard',
    unit_pack_label: '×30 أقراص',
    active: 1,
    controlled_substance: 0,
    prescription_required: 0,
    barcodes: [{ barcode_id: 'dev-bc-010', barcode: '6221000000105', barcode_kind: 'unit' }],
  },
  {
    product_id: 'dev-p-011',
    sku: 'DISC-OLD',
    name_ar: 'منتج موقوف',
    name_en: 'Discontinued Product',
    aliases_json: null,
    price_minor: 500,
    tax_category: 'standard',
    unit_pack_label: null,
    active: 0,
    controlled_substance: 0,
    prescription_required: 0,
    barcodes: [{ barcode_id: 'dev-bc-011', barcode: '6221000000112', barcode_kind: 'unit' }],
  },
  {
    product_id: 'dev-p-012',
    sku: 'GLUC-5',
    name_ar: 'محلول جلوكوز ٥٪',
    name_en: 'Glucose Solution 5%',
    aliases_json: null,
    price_minor: 1100,
    tax_category: 'standard',
    unit_pack_label: 'كيس ٥٠٠ مل',
    active: 1,
    controlled_substance: 0,
    prescription_required: 0,
    barcodes: [{ barcode_id: 'dev-bc-012', barcode: '6221000000129', barcode_kind: 'unit' }],
  },
];

export interface DevSeedCatalogueDeps {
  /** `isShippedApp(...)` (RT-165): `app.isPackaged` OR running from the shipped `app.asar`. Seed runs ONLY when this is false. */
  isShippedApp: boolean;
  env: NodeJS.ProcessEnv;
  db: DatabaseHandle;
  logger: { warn(payload: object, msg: string): void };
}

function isTruthy(value: string | undefined): boolean {
  return (
    typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  );
}

/** Is the catalogue already populated? Used as the idempotency guard. */
function alreadyPopulated(db: DatabaseHandle): boolean {
  const stmt = db.prepare('SELECT 1 FROM products LIMIT 1') as {
    get(...p: unknown[]): unknown;
  };
  return stmt.get() !== undefined;
}

/**
 * If enabled (not shipped + env flag truthy) and the catalogue is empty, inserts
 * the fixture rows in one transaction and returns `true`. Otherwise no-ops and
 * returns `false`.
 */
export function applyDevSeedCatalogueIfRequested(deps: DevSeedCatalogueDeps): boolean {
  if (deps.isShippedApp) return false;
  if (!isTruthy(deps.env['POS_PULSE_DEV_SEED_CATALOGUE'])) return false;
  if (alreadyPopulated(deps.db)) return false;

  deps.logger.warn(
    {
      event: 'catalogue.dev_seed.active',
      packaged: false,
      flag: 'POS_PULSE_DEV_SEED_CATALOGUE',
      products: DEV_CATALOGUE_FIXTURE.length,
    },
    'DEV SEED: inserting fixture catalogue rows. Never enable in a packaged build.',
  );

  const now = '2026-05-31T00:00:00.000Z';

  const insertProduct = deps.db.prepare(`
    INSERT OR IGNORE INTO products
      (product_id, tenant_id, branch_id, sku, sku_norm, name_ar, name_en, name_fold,
       aliases_json, alias_fold, price_minor, tax_category, unit_pack_label, active,
       controlled_substance, prescription_required, row_version, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `) as { run(...p: unknown[]): unknown };

  const insertBarcode = deps.db.prepare(`
    INSERT OR IGNORE INTO product_barcodes
      (barcode_id, product_id, tenant_id, barcode, barcode_norm, barcode_kind, created_at)
    VALUES (?,?,?,?,?,?,?)
  `) as { run(...p: unknown[]): unknown };

  const seed = deps.db.transaction(() => {
    for (const p of DEV_CATALOGUE_FIXTURE) {
      // Money safety (P1): a fixture price must be a non-negative safe integer
      // before it reaches products.price_minor. The hardcoded fixtures satisfy
      // this; the guard documents the invariant and fails loud on a bad edit.
      if (!Number.isSafeInteger(p.price_minor) || p.price_minor < 0) {
        throw new Error(`dev-seed: invalid price_minor for fixture product ${p.product_id}`);
      }
      const nameFoldSource = p.name_en === null ? p.name_ar : `${p.name_ar} ${p.name_en}`;
      // Fold the alias terms (JSON array) into one searchable string, or null.
      let aliasFold: string | null = null;
      if (p.aliases_json !== null) {
        const parsed: unknown = JSON.parse(p.aliases_json);
        const aliases: string[] = Array.isArray(parsed) ? parsed.map(String) : [];
        aliasFold = normalize(aliases.join(' '));
      }
      insertProduct.run(
        p.product_id,
        DEV_SEED_TENANT_ID,
        null,
        p.sku,
        normalize(p.sku),
        p.name_ar,
        p.name_en,
        normalize(nameFoldSource),
        p.aliases_json,
        aliasFold,
        p.price_minor,
        p.tax_category,
        p.unit_pack_label,
        p.active,
        p.controlled_substance,
        p.prescription_required,
        'dev-v1',
        now,
        now,
      );
      for (const b of p.barcodes) {
        insertBarcode.run(
          b.barcode_id,
          p.product_id,
          DEV_SEED_TENANT_ID,
          b.barcode,
          normalize(b.barcode),
          b.barcode_kind,
          now,
        );
      }
    }
  });

  seed();
  return true;
}
