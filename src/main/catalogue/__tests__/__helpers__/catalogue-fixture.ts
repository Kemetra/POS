/**
 * 009-product-search-and-barcode-lookup S2 — shared catalogue repo test fixture.
 *
 * Builds a fresh sql.js database with the FULL migration stack applied (so the
 * `products` / `product_barcodes` read model exists exactly as production sees
 * it), wraps it in the production `DatabaseHandle` interface (`makeSqlJsHandle`),
 * and seeds rows.
 *
 * CRITICAL — the `*_norm` / `*_fold` columns are computed by calling the REAL
 * `normalize()` (the same function the bridge folds queries with, FR-12b). Tests
 * MUST NOT hand-type the folded form: a fixture whose `sku_norm` diverges from
 * `normalize(sku)` would validate a fiction. `seedProduct` / `seedBarcode`
 * therefore derive `sku_norm`, `name_fold`, `alias_fold`, and `barcode_norm`
 * from the raw values via `normalize()` unless the caller overrides them.
 */
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DatabaseHandle } from '../../../db/client.js';
import { normalize } from '../../normalize.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
// __tests__/__helpers__ → catalogue → main → src → repo root
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

/**
 * Narrow a value the test KNOWS is present (a `.get()` of a row that must exist,
 * a `read()` after a write) to non-null without a forbidden `!` assertion. Throws
 * (failing the test) if the value is absent.
 */
export function nn<T>(value: T | null | undefined, message = 'expected a value, got null'): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

let SQL: SqlJsStatic | undefined;

/** Initialise the sql.js engine once. Call in a `beforeAll`. */
export async function initCatalogueSql(): Promise<void> {
  if (SQL === undefined) SQL = await initSqlJs();
}

/** A raw sql.js database with EVERY migration applied (products/barcodes empty). */
export function freshCatalogueDb(): SqlJsDatabase {
  if (SQL === undefined) {
    throw new Error('initCatalogueSql() must be awaited in beforeAll before freshCatalogueDb()');
  }
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of ALL_MIGRATIONS) db.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  return db;
}

/**
 * Wrap a sql.js database in the production `DatabaseHandle` interface so the
 * repo runs unmodified under Vitest (sql.js is pure-JS WASM SQLite — it loads in
 * Node without the Electron-rebuilt better-sqlite3 binary). Inlined here, in
 * `src/`, rather than imported from `tests/` so it stays inside the main
 * tsconfig `rootDir` (cross-rootDir test-helper imports break `tsc`).
 */
export function handleFor(db: SqlJsDatabase): DatabaseHandle {
  const bindParams = (params: unknown[]): (string | number | null | Uint8Array)[] =>
    params.map((p) => {
      if (p === undefined) return null;
      if (typeof p === 'boolean') return p ? 1 : 0;
      return p as string | number | null | Uint8Array;
    });

  return {
    pragma: () => null,
    prepare(sql: string): unknown {
      return {
        run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
          const stmt = db.prepare(sql);
          try {
            stmt.run(bindParams(params));
            return { changes: db.getRowsModified(), lastInsertRowid: 0 };
          } finally {
            stmt.free();
          }
        },
        get(...params: unknown[]): unknown {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(bindParams(params));
            if (!stmt.step()) return undefined;
            return stmt.getAsObject();
          } finally {
            stmt.free();
          }
        },
        all(...params: unknown[]): unknown[] {
          const stmt = db.prepare(sql);
          const rows: Record<string, unknown>[] = [];
          try {
            stmt.bind(bindParams(params));
            while (stmt.step()) rows.push(stmt.getAsObject());
            return rows;
          } finally {
            stmt.free();
          }
        },
      };
    },
    exec(sql: string): void {
      db.run(sql);
    },
    transaction<T extends (...args: never[]) => unknown>(fn: T): T {
      return ((...args: unknown[]): unknown => {
        db.run('BEGIN');
        try {
          const result = (fn as unknown as (...a: unknown[]) => unknown)(...args);
          db.run('COMMIT');
          return result;
        } catch (err) {
          db.run('ROLLBACK');
          throw err;
        }
      }) as unknown as T;
    },
    close(): void {
      db.close();
    },
  };
}

export interface SeedProductInput {
  product_id?: string;
  tenant_id?: string;
  branch_id?: string | null;
  sku?: string;
  /** Override the normalized SKU; defaults to `normalize(sku)`. */
  sku_norm?: string;
  name_ar?: string;
  name_en?: string | null;
  /** Override the name fold; defaults to `normalize(name_ar + ' ' + name_en)`. */
  name_fold?: string;
  aliases_json?: string | null;
  alias_fold?: string | null;
  price_minor?: number;
  tax_category?: string;
  unit_pack_label?: string | null;
  active?: 0 | 1;
  controlled_substance?: 0 | 1;
  prescription_required?: 0 | 1;
  row_version?: string;
  created_at?: string;
  updated_at?: string;
}

/** Insert a product, deriving fold columns from the raw values via `normalize()`. */
export function seedProduct(db: SqlJsDatabase, o: SeedProductInput = {}): void {
  const sku = o.sku ?? 'SKU-PARA-500';
  const name_ar = o.name_ar ?? 'بنادول إكسترا';
  const name_en = o.name_en === undefined ? 'Panadol Extra' : o.name_en;
  const nameFoldSource = name_en === null ? name_ar : `${name_ar} ${name_en}`;
  const row = {
    product_id: o.product_id ?? 'p-1',
    tenant_id: o.tenant_id ?? 'tenant-1',
    branch_id: o.branch_id ?? null,
    sku,
    sku_norm: o.sku_norm ?? normalize(sku),
    name_ar,
    name_en,
    name_fold: o.name_fold ?? normalize(nameFoldSource),
    aliases_json: o.aliases_json ?? null,
    alias_fold: o.alias_fold ?? null,
    price_minor: o.price_minor ?? 1500,
    tax_category: o.tax_category ?? 'standard',
    unit_pack_label: o.unit_pack_label === undefined ? '×20 أقراص' : o.unit_pack_label,
    active: o.active ?? 1,
    controlled_substance: o.controlled_substance ?? 0,
    prescription_required: o.prescription_required ?? 0,
    row_version: o.row_version ?? 'v1',
    created_at: o.created_at ?? '2026-05-31T00:00:00.000Z',
    updated_at: o.updated_at ?? '2026-05-31T00:00:00.000Z',
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

export interface SeedBarcodeInput {
  barcode_id?: string;
  product_id?: string;
  tenant_id?: string;
  barcode?: string;
  /** Override the normalized barcode; defaults to `normalize(barcode)`. */
  barcode_norm?: string;
  barcode_kind?: string | null;
  created_at?: string;
}

/** Insert a barcode mapping, deriving `barcode_norm` from the raw value via `normalize()`. */
export function seedBarcode(db: SqlJsDatabase, o: SeedBarcodeInput = {}): void {
  const barcode = o.barcode ?? '6221000000001';
  const row = {
    barcode_id: o.barcode_id ?? 'bc-1',
    product_id: o.product_id ?? 'p-1',
    tenant_id: o.tenant_id ?? 'tenant-1',
    barcode,
    barcode_norm: o.barcode_norm ?? normalize(barcode),
    barcode_kind: o.barcode_kind === undefined ? 'unit' : o.barcode_kind,
    created_at: o.created_at ?? '2026-05-31T00:00:00.000Z',
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
