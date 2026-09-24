import type { JSX } from 'react';
import { demoSale } from './demo-sale';
import { ProductRail } from './ProductRail';
import { SaleCart } from './SaleCart';
import './sale-screen.css';

export function SaleScreen(): JSX.Element {
  return (
    <main className="v5-sale" dir="rtl" lang="ar" aria-label="معاينة شاشة البيع">
      <header className="v5-sale-header">
        <div className="v5-sale-brand" aria-label="POS Pulse">
          <span className="v5-sale-brand-mark" aria-hidden="true">
            ✚
          </span>
          <div>
            <strong dir="ltr">POS Pulse</strong>
            <span>نقطة البيع</span>
          </div>
        </div>
        <div className="v5-sale-header-copy">
          <h1>مساحة البيع</h1>
          <p>بحث واضح، سلة نشطة، وإجمالي ظاهر طوال العملية</p>
        </div>
        <span className="v5-sale-preview-note">معاينة تصميم ثابتة · بيانات توضيحية</span>
      </header>

      <div className="v5-sale-workstation">
        <ProductRail products={demoSale.products} />
        <SaleCart lines={demoSale.cartLines} subtotal={demoSale.subtotal} total={demoSale.total} />
      </div>
    </main>
  );
}
