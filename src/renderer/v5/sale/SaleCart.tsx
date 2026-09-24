import type { JSX } from 'react';
import type { DemoCartLine } from './demo-sale';

interface SaleCartProps {
  readonly lines: readonly DemoCartLine[];
  readonly subtotal: string;
  readonly total: string;
}

function CartLine({
  line,
  index,
}: {
  readonly line: DemoCartLine;
  readonly index: number;
}): JSX.Element {
  return (
    <li className="v5-sale-cart-line">
      <span className="v5-sale-line-index" dir="ltr">
        {index + 1}
      </span>
      <div className="v5-sale-line-product">
        <strong>{line.name}</strong>
        <span lang="en" dir="ltr" className="v5-sale-secondary-name">
          {line.englishName}
        </span>
        <span className="v5-sale-line-meta">
          {line.form}
          <bdi dir="ltr">{line.barcode}</bdi>
        </span>
      </div>
      <span className="v5-sale-line-unit" dir="ltr">
        {line.unitPrice}
      </span>
      <span className="v5-sale-quantity" aria-label={`الكمية ${String(line.quantity)}`}>
        <span aria-hidden="true">−</span>
        <strong dir="ltr">{line.quantity}</strong>
        <span aria-hidden="true">＋</span>
      </span>
      <strong className="v5-sale-line-total" dir="ltr">
        {line.linePrice}
      </strong>
    </li>
  );
}

export function SaleCart({ lines, subtotal, total }: SaleCartProps): JSX.Element {
  return (
    <section className="v5-sale-cart" aria-labelledby="v5-sale-cart-title">
      <div className="v5-sale-cart-heading">
        <div>
          <span className="v5-sale-eyebrow">المعاملة الجارية</span>
          <h2 id="v5-sale-cart-title">سلة المشتريات</h2>
        </div>
        <span className="v5-sale-count">{lines.length} أصناف · 9 وحدات</span>
      </div>

      <div className="v5-sale-cart-table">
        <div className="v5-sale-cart-columns" aria-hidden="true">
          <span>#</span>
          <span>الصنف</span>
          <span>سعر الوحدة</span>
          <span>الكمية</span>
          <span>الإجمالي</span>
        </div>
        <ol className="v5-sale-cart-lines" aria-label="أصناف السلة التوضيحية">
          {lines.map((line, index) => (
            <CartLine key={line.barcode} line={line} index={index} />
          ))}
        </ol>
      </div>

      <footer className="v5-sale-cart-footer">
        <div className="v5-sale-totals" aria-label="ملخص المبالغ التوضيحية">
          <div className="v5-sale-total-row">
            <span>المجموع الفرعي</span>
            <span dir="ltr">
              {subtotal} <small>ج.م</small>
            </span>
          </div>
          <div className="v5-sale-total-row v5-sale-tax-row">
            <span>الضريبة</span>
            <span>قيد الإضافة · لا تُحسب هنا</span>
          </div>
          <div className="v5-sale-grand-total">
            <span>الإجمالي الحالي</span>
            <strong dir="ltr">
              {total} <small>ج.م</small>
            </strong>
          </div>
        </div>
        <div className="v5-sale-actions">
          <p>هذه معاينة مرئية؛ متابعة الدفع غير مفعّلة.</p>
          <button type="button" aria-disabled="true" className="v5-sale-checkout">
            <span>المتابعة إلى الدفع</span>
            <span aria-hidden="true">←</span>
          </button>
        </div>
      </footer>
    </section>
  );
}
