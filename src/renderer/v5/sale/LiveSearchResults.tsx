import { useEffect, useState, type JSX, type KeyboardEvent } from 'react';
import type { CatalogueSearchState } from '../../stores/catalogueSearchStore';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import { format, of } from '../../../shared/money';
import { SaleProductFlags } from './SaleProductFlags';

interface Props {
  state: CatalogueSearchState;
  onSelect: (product: ProductSnapshotDisplay) => void;
  onRecover: () => void;
}

/** Renders the search FSM: one honest message per terminal state, or the real result listbox. */
export function LiveSearchResults({ state, onSelect, onRecover }: Props): JSX.Element | null {
  switch (state.kind) {
    case 'searching':
      return (
        <p className="v5-live-message" role="status" aria-busy="true">
          جارٍ البحث…
        </p>
      );
    case 'idle':
      return <p className="v5-live-message">ابحث عن صنف لعرض المنتجات المتاحة.</p>;
    case 'not_found':
      return (
        <RecoverMessage copy="لم يُعثر على الصنف." action="تعديل البحث" onRecover={onRecover} />
      );
    case 'ambiguous':
      return (
        <RecoverMessage
          copy="تطابق أكثر من صنف مع الباركود."
          action="حاول مرة أخرى"
          onRecover={onRecover}
        />
      );
    case 'catalogue_unavailable':
      return (
        <p className="v5-live-message" role="alert">
          الكتالوج غير متاح حاليًا.
        </p>
      );
    case 'results':
      return <ResultsList items={state.items} truncated={state.truncated} onSelect={onSelect} />;
    default:
      return null;
  }
}

function RecoverMessage(props: {
  copy: string;
  action: string;
  onRecover: () => void;
}): JSX.Element {
  return (
    <p className="v5-live-message" role="status">
      {props.copy}{' '}
      <button type="button" onClick={props.onRecover}>
        {props.action}
      </button>
    </p>
  );
}

function ResultsList(props: {
  items: readonly ProductSnapshotDisplay[];
  truncated: boolean;
  onSelect: (product: ProductSnapshotDisplay) => void;
}): JSX.Element {
  const { items, onSelect } = props;
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    setActiveIndex(0);
  }, [items]);

  function handleKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const last = items.length - 1;
    if (event.key === 'ArrowDown') setActiveIndex((i) => Math.min(i + 1, last));
    else if (event.key === 'ArrowUp') setActiveIndex((i) => Math.max(i - 1, 0));
    else if (event.key === 'Enter') {
      const selected = items[activeIndex];
      if (selected) onSelect(selected);
    } else return;
    event.preventDefault();
  }

  return (
    <ul
      className="v5-sale-product-list"
      role="listbox"
      tabIndex={0}
      aria-label="نتائج البحث"
      aria-activedescendant={`v5-live-result-${String(activeIndex)}`}
      onKeyDown={handleKeyDown}
    >
      {items.map((product, index) => (
        <ProductRow
          key={product.product_id}
          product={product}
          index={index}
          active={index === activeIndex}
          onSelect={onSelect}
        />
      ))}
      {props.truncated && <li className="v5-live-message">النتائج محدودة؛ عدّل البحث لتضييقها.</li>}
    </ul>
  );
}

function ProductMeta({ product }: { product: ProductSnapshotDisplay }): JSX.Element | null {
  if (!(product.unit_pack_label ?? product.selling_barcode ?? product.sku)) return null;
  return (
    <span className="v5-sale-product-meta">
      {product.unit_pack_label}
      {product.selling_barcode && <bdi dir="ltr">{product.selling_barcode}</bdi>}
      {product.sku && <bdi dir="ltr">{product.sku}</bdi>}
    </span>
  );
}

function ProductRow(props: {
  product: ProductSnapshotDisplay;
  index: number;
  active: boolean;
  onSelect: (product: ProductSnapshotDisplay) => void;
}): JSX.Element {
  const { product } = props;
  return (
    <li
      id={`v5-live-result-${String(props.index)}`}
      className="v5-sale-product-row"
      role="option"
      aria-selected={props.active}
    >
      <div className="v5-sale-product-copy">
        <strong>{product.display_name_ar}</strong>
        {product.display_name_en && (
          <span lang="en" dir="ltr" className="v5-sale-secondary-name">
            {product.display_name_en}
          </span>
        )}
        <SaleProductFlags product={product} />
        <ProductMeta product={product} />
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
  );
}
