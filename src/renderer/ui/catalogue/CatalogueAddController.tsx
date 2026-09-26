import type { JSX } from 'react';
import type { CartBridgeAPI } from '../../../shared/bridge-api.js';
import type { AddedLineResult } from '../../sale/useSaleCartController.js';
import { useConfirmSaleAdd } from '../../sale/useConfirmSaleAdd.js';
import { ProductConfirmPanel } from './ProductConfirmPanel.js';

export interface CatalogueAddControllerProps {
  cartId: string;
  ensureCart?: () => Promise<string | null>;
  onLineAdded: (res: AddedLineResult) => void;
  onResolved?: () => void;
  bridge?: CartBridgeAPI;
  quantity?: number;
}

/** Legacy presentation retained while the neutral controller serves both Sale screens. */
export function CatalogueAddController({
  cartId,
  ensureCart,
  onLineAdded,
  onResolved,
  bridge,
  quantity = 1,
}: CatalogueAddControllerProps): JSX.Element | null {
  const { product, error, confirm, cancel } = useConfirmSaleAdd({
    cartId,
    ...(ensureCart !== undefined ? { ensureCart } : {}),
    onLineAdded,
    ...(onResolved !== undefined ? { onResolved } : {}),
    ...(bridge !== undefined ? { bridge } : {}),
    quantity,
  });
  if (product === null) return null;
  return (
    <>
      <ProductConfirmPanel
        product={product}
        onAdd={() => {
          void confirm();
        }}
        onCancel={cancel}
      />
      {error !== null && (
        <p className="catalogue-confirm__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
