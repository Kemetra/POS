import { useCallback, useRef, type JSX } from 'react';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import { format, of } from '../../../shared/money';
import type { AddedLineResult } from '../../sale/useSaleCartController';
import { useSaleCatalogueController } from '../../sale/useSaleCatalogueController';
import { useConfirmSaleAdd } from '../../sale/useConfirmSaleAdd';
import { useCatalogueFreshness } from '../../sale/useCatalogueFreshness';
import { LiveProductRail } from './LiveProductRail';
import { SaleDialog } from './SaleDialog';
import { SaleProductFlags } from './SaleProductFlags';

interface Props {
  onLineAdded: (line: AddedLineResult) => void;
  cartBridge?: CartBridgeAPI;
  catalogueBridge?: CatalogueBridgeAPI;
}

/** Product discovery + confirm-first add. Mounted only when the productSearch flag is on. */
export function LiveCatalogueRegion(props: Props): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null);
  const catalogue = useSaleCatalogueController({
    ...(props.cartBridge ? { cartBridge: props.cartBridge } : {}),
    ...(props.catalogueBridge ? { catalogueBridge: props.catalogueBridge } : {}),
  });
  const freshness = useCatalogueFreshness(props.catalogueBridge);
  const focusSearch = useCallback((): void => {
    searchRef.current?.focus();
  }, []);
  const { recover: clearSearch } = catalogue;
  const recover = useCallback((): void => {
    clearSearch();
    focusSearch();
  }, [clearSearch, focusSearch]);

  return (
    <>
      <LiveProductRail
        state={catalogue.state}
        freshness={freshness.state}
        lastSuccessAt={freshness.lastSuccessAt}
        feedback={freshness.feedback}
        refreshing={freshness.refreshing}
        onRefresh={() => void freshness.refresh()}
        onSearch={(query) => void catalogue.runTypedSearch(query)}
        onScan={(barcode) => void catalogue.runScan(barcode)}
        onSelect={catalogue.selectResult}
        onRecover={recover}
        searchRef={searchRef}
      />
      {/* Legacy parity: the add path exists only once a real cart id does. */}
      {catalogue.effectiveCartId !== '' && (
        <ConfirmAddDialog
          cartId={catalogue.effectiveCartId}
          onLineAdded={props.onLineAdded}
          onResolved={focusSearch}
          {...(props.cartBridge ? { bridge: props.cartBridge } : {})}
        />
      )}
    </>
  );
}

function ConfirmAddDialog(props: {
  cartId: string;
  onLineAdded: (line: AddedLineResult) => void;
  onResolved: () => void;
  bridge?: CartBridgeAPI;
}): JSX.Element | null {
  const addRef = useRef<HTMLButtonElement>(null);
  const confirm = useConfirmSaleAdd(props);
  if (confirm.product === null) return null;
  const product = confirm.product;
  return (
    <SaleDialog
      label="تأكيد إضافة الصنف"
      onDismiss={confirm.cancel}
      initialFocusRef={addRef}
      restoreFocus={false}
    >
      <h2 className="v5-live-dialog-title">تأكيد الصنف</h2>
      <p className="v5-live-dialog-name">{product.display_name_ar}</p>
      {product.display_name_en && (
        <p lang="en" dir="ltr" className="v5-live-dialog-secondary">
          {product.display_name_en}
        </p>
      )}
      <SaleProductFlags product={product} />
      <p dir="ltr" className="v5-live-dialog-price">
        {format(of(product.price_minor, 'EGP'))}
      </p>
      {confirm.error && <p role="alert">{confirm.error}</p>}
      <div className="v5-live-dialog-actions">
        <button
          type="button"
          className="v5-live-btn"
          disabled={confirm.adding}
          onClick={confirm.cancel}
        >
          إلغاء
        </button>
        <button
          ref={addRef}
          type="button"
          className="v5-live-btn v5-live-btn--primary"
          disabled={confirm.adding}
          onClick={() => void confirm.confirm()}
        >
          إضافة إلى السلة
        </button>
      </div>
    </SaleDialog>
  );
}
