import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * 009-product-search-and-barcode-lookup T020 — S2 migrations integration test.
 *
 * Applies the full migration stack (0001…0030) via sql.js, then asserts the two
 * 009 read-model tables (`products`, `product_barcodes`) + their fold/norm
 * columns + indexes per the §A2-ratified DDL
 * (`migration-review/s2-migration-review.md` §4). Key §A2 decisions verified:
 *   • money `price_minor INTEGER CHECK (>= 0)` (P1);
 *   • booleans `active/controlled_substance/prescription_required IN (0,1)`;
 *   • indexes incl. `sku_norm` (D1) + `name_fold` (D2) + non-unique `barcode_norm` (D4);
 *   • both tables ship EMPTY (no seed rows — FR-24 / R-RISK-2);
 *   • both tables are MUTABLE — NO append-only trigger (read models, mutable by
 *     the future sourcing feature; contrast `sales`/`cart_action_outbox`).
 *
 * Mirrors `tests/integration/sales/migrations.test.ts`. Uses sql.js (pure-JS
 * SQLite) so the native better-sqlite3 binding is not required at test time.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

// Apply EVERY migration on disk, in sorted (production) order — including the
// two new 009 files once authored. Before they exist, the products assertions
// fail (RED).
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

let SQL: SqlJsStatic;
const sqlCache = new Map<string, string>();

function loadSql(name: string): string {
  let cached = sqlCache.get(name);
  if (cached === undefined) {
    cached = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    sqlCache.set(name, cached);
  }
  return cached;
}

beforeAll(async () => {
  SQL = await initSqlJs();
});

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of ALL_MIGRATIONS) db.exec(loadSql(name));
  return db;
}

function tableExists(db: SqlJsDatabase, name: string): boolean {
  const r = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`);
  return (r[0]?.values.length ?? 0) === 1;
}

function indexExists(db: SqlJsDatabase, name: string): boolean {
  const r = db.exec(`SELECT name FROM sqlite_master WHERE type='index' AND name='${name}'`);
  return (r[0]?.values.length ?? 0) === 1;
}

function triggerCount(db: SqlJsDatabase, table: string): number {
  const r = db.exec(
    `SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='${table}'`,
  );
  return Number(r[0]?.values[0]?.[0] ?? 0);
}

function columns(db: SqlJsDatabase, table: string): Set<string> {
  const r = db.exec(`PRAGMA table_info(${table})`);
  const names = new Set<string>();
  for (const row of r[0]?.values ?? []) names.add(String(row[1]));
  return names;
}

function rowCount(db: SqlJsDatabase, table: string): number {
  const r = db.exec(`SELECT count(*) FROM ${table}`);
  return Number(r[0]?.values[0]?.[0] ?? -1);
}

function insertProduct(db: SqlJsDatabase, o: Record<string, unknown> = {}): void {
  const row = {
    product_id: 'p-1',
    tenant_id: 'tenant-1',
    branch_id: null,
    sku: 'SKU-PARA-500',
    sku_norm: 'sku-para-500',
    name_ar: 'بنادول إكسترا 500 مجم',
    name_en: 'Panadol Extra 500mg',
    name_fold: 'بنادول اكسترا 500 مجم panadol extra 500mg',
    aliases_json: null,
    alias_fold: null,
    price_minor: 1500,
    tax_category: 'standard',
    unit_pack_label: '×20 أقراص',
    active: 1,
    controlled_substance: 0,
    prescription_required: 0,
    row_version: 'v1',
    created_at: '2026-05-31T00:00:00.000Z',
    updated_at: '2026-05-31T00:00:00.000Z',
    ...o,
  };
  db.run(
    `INSERT INTO products
       (product_id, tenant_id, branch_id, sku, sku_norm, name_ar, name_en, name_fold,
        aliases_json, alias_fold, price_minor, tax_category, unit_pack_label, active,
        controlled_substance, prescription_required, row_version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.product_id,
      row.tenant_id,
      row.branch_id,
      row.sku,
      row.sku_norm,
      row.name_ar,
      row.name_en,
      row.name_fold,
      row.aliases_json,
      row.alias_fold,
      row.price_minor,
      row.tax_category,
      row.unit_pack_label,
      row.active,
      row.controlled_substance,
      row.prescription_required,
      row.row_version,
      row.created_at,
      row.updated_at,
    ] as never[],
  );
}

function insertBarcode(db: SqlJsDatabase, o: Record<string, unknown> = {}): void {
  const row = {
    barcode_id: 'bc-1',
    product_id: 'p-1',
    tenant_id: 'tenant-1',
    barcode: '6221000000001',
    barcode_norm: '6221000000001',
    barcode_kind: 'unit',
    created_at: '2026-05-31T00:00:00.000Z',
    ...o,
  };
  db.run(
    `INSERT INTO product_barcodes
       (barcode_id, product_id, tenant_id, barcode, barcode_norm, barcode_kind, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      row.barcode_id,
      row.product_id,
      row.tenant_id,
      row.barcode,
      row.barcode_norm,
      row.barcode_kind,
      row.created_at,
    ] as never[],
  );
}

describe('T020 — 009 S2 migrations (products / product_barcodes)', () => {
  describe('schema presence', () => {
    it('creates the products table', () => {
      const db = freshDb();
      expect(tableExists(db, 'products')).toBe(true);
      db.close();
    });

    it('creates the product_barcodes table', () => {
      const db = freshDb();
      expect(tableExists(db, 'product_barcodes')).toBe(true);
      db.close();
    });

    it('products has the expected columns (incl. sku_norm, name_fold, alias_fold)', () => {
      const db = freshDb();
      const cols = columns(db, 'products');
      for (const c of [
        'product_id',
        'tenant_id',
        'branch_id',
        'sku',
        'sku_norm',
        'name_ar',
        'name_en',
        'name_fold',
        'aliases_json',
        'alias_fold',
        'price_minor',
        'tax_category',
        'unit_pack_label',
        'active',
        'controlled_substance',
        'prescription_required',
        'row_version',
        'created_at',
        'updated_at',
      ]) {
        expect(cols.has(c), `products.${c}`).toBe(true);
      }
      db.close();
    });

    it('product_barcodes has the expected columns (incl. barcode_norm)', () => {
      const db = freshDb();
      const cols = columns(db, 'product_barcodes');
      for (const c of [
        'barcode_id',
        'product_id',
        'tenant_id',
        'barcode',
        'barcode_norm',
        'barcode_kind',
        'created_at',
      ]) {
        expect(cols.has(c), `product_barcodes.${c}`).toBe(true);
      }
      db.close();
    });

    it('declares the §A2 indexes', () => {
      const db = freshDb();
      expect(indexExists(db, 'idx_products_tenant_sku_norm')).toBe(true);
      expect(indexExists(db, 'idx_products_tenant_name_fold')).toBe(true);
      expect(indexExists(db, 'idx_products_tenant_alias_fold')).toBe(true);
      expect(indexExists(db, 'idx_product_barcodes_tenant_norm')).toBe(true);
      expect(indexExists(db, 'idx_product_barcodes_product')).toBe(true);
      db.close();
    });
  });

  describe('ships empty (FR-24 / R-RISK-2 — production shows catalogue-unavailable until sourced)', () => {
    it('products + product_barcodes have zero seed rows', () => {
      const db = freshDb();
      expect(rowCount(db, 'products')).toBe(0);
      expect(rowCount(db, 'product_barcodes')).toBe(0);
      db.close();
    });
  });

  describe('happy-path inserts', () => {
    it('inserts a product row', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db);
      }).not.toThrow();
      db.close();
    });

    it('inserts a product_barcode row', () => {
      const db = freshDb();
      insertProduct(db);
      expect(() => {
        insertBarcode(db);
      }).not.toThrow();
      db.close();
    });

    it('allows multiple barcodes mapping to ONE product (pack + unit — not ambiguous)', () => {
      const db = freshDb();
      insertProduct(db);
      insertBarcode(db, {
        barcode_id: 'bc-unit',
        barcode_norm: '6221000000001',
        barcode_kind: 'unit',
      });
      expect(() => {
        insertBarcode(db, {
          barcode_id: 'bc-pack',
          barcode_norm: '6221000000002',
          barcode_kind: 'pack',
        });
      }).not.toThrow();
      db.close();
    });

    it('allows the SAME barcode_norm on two distinct products (the ambiguity case is app-detected, not blocked — D4)', () => {
      const db = freshDb();
      insertProduct(db, { product_id: 'p-1' });
      insertProduct(db, { product_id: 'p-2', sku: 'SKU-OTHER', sku_norm: 'sku-other' });
      insertBarcode(db, { barcode_id: 'bc-1', product_id: 'p-1', barcode_norm: 'DUP' });
      expect(() => {
        insertBarcode(db, { barcode_id: 'bc-2', product_id: 'p-2', barcode_norm: 'DUP' });
      }).not.toThrow();
      db.close();
    });
  });

  describe('CHECK constraints', () => {
    it('rejects a negative price_minor (P1)', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db, { price_minor: -1 });
      }).toThrow();
      db.close();
    });

    it('rejects an out-of-range active flag (must be 0 or 1)', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db, { active: 2 });
      }).toThrow();
      db.close();
    });
  });

  describe('read models are MUTABLE — no append-only trigger (contrast sales/outbox)', () => {
    it('products has zero triggers', () => {
      const db = freshDb();
      expect(triggerCount(db, 'products')).toBe(0);
      db.close();
    });

    it('product_barcodes has zero triggers', () => {
      const db = freshDb();
      expect(triggerCount(db, 'product_barcodes')).toBe(0);
      db.close();
    });

    it('allows UPDATE + DELETE on products (sourcing feature mutates the read model)', () => {
      const db = freshDb();
      insertProduct(db);
      expect(() => {
        db.run("UPDATE products SET active = 0 WHERE product_id = 'p-1'");
      }).not.toThrow();
      expect(() => {
        db.run("DELETE FROM products WHERE product_id = 'p-1'");
      }).not.toThrow();
      db.close();
    });

    it('allows UPDATE + DELETE on product_barcodes (sourcing feature mutates the read model)', () => {
      const db = freshDb();
      insertProduct(db);
      insertBarcode(db);
      expect(() => {
        db.run("UPDATE product_barcodes SET barcode_kind = 'pack' WHERE barcode_id = 'bc-1'");
      }).not.toThrow();
      expect(() => {
        db.run("DELETE FROM product_barcodes WHERE barcode_id = 'bc-1'");
      }).not.toThrow();
      db.close();
    });
  });

  describe('CHECK constraints — full boolean guards', () => {
    it('rejects controlled_substance out of range (must be 0 or 1)', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db, { controlled_substance: 2 });
      }).toThrow();
      db.close();
    });

    it('rejects prescription_required out of range (must be 0 or 1)', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db, { prescription_required: 2 });
      }).toThrow();
      db.close();
    });

    it('accepts price_minor = 0 (boundary — free items are valid, P1)', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db, { price_minor: 0 });
      }).not.toThrow();
      db.close();
    });

    it('rejects active = -1 (negative is out of range for boolean)', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db, { active: -1 });
      }).toThrow();
      db.close();
    });
  });

  describe('PRIMARY KEY enforcement', () => {
    it('rejects a duplicate product_id', () => {
      const db = freshDb();
      insertProduct(db, { product_id: 'p-dup' });
      expect(() => {
        insertProduct(db, {
          product_id: 'p-dup',
          sku: 'SKU-OTHER',
          sku_norm: 'sku-other',
        });
      }).toThrow();
      db.close();
    });

    it('rejects a duplicate barcode_id', () => {
      const db = freshDb();
      insertProduct(db);
      insertBarcode(db, { barcode_id: 'bc-dup' });
      expect(() => {
        insertBarcode(db, { barcode_id: 'bc-dup', barcode_norm: 'OTHER' });
      }).toThrow();
      db.close();
    });
  });

  describe('NOT NULL enforcement — products', () => {
    it('rejects NULL product_id', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO products
             (product_id, tenant_id, sku, sku_norm, name_ar, name_fold,
              price_minor, tax_category, row_version, created_at, updated_at)
           VALUES (NULL, 'tenant-1', 'SKU-1', 'sku-1', 'name', 'name',
                   100, 'standard', 'v1', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z')`,
        );
      }).toThrow();
      db.close();
    });

    it('rejects NULL tenant_id on products', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO products
             (product_id, tenant_id, sku, sku_norm, name_ar, name_fold,
              price_minor, tax_category, row_version, created_at, updated_at)
           VALUES ('p-1', NULL, 'SKU-1', 'sku-1', 'name', 'name',
                   100, 'standard', 'v1', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z')`,
        );
      }).toThrow();
      db.close();
    });

    it('rejects NULL name_ar (Arabic-first display name is required)', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO products
             (product_id, tenant_id, sku, sku_norm, name_ar, name_fold,
              price_minor, tax_category, row_version, created_at, updated_at)
           VALUES ('p-1', 'tenant-1', 'SKU-1', 'sku-1', NULL, 'name',
                   100, 'standard', 'v1', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z')`,
        );
      }).toThrow();
      db.close();
    });

    it('rejects NULL price_minor (P1)', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO products
             (product_id, tenant_id, sku, sku_norm, name_ar, name_fold,
              price_minor, tax_category, row_version, created_at, updated_at)
           VALUES ('p-1', 'tenant-1', 'SKU-1', 'sku-1', 'name', 'name',
                   NULL, 'standard', 'v1', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z')`,
        );
      }).toThrow();
      db.close();
    });

    it('rejects NULL tax_category (D3 — required even when not threaded downstream)', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO products
             (product_id, tenant_id, sku, sku_norm, name_ar, name_fold,
              price_minor, tax_category, row_version, created_at, updated_at)
           VALUES ('p-1', 'tenant-1', 'SKU-1', 'sku-1', 'name', 'name',
                   100, NULL, 'v1', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z')`,
        );
      }).toThrow();
      db.close();
    });

    it('rejects NULL row_version (R9 change marker is required)', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO products
             (product_id, tenant_id, sku, sku_norm, name_ar, name_fold,
              price_minor, tax_category, row_version, created_at, updated_at)
           VALUES ('p-1', 'tenant-1', 'SKU-1', 'sku-1', 'name', 'name',
                   100, 'standard', NULL, '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z')`,
        );
      }).toThrow();
      db.close();
    });
  });

  describe('NOT NULL enforcement — product_barcodes', () => {
    it('rejects NULL barcode_id', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO product_barcodes
             (barcode_id, product_id, tenant_id, barcode, barcode_norm, created_at)
           VALUES (NULL, 'p-1', 'tenant-1', '12345', '12345', '2026-05-31T00:00:00.000Z')`,
        );
      }).toThrow();
      db.close();
    });

    it('rejects NULL product_id on product_barcodes', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO product_barcodes
             (barcode_id, product_id, tenant_id, barcode, barcode_norm, created_at)
           VALUES ('bc-1', NULL, 'tenant-1', '12345', '12345', '2026-05-31T00:00:00.000Z')`,
        );
      }).toThrow();
      db.close();
    });

    it('rejects NULL barcode_norm (the indexed lookup key — R2/R3)', () => {
      const db = freshDb();
      expect(() => {
        db.run(
          `INSERT INTO product_barcodes
             (barcode_id, product_id, tenant_id, barcode, barcode_norm, created_at)
           VALUES ('bc-1', 'p-1', 'tenant-1', '12345', NULL, '2026-05-31T00:00:00.000Z')`,
        );
      }).toThrow();
      db.close();
    });
  });

  describe('nullable columns — accepted as NULL', () => {
    it('accepts NULL branch_id (forward-looking: tenant-scoped at MVP, R-RISK-4)', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db, { branch_id: null });
      }).not.toThrow();
      db.close();
    });

    it('accepts NULL name_en (English name is optional)', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db, { name_en: null });
      }).not.toThrow();
      db.close();
    });

    it('accepts NULL aliases_json (FR-13 — aliases are optional)', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db, { aliases_json: null, alias_fold: null });
      }).not.toThrow();
      db.close();
    });

    it('accepts NULL unit_pack_label (dosage label is optional)', () => {
      const db = freshDb();
      expect(() => {
        insertProduct(db, { unit_pack_label: null });
      }).not.toThrow();
      db.close();
    });

    it('accepts NULL barcode_kind (informational field — pack / unit are optional labels)', () => {
      const db = freshDb();
      insertProduct(db);
      expect(() => {
        insertBarcode(db, { barcode_kind: null });
      }).not.toThrow();
      db.close();
    });
  });

  describe('DEFAULT values', () => {
    it.each([
      { column: 'active', expected: 1, note: '1 (sellable)' },
      { column: 'controlled_substance', expected: 0, note: '0' },
      { column: 'prescription_required', expected: 0, note: '0' },
    ])('$column defaults to $note when omitted', ({ column, expected }) => {
      const db = freshDb();
      db.run(
        `INSERT INTO products
           (product_id, tenant_id, sku, sku_norm, name_ar, name_fold,
            price_minor, tax_category, row_version, created_at, updated_at)
         VALUES ('p-def', 'tenant-1', 'SKU-1', 'sku-1',
                 'بنادول', 'بنادول', 100, 'standard', 'v1',
                 '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z')`,
      );
      const r = db.exec(`SELECT ${column} FROM products WHERE product_id = 'p-def'`);
      expect(Number(r[0]?.values[0]?.[0])).toBe(expected);
      db.close();
    });
  });

  describe('migration idempotency — IF NOT EXISTS prevents re-run failures', () => {
    it('re-applying migration 0029 does not throw (CREATE TABLE IF NOT EXISTS)', () => {
      const db = freshDb();
      expect(() => {
        db.exec(loadSql('0029_create_products.sql'));
      }).not.toThrow();
      db.close();
    });

    it('re-applying migration 0030 does not throw (CREATE TABLE IF NOT EXISTS)', () => {
      const db = freshDb();
      expect(() => {
        db.exec(loadSql('0030_create_product_barcodes.sql'));
      }).not.toThrow();
      db.close();
    });
  });

  describe('schema shape — column count regression guard', () => {
    it('products has exactly 19 columns (no accidental additions or omissions)', () => {
      const db = freshDb();
      const cols = columns(db, 'products');
      expect(cols.size).toBe(19);
      db.close();
    });

    it('product_barcodes has exactly 7 columns (no accidental additions or omissions)', () => {
      const db = freshDb();
      const cols = columns(db, 'product_barcodes');
      expect(cols.size).toBe(7);
      db.close();
    });
  });
});
