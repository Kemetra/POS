import { describe, expect, it } from 'vitest';

import { mapSellableRow, type SellableCatalogRow } from '../map-sellable-row.js';

/**
 * 010 T015a (RED) — `mapSellableRow`.
 *
 * Maps the SHIPPED backend `SellableCatalogRow` (Data-Pulse-2 PR #490) to the
 * internal `{ product, barcodes[] }` record 009's read model needs. Pure, no I/O,
 * no float arithmetic. Asserts the three owner-ratified GAP mappings:
 *
 *   • GAP-1 (money): decimal string + currency_code → integer minor units via
 *     exact string→int (×10^exponent; EGP exponent 2, keyed off currency_code),
 *     NEVER a float; non-representable amounts rejected.
 *   • D-NAME: single `name` → `name_ar := name`, `name_en := null`.
 *   • D-BARCODE: each untyped `aliases[]` entry → one barcode record with
 *     `barcode_kind := null`; `barcode_id` synthesized; `sku` kept distinct (it
 *     is NOT a barcode).
 */

function row(overrides: Partial<SellableCatalogRow> = {}): SellableCatalogRow {
  return {
    product_id: 'p-1',
    sku: 'SKU-PARA-500',
    name: 'بنادول إكسترا',
    aliases: ['6221000000001'],
    price: { amount: '9.99', currency_code: 'EGP' },
    tax_category: 'standard',
    active: true,
    row_cursor: 'cur-1',
    ...overrides,
  };
}

describe('T015a — mapSellableRow GAP-1 money (decimal string → integer minor units)', () => {
  it.each([
    {
      name: 'converts an EGP decimal string to integer minor units (exponent 2)',
      amount: '9.99',
      expected: 999,
    },
    {
      name: 'handles a whole-number amount with no fractional part',
      amount: '10',
      expected: 1000,
    },
    {
      // 0.1 + 0.2 in float === 0.30000000000000004; string math must give 30.
      name: 'produces an exact integer (never via a JS float) for a tricky decimal',
      amount: '0.30',
      expected: 30,
    },
  ])('$name', ({ amount, expected }) => {
    const r = mapSellableRow(row({ price: { amount, currency_code: 'EGP' } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.product.price_minor).toBe(expected);
  });

  it('handles zero and a single fractional digit', () => {
    expect(mapSellableRow(row({ price: { amount: '0.00', currency_code: 'EGP' } }))).toMatchObject({
      ok: true,
      value: { product: { price_minor: 0 } },
    });
    expect(mapSellableRow(row({ price: { amount: '9.9', currency_code: 'EGP' } }))).toMatchObject({
      ok: true,
      value: { product: { price_minor: 990 } },
    });
  });

  it('rejects an amount with MORE fractional digits than the currency exponent', () => {
    const r = mapSellableRow(row({ price: { amount: '9.999', currency_code: 'EGP' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/money|representable|fractional/i);
  });

  it('rejects a non-numeric amount string', () => {
    expect(mapSellableRow(row({ price: { amount: 'abc', currency_code: 'EGP' } })).ok).toBe(false);
    expect(mapSellableRow(row({ price: { amount: '', currency_code: 'EGP' } })).ok).toBe(false);
  });

  it('rejects a negative amount (price_minor must be >= 0, P1)', () => {
    expect(mapSellableRow(row({ price: { amount: '-1.00', currency_code: 'EGP' } })).ok).toBe(
      false,
    );
  });

  it('rejects an amount that exceeds Number.MAX_SAFE_INTEGER in minor units', () => {
    // 1e16 EGP × 100 = 1e18 minor > MAX_SAFE_INTEGER (~9.007e15).
    const r = mapSellableRow(
      row({ price: { amount: '100000000000000.00', currency_code: 'EGP' } }),
    );
    expect(r.ok).toBe(false);
  });
});

describe('T015a — mapSellableRow D-NAME (single name → name_ar / name_en)', () => {
  it('maps the single backend name to name_ar and leaves name_en null', () => {
    const r = mapSellableRow(row({ name: 'Panadol Extra' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.product.name_ar).toBe('Panadol Extra');
      expect(r.value.product.name_en).toBeNull();
    }
  });
});

describe('T015a — mapSellableRow D-BARCODE (untyped aliases[] → barcode records)', () => {
  it('explodes each alias into one barcode record with barcode_kind null', () => {
    const r = mapSellableRow(row({ aliases: ['6221000000001', 'PLU-42'] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.barcodes).toHaveLength(2);
      expect(r.value.barcodes.map((b) => b.barcode)).toEqual(['6221000000001', 'PLU-42']);
      for (const b of r.value.barcodes) {
        expect(b.barcode_kind).toBeNull();
        expect(b.barcode_id).toBeTruthy(); // synthesized, non-empty
        expect(b.product_id).toBe('p-1');
      }
      // Synthesized ids are distinct per alias.
      expect(new Set(r.value.barcodes.map((b) => b.barcode_id)).size).toBe(2);
    }
  });

  it('keeps sku distinct from the alias bag (sku is NOT a barcode)', () => {
    const r = mapSellableRow(row({ sku: 'SKU-X', aliases: ['BC-1'] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.product.sku).toBe('SKU-X');
      expect(r.value.barcodes.map((b) => b.barcode)).not.toContain('SKU-X');
    }
  });

  it('produces zero barcode records when aliases is empty or absent', () => {
    expect(mapSellableRow(row({ aliases: [] }))).toMatchObject({
      ok: true,
      value: { barcodes: [] },
    });
    const noAliases = row();
    delete (noAliases as Partial<SellableCatalogRow>).aliases;
    const r = mapSellableRow(noAliases);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.barcodes).toEqual([]);
  });

  it('carries aliases through to aliases_json for substring search', () => {
    const r = mapSellableRow(row({ aliases: ['alpha', 'beta'] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const json = r.value.product.aliases_json ?? '[]';
      expect(JSON.parse(json)).toEqual(['alpha', 'beta']);
    }
  });
});

describe('T015a — mapSellableRow carries identity + provenance', () => {
  it('carries product_id, tax_category, active flag and row provenance', () => {
    const r = mapSellableRow(row({ active: false, tax_category: 'exempt', row_cursor: 'cur-9' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.product.product_id).toBe('p-1');
      expect(r.value.product.tax_category).toBe('exempt');
      expect(r.value.product.active).toBe(0);
      expect(r.value.product.row_version).toBe('cur-9');
    }
  });
});
