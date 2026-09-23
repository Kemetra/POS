import { useCallback, useRef, type JSX } from 'react';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import { CartState } from '../../../shared/cart/cart-state';
import { useSaleCartController, type CartLineItem } from '../../sale/useSaleCartController';
import { useSaleCatalogueController } from '../../sale/useSaleCatalogueController';
import { useConfirmSaleAdd } from '../../sale/useConfirmSaleAdd';
import { useCatalogueFreshness } from '../../sale/useCatalogueFreshness';
import { useCartStore } from '../../stores/cart-store';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { format, of } from '../../../shared/money';
import { LiveProductRail } from './LiveProductRail';
import { LiveSaleCart } from './LiveSaleCart';
import { SaleDialog } from './SaleDialog';
import { SaleProductFlags } from './SaleProductFlags';
import './sale-screen.css';
import './live-sale.css';

interface Props {
  cartBridge?: CartBridgeAPI;
  catalogueBridge?: CatalogueBridgeAPI;
  onPaymentContinue: () => void;
}

/** Guarded route adapter. One cart controller instance owns all bridge-confirmed line display state. */
export function LiveSaleWorkspace(props: Props): JSX.Element {
  const cartEnabled = useFeatureFlagsStore((state) => state.cart);
  const productSearchEnabled = useFeatureFlagsStore((state) => state.productSearch);
  const session = useOperatorSessionStore((state) => state.state);
  if (session.kind !== 'signedIn') return <main className="v5-sale" dir="rtl" lang="ar" />;
  if (!cartEnabled)
    return (
      <main className="v5-sale" dir="rtl" lang="ar">
        <p className="v5-live-message">سلة البيع غير مفعّلة على هذا الجهاز بعد.</p>
      </main>
    );
  if (!productSearchEnabled)
    return (
      <main className="v5-sale" dir="rtl" lang="ar">
        <p className="v5-live-message">
          بحث المنتجات غير مفعّل على هذا الجهاز؛ لا يمكن بدء سلة جديدة هنا.
        </p>
      </main>
    );
  return <LiveSaleActive {...props} />;
}

function LiveSaleActive(props: Props): JSX.Element {
  const paymentsEnabled = useFeatureFlagsStore((state) => state.payments);
  const activeCart = useCartStore((state) => state.activeCart);
  const session = useOperatorSessionStore((state) => state.state);
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const cart = useSaleCartController(props.cartBridge ? { bridge: props.cartBridge } : {});
  const onResolved = useCallback((): void => {
    searchRef.current?.focus();
  }, []);
  const catalogue = useSaleCatalogueController({
    ...(props.cartBridge ? { cartBridge: props.cartBridge } : {}),
    ...(props.catalogueBridge ? { catalogueBridge: props.catalogueBridge } : {}),
  });
  const confirm = useConfirmSaleAdd({
    cartId: catalogue.effectiveCartId,
    onLineAdded: cart.acceptAddedLine,
    onResolved,
    ...(props.cartBridge ? { bridge: props.cartBridge } : {}),
  });
  const freshness = useCatalogueFreshness(props.catalogueBridge);
  const frozen = activeCart?.state === CartState.frozen_handed_off;
  const cancelled = activeCart?.state === CartState.cancelled;
  const role = session.kind === 'signedIn' ? session.session.role : null;
  const canVoid =
    activeCart !== null &&
    activeCart.state !== CartState.empty &&
    !cancelled &&
    (!frozen || role === 'manager' || role === 'admin');
  const canHandoff = activeCart?.state === CartState.editing && cart.lines.length > 0;
  const canContinue = frozen && cart.envelope !== null && paymentsEnabled;
  const frozenSubtotalMinor = frozen && cart.envelope ? cart.envelope.subtotal_minor : null;
  const recover = useCallback((): void => {
    catalogue.recover();
    onResolved();
  }, [catalogue, onResolved]);

  function onLine(line: CartLineItem, method: 'increment' | 'decrement' | 'remove'): void {
    if (method === 'increment') void cart.incrementLine(line.lineId, line.version);
    else if (method === 'decrement') void cart.decrementLine(line.lineId, line.version);
    else void cart.removeLine(line.lineId, line.version);
  }

  return (
    <main className="v5-sale" dir="rtl" lang="ar" aria-label="مساحة البيع">
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
      </header>
      <div className="v5-sale-workstation" data-catalogue="true">
        <LiveProductRail
          state={catalogue.state}
          enabled={true}
          freshness={freshness.state}
          lastSuccessAt={freshness.lastSuccessAt}
          feedback={freshness.feedback}
          refreshing={freshness.refreshing}
          onRefresh={() => {
            void freshness.refresh();
          }}
          onSearch={(query) => {
            void catalogue.runTypedSearch(query);
          }}
          onScan={(barcode) => {
            void catalogue.runScan(barcode);
          }}
          onSelect={catalogue.selectResult}
          onRecover={recover}
          searchRef={searchRef}
        />
        <LiveSaleCart
          lines={cart.lines}
          discounts={cart.discountPlaceholders}
          subtotalMinor={cart.subtotalMinor}
          itemCount={cart.itemCount}
          frozenSubtotalMinor={frozenSubtotalMinor}
          canHandoff={canHandoff}
          handingOff={activeCart?.state === CartState.handing_off}
          cancelled={cancelled}
          canVoid={canVoid}
          canContinue={canContinue}
          handoffError={cart.handoffError}
          onIncrement={(line) => {
            onLine(line, 'increment');
          }}
          onDecrement={(line) => {
            onLine(line, 'decrement');
          }}
          onRemove={(line) => {
            onLine(line, 'remove');
          }}
          onSaveNote={(line, note) => cart.saveNote(line.lineId, line.version, note)}
          onRemoveDiscount={(id) => {
            void cart.removeDiscount(id);
          }}
          onHandoff={() => {
            void cart.handoff();
          }}
          onContinue={() => {
            cart.continueToPayment(props.onPaymentContinue);
          }}
          onVoid={cart.voidCart}
        />
      </div>
      {confirm.product && (
        <SaleDialog
          label="تأكيد إضافة الصنف"
          onDismiss={confirm.cancel}
          initialFocusRef={addRef}
          restoreFocus={false}
        >
          <h2 className="v5-live-dialog-title">تأكيد الصنف</h2>
          <p className="v5-live-dialog-name">{confirm.product.display_name_ar}</p>
          {confirm.product.display_name_en && (
            <p lang="en" dir="ltr" className="v5-live-dialog-secondary">
              {confirm.product.display_name_en}
            </p>
          )}
          <SaleProductFlags product={confirm.product} />
          <p dir="ltr" className="v5-live-dialog-price">
            {format(of(confirm.product.price_minor, 'EGP'))}
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
              onClick={() => {
                void confirm.confirm();
              }}
            >
              إضافة إلى السلة
            </button>
          </div>
        </SaleDialog>
      )}
    </main>
  );
}
