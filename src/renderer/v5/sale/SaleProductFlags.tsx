import type { JSX } from 'react';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';

/** Display-only awareness badges; each carries its own text so meaning never rests on colour. */
export function SaleProductFlags({
  product,
}: {
  product: Pick<ProductSnapshotDisplay, 'controlled_substance' | 'prescription_required'>;
}): JSX.Element | null {
  if (!product.controlled_substance && !product.prescription_required) return null;
  return (
    <span className="v5-live-flags">
      {product.controlled_substance && (
        <span className="v5-live-flag v5-live-flag--controlled">مادة خاضعة للرقابة</span>
      )}
      {product.prescription_required && (
        <span className="v5-live-flag v5-live-flag--rx">بوصفة طبية</span>
      )}
    </span>
  );
}
