import type { JSX } from 'react';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import { CartState } from '../../../shared/cart/cart-state';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import type { Role } from '../../../shared/operator/role';
import { useSaleCartController } from '../../sale/useSaleCartController';
import { useCartStore } from '../../stores/cart-store';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { LiveCatalogueRegion } from './LiveCatalogueRegion';
import { LiveSaleCart } from './LiveSaleCart';
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
  // Legacy parity: the cart stays available when only product search is off.
  return (
    <LiveSaleActive
      {...props}
      catalogueEnabled={productSearchEnabled}
      role={session.session.role}
    />
  );
}

function isManagerRole(role: Role): boolean {
  return role === 'manager' || role === 'admin';
}

function canVoidCart(state: CartState | null, role: Role): boolean {
  if (state === null || state === CartState.empty) return false;
  if (state === CartState.cancelled) return false;
  return state !== CartState.frozen_handed_off || isManagerRole(role);
}

function frozenSubtotal(frozen: boolean, envelope: PaymentIntentEnvelope | null): number | null {
  return frozen && envelope !== null ? envelope.subtotal_minor : null;
}

function SaleHeader(): JSX.Element {
  return (
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
  );
}

function LiveSaleActive(props: Props & { catalogueEnabled: boolean; role: Role }): JSX.Element {
  const paymentsEnabled = useFeatureFlagsStore((state) => state.payments);
  const cartState = useCartStore((state) => state.activeCart?.state ?? null);
  const cart = useSaleCartController(props.cartBridge ? { bridge: props.cartBridge } : {});
  const frozen = cartState === CartState.frozen_handed_off;

  return (
    <main className="v5-sale" dir="rtl" lang="ar" aria-label="مساحة البيع">
      <SaleHeader />
      <div className="v5-sale-workstation" data-catalogue={String(props.catalogueEnabled)}>
        {props.catalogueEnabled && (
          <LiveCatalogueRegion
            onLineAdded={cart.acceptAddedLine}
            {...(props.cartBridge ? { cartBridge: props.cartBridge } : {})}
            {...(props.catalogueBridge ? { catalogueBridge: props.catalogueBridge } : {})}
          />
        )}
        <LiveSaleCart
          lines={cart.lines}
          discounts={cart.discountPlaceholders}
          subtotalMinor={cart.subtotalMinor}
          itemCount={cart.itemCount}
          frozenSubtotalMinor={frozenSubtotal(frozen, cart.envelope)}
          canHandoff={cartState === CartState.editing && cart.lines.length > 0}
          handingOff={cartState === CartState.handing_off}
          cancelled={cartState === CartState.cancelled}
          canVoid={canVoidCart(cartState, props.role)}
          canContinue={frozen && cart.envelope !== null && paymentsEnabled}
          handoffError={cart.handoffError}
          onIncrement={(line) => void cart.incrementLine(line.lineId, line.version)}
          onDecrement={(line) => void cart.decrementLine(line.lineId, line.version)}
          onRemove={(line) => void cart.removeLine(line.lineId, line.version)}
          onSaveNote={(line, note) => cart.saveNote(line.lineId, line.version, note)}
          onRemoveDiscount={(id) => void cart.removeDiscount(id)}
          onHandoff={() => void cart.handoff()}
          onContinue={() => {
            cart.continueToPayment(props.onPaymentContinue);
          }}
          onVoid={cart.voidCart}
        />
      </div>
    </main>
  );
}
