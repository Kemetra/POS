import type { JSX } from 'react';
import type { DemoProduct } from './demo-sale';

interface ProductRailProps {
  readonly products: readonly DemoProduct[];
}

function ProductRow({ product }: { readonly product: DemoProduct }): JSX.Element {
  return (
    <li className="v5-sale-product-row">
      <div className="v5-sale-product-copy">
        <strong>{product.name}</strong>
        <span lang="en" dir="ltr" className="v5-sale-secondary-name">
          {product.englishName}
        </span>
        <span className="v5-sale-product-meta">
          {product.form}
          <bdi dir="ltr">{product.barcode}</bdi>
        </span>
      </div>
      <div className="v5-sale-product-tail">
        <span className="v5-sale-product-price" dir="ltr">
          {product.unitPrice}
        </span>
        <span className="v5-sale-currency">ج.م</span>
        <span className="v5-sale-add-mark" aria-hidden="true">
          ＋
        </span>
      </div>
    </li>
  );
}

export function ProductRail({ products }: ProductRailProps): JSX.Element {
  return (
    <section className="v5-sale-products" aria-labelledby="v5-sale-products-title">
      <div className="v5-sale-region-heading">
        <div>
          <span className="v5-sale-eyebrow">اكتشاف المنتجات</span>
          <h2 id="v5-sale-products-title">الأصناف والمنتجات</h2>
        </div>
        <span className="v5-sale-count" aria-label={`${String(products.length)} منتجات معروضة`}>
          {products.length} أصناف
        </span>
      </div>
      <div className="v5-sale-search-area">
        <label htmlFor="v5-sale-product-search">البحث بالاسم أو الباركود</label>
        <div className="v5-sale-search-field">
          <span aria-hidden="true" className="v5-sale-search-icon">
            ⌕
          </span>
          <input
            id="v5-sale-product-search"
            type="search"
            placeholder="اسم الصنف أو الباركود"
            readOnly
            aria-describedby="v5-sale-search-note"
          />
          <span className="v5-sale-key-hint" dir="ltr">
            F2
          </span>
        </div>
        <p id="v5-sale-search-note">للعرض فقط؛ البحث والمسح غير متصلين في هذه المعاينة.</p>
      </div>
      <div className="v5-sale-list-heading">
        <span>أصناف للعرض</span>
        <span>السعر</span>
      </div>
      <ul className="v5-sale-product-list" aria-label="أصناف توضيحية">
        {products.map((product) => (
          <ProductRow key={product.barcode} product={product} />
        ))}
      </ul>
    </section>
  );
}
