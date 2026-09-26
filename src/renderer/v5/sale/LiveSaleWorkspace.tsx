import { useState, type JSX } from 'react';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import { CartState } from '../../../shared/cart/cart-state';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import type { Role } from '../../../shared/operator/role';
import { useSaleCartController, type AddedLineResult } from '../../sale/useSaleCartController';
import { useCartStore } from '../../stores/cart-store';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore, type PaymentStore } from '../../stores/payment-store';
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
  if (session.kind !== 'signedIn')
    return <section className="v5-sale v5-live-sale" dir="rtl" lang="ar" />;
  // Fail-closed default: still a titled screen, so heading navigation and the
  // one-h1 hierarchy hold while the cart rollout is off.
  if (!cartEnabled)
    return (
      <section className="v5-sale v5-live-sale" dir="rtl" lang="ar" aria-labelledby={SALE_TITLE_ID}>
        <SaleTitle />
        <p className="v5-live-message">سلة البيع غير مفعّلة على هذا الجهاز بعد.</p>
      </section>
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

function canVoidCart(state: CartState | null, role: Role, paid: boolean): boolean {
  if (paid || state === null || state === CartState.empty) return false;
  if (state === CartState.cancelled) return false;
  return state !== CartState.frozen_handed_off || isManagerRole(role);
}

function frozenSubtotal(frozen: boolean, envelope: PaymentIntentEnvelope | null): number | null {
  return frozen && envelope !== null ? envelope.subtotal_minor : null;
}

/**
 * The cart whose payment the renderer projection knows has settled. The
 * attempt view carries no cart id, so the mounted envelope ties it to a cart.
 */
function selectSettledCartId(state: PaymentStore): string | null {
  return state.paymentSlice?.state === 'settled' ? (state.envelope?.cart_id ?? null) : null;
}

/** This cart's payment is known settled: in the renderer store, or reported by main's snapshot. */
function isKnownPaid(
  cartId: string | null,
  settledCartId: string | null,
  hydratedPaid: boolean,
): boolean {
  return cartId !== null && (settledCartId === cartId || hydratedPaid);
}

const SALE_TITLE_ID = 'v5-sale-title';

/**
 * Screen title only. Branding and operator identity belong to the app frame
 * (the v5 frame), never to the screen.
 */
function SaleTitle(): JSX.Element {
  return (
    <div className="v5-live-titlebar">
      <h1 id={SALE_TITLE_ID}>مساحة البيع</h1>
    </div>
  );
}

/** Generic, recoverable: never names a refusal reason. */
function CartHydrationState(props: { failed: boolean; onRetry: () => void }): JSX.Element {
  if (!props.failed) {
    return (
      <div className="v5-live-state">
        <p role="status" className="v5-live-message">
          جارٍ تحميل السلة الحالية…
        </p>
      </div>
    );
  }
  return (
    <div className="v5-live-state" role="alert">
      <p className="v5-live-message">تعذّر تحميل السلة الحالية.</p>
      <button type="button" className="v5-live-btn" onClick={props.onRetry}>
        إعادة المحاولة
      </button>
    </div>
  );
}

function LiveSaleActive(props: Props & { catalogueEnabled: boolean; role: Role }): JSX.Element {
  const paymentsEnabled = useFeatureFlagsStore((state) => state.payments);
  const cartState = useCartStore((state) => state.activeCart?.state ?? null);
  const cartId = useCartStore((state) => state.activeCart?.cart_id ?? null);
  const settledCartId = usePaymentStore(selectSettledCartId);
  const [voided, setVoided] = useState(false);
  const cart = useSaleCartController({
    hydrateActiveCart: true,
    ...(props.cartBridge ? { bridge: props.cartBridge } : {}),
  });
  const frozen = cartState === CartState.frozen_handed_off;
  // Frozen alone is not "paid": only a settled attempt for THIS cart is —
  // known to the renderer, or reported by main when the cart was reopened.
  const paid = frozen && isKnownPaid(cartId, settledCartId, cart.hydratedPaid);

  // Reset only after the bridge confirms the void; a refusal or rejected
  // transport keeps the existing cart. The voided cart stays cancelled in the
  // DB; only the renderer's pointer to it is dropped.
  const voidThenStartFresh = async (): Promise<boolean> => {
    const ok = await cart.voidCart().catch(() => false);
    if (ok) {
      cart.startNewSale();
      setVoided(true);
    }
    return ok;
  };
  const acceptAddedLine = (line: AddedLineResult): void => {
    setVoided(false);
    cart.acceptAddedLine(line);
  };

  // An existing cart whose persisted lines are not known yet: show only a
  // small state. No catalogue (so no cart create and no add into an unknown
  // projection) and no empty cart that could be mistaken for the real one.
  if (cart.hydration !== 'ready') {
    return (
      <section className="v5-sale v5-live-sale" dir="rtl" lang="ar" aria-labelledby={SALE_TITLE_ID}>
        <SaleTitle />
        <CartHydrationState failed={cart.hydration === 'failed'} onRetry={cart.retryHydration} />
      </section>
    );
  }

  return (
    <section className="v5-sale v5-live-sale" dir="rtl" lang="ar" aria-labelledby={SALE_TITLE_ID}>
      <SaleTitle />
      <div className="v5-sale-workstation" data-catalogue={String(props.catalogueEnabled)}>
        {props.catalogueEnabled && (
          <LiveCatalogueRegion
            onLineAdded={acceptAddedLine}
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
          canVoid={canVoidCart(cartState, props.role, paid)}
          canContinue={!paid && frozen && cart.envelope !== null && paymentsEnabled}
          paid={paid}
          voided={voided}
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
          onVoid={voidThenStartFresh}
          onNewSale={cart.startNewSale}
        />
      </div>
    </section>
  );
}
