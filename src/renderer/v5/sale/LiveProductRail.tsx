import { useEffect, useRef, useState, type ChangeEvent, type JSX, type KeyboardEvent } from 'react';
import type { CatalogueSearchState } from '../../stores/catalogueSearchStore';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import { useDebouncedSearch } from '../../stores/useDebouncedSearch';
import { format, of } from '../../../shared/money';
import type { FreshnessState, RefreshFeedback } from '../../sale/useCatalogueFreshness';
import { SaleProductFlags } from './SaleProductFlags';

interface Props {
  state: CatalogueSearchState;
  enabled: boolean;
  freshness: FreshnessState;
  lastSuccessAt: string | null;
  feedback: RefreshFeedback;
  refreshing: boolean;
  onRefresh: () => void;
  onSearch: (query: string) => void;
  onScan: (barcode: string) => void;
  onSelect: (product: ProductSnapshotDisplay) => void;
  onRecover: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}

/** Absolute Arabic timestamp; an unparseable value is shown verbatim rather than throwing. */
function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ar-EG', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function LiveProductRail(props: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [barcode, setBarcode] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const search = useDebouncedSearch(props.onSearch);
  const results = props.state.kind === 'results' ? props.state.items : [];
  const resultRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    setActiveIndex(0);
  }, [props.state]);

  function handleSearchChange(event: ChangeEvent<HTMLInputElement>): void {
    const value = event.target.value;
    setQuery(value);
    if (value.length === 0) props.onRecover();
    search.onType(value);
  }
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      search.onScanSubmit(query);
    }
  }
  function handleScanKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = barcode.trim();
    setBarcode('');
    if (value.length > 0) props.onScan(value);
  }
  function handleResultsKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    if (results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = results[activeIndex];
      if (selected) props.onSelect(selected);
    }
  }
  const stamp = props.lastSuccessAt === null ? '' : formatStamp(props.lastSuccessAt);

  return (
    <section className="v5-sale-products" aria-labelledby="v5-live-products-title">
      <div className="v5-sale-region-heading">
        <div>
          <span className="v5-sale-eyebrow">اكتشاف المنتجات</span>
          <h2 id="v5-live-products-title">الأصناف والمنتجات</h2>
        </div>
        <span className="v5-sale-count">{results.length} أصناف</span>
      </div>
      {props.enabled ? (
        <>
          <div className="v5-sale-search-area">
            <label htmlFor="v5-live-search">البحث بالاسم أو الباركود</label>
            <div className="v5-sale-search-field">
              <span aria-hidden="true" className="v5-sale-search-icon">
                ⌕
              </span>
              <input
                ref={props.searchRef}
                id="v5-live-search"
                type="search"
                value={query}
                onChange={handleSearchChange}
                onKeyDown={handleSearchKeyDown}
                placeholder="اسم الصنف أو الباركود"
                autoComplete="off"
                aria-describedby="v5-live-search-note"
              />
            </div>
            <p id="v5-live-search-note">اكتب حرفين للبحث، أو اضغط Enter للبحث فورًا.</p>
            <label htmlFor="v5-live-scan" className="v5-live-scan-label">
              التقاط مسح الباركود
            </label>
            <div className="v5-sale-search-field">
              <input
                id="v5-live-scan"
                type="text"
                inputMode="none"
                placeholder="امسح الباركود هنا"
                autoComplete="off"
                value={barcode}
                onChange={(event) => {
                  setBarcode(event.target.value);
                }}
                onKeyDown={handleScanKeyDown}
                aria-label="حقل التقاط مسح الباركود"
              />
            </div>
            <div className="v5-live-freshness" role="status" aria-live="polite">
              <span>
                {props.freshness === 'loading'
                  ? 'جارٍ القراءة…'
                  : props.freshness === 'never-synced'
                    ? 'لم يُنزّل الكتالوج بعد'
                    : props.freshness === 'synced-empty'
                      ? `تم التحديث، لكن لا توجد منتجات (${stamp})`
                      : props.freshness === 'updated'
                        ? `آخر تحديث: ${stamp}`
                        : 'حالة الكتالوج غير متاحة'}
              </span>
              {props.feedback !== 'idle' && (
                <span>
                  {props.feedback === 'started' ? 'جارٍ التحديث…' : 'جارٍ التحديث بالفعل'}
                </span>
              )}
              <button type="button" onClick={props.onRefresh} disabled={props.refreshing}>
                تحديث الكتالوج
              </button>
            </div>
          </div>
          <div className="v5-sale-list-heading">
            <span>نتائج البحث</span>
            <span>السعر</span>
          </div>
          {props.state.kind === 'searching' && (
            <p className="v5-live-message" role="status" aria-busy="true">
              جارٍ البحث…
            </p>
          )}
          {props.state.kind === 'idle' && (
            <p className="v5-live-message">ابحث عن صنف لعرض المنتجات المتاحة.</p>
          )}
          {props.state.kind === 'not_found' && (
            <p className="v5-live-message" role="status">
              لم يُعثر على الصنف.{' '}
              <button type="button" onClick={props.onRecover}>
                تعديل البحث
              </button>
            </p>
          )}
          {props.state.kind === 'ambiguous' && (
            <p className="v5-live-message" role="status">
              تطابق أكثر من صنف مع الباركود.{' '}
              <button type="button" onClick={props.onRecover}>
                حاول مرة أخرى
              </button>
            </p>
          )}
          {props.state.kind === 'catalogue_unavailable' && (
            <p className="v5-live-message" role="alert">
              الكتالوج غير متاح حاليًا.
            </p>
          )}
          {props.state.kind === 'results' && (
            <ul
              ref={resultRef}
              className="v5-sale-product-list"
              role="listbox"
              tabIndex={0}
              aria-label="نتائج البحث"
              aria-activedescendant={`v5-live-result-${String(activeIndex)}`}
              onKeyDown={handleResultsKeyDown}
            >
              {results.map((product, index) => (
                <li
                  key={product.product_id}
                  id={`v5-live-result-${String(index)}`}
                  className="v5-sale-product-row"
                  role="option"
                  aria-selected={index === activeIndex}
                >
                  <div className="v5-sale-product-copy">
                    <strong>{product.display_name_ar}</strong>
                    {product.display_name_en && (
                      <span lang="en" dir="ltr" className="v5-sale-secondary-name">
                        {product.display_name_en}
                      </span>
                    )}
                    <SaleProductFlags product={product} />
                    {(product.unit_pack_label ?? product.selling_barcode ?? product.sku) && (
                      <span className="v5-sale-product-meta">
                        {product.unit_pack_label}
                        {product.selling_barcode && <bdi dir="ltr">{product.selling_barcode}</bdi>}
                        {product.sku && <bdi dir="ltr">{product.sku}</bdi>}
                      </span>
                    )}
                  </div>
                  <div className="v5-sale-product-tail">
                    <span className="v5-sale-product-price" dir="ltr">
                      {format(of(product.price_minor, 'EGP'))}
                    </span>
                    <button
                      type="button"
                      aria-label={`اختيار ${product.display_name_ar}`}
                      onClick={() => {
                        props.onSelect(product);
                      }}
                    >
                      اختيار
                    </button>
                  </div>
                </li>
              ))}
              {props.state.truncated && (
                <li className="v5-live-message">النتائج محدودة؛ عدّل البحث لتضييقها.</li>
              )}
            </ul>
          )}
        </>
      ) : (
        <p className="v5-live-message">بحث المنتجات غير مفعّل على هذا الجهاز.</p>
      )}
    </section>
  );
}
