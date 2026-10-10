import { useRef, type JSX, type ReactNode } from 'react';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import { CartState } from '../../../shared/cart/cart-state';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope';
import type { Role } from '../../../shared/operator/role';
import type { AddBlock } from '../../sale/useDirectSaleAdd';
import { useSaleCartController } from '../../sale/useSaleCartController';
import { useLineFlagsStore } from '../../stores/line-flags-store';
import { useCartStore } from '../../stores/cart-store';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore, type PaymentStore } from '../../stores/payment-store';
import { LiveCatalogueRegion } from './LiveCatalogueRegion';
import { LiveSaleCart } from './LiveSaleCart';
import { ScanStatus } from './ScanStatus';
import { CartStatusLine } from './CartStatusLine';
import { useLiveSaleActions } from './useLiveSaleActions';
import './sale-screen.css';
import './live-sale.css';
import './sale-direction-b.css';

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
        <SaleTitle scanAvailable={false} withStatus />
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
 * (the v5 frame), never to the screen. RT-242 (Direction B): the title is for
 * heading navigation only; the command bar is the first thing on screen. With
 * no command bar (catalogue off, or the cart still being read) the scan status
 * keeps its own slim strip so it is never missing.
 */
function SaleTitle(props: {
  scanAvailable: boolean;
  withStatus: boolean;
  lastAction?: ReactNode;
}): JSX.Element {
  return (
    <div className={props.withStatus ? 'v5-live-titlebar' : undefined}>
      <h1 id={SALE_TITLE_ID} className="v5-visually-hidden">
        مساحة البيع
      </h1>
      {props.withStatus && <ScanStatus available={props.scanAvailable} />}
      {props.withStatus && props.lastAction}
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

/** Why a scan or pick cannot add to the cart on screen (read when each queued add runs). */
function addBlockOf(state: CartState | null, paid: boolean): AddBlock {
  if (paid) return 'paid';
  if (state === CartState.frozen_handed_off || state === CartState.handing_off) return 'frozen';
  return null;
}

function LiveSaleActive(props: Props & { catalogueEnabled: boolean; role: Role }): JSX.Element {
  const paymentsEnabled = useFeatureFlagsStore((state) => state.payments);
  const cartState = useCartStore((state) => state.activeCart?.state ?? null);
  const cartId = useCartStore((state) => state.activeCart?.cart_id ?? null);
  const settledCartId = usePaymentStore(selectSettledCartId);
  const lineFlags = useLineFlagsStore((state) => state.byLine);
  const cart = useSaleCartController({
    hydrateActiveCart: true,
    ...(props.cartBridge ? { bridge: props.cartBridge } : {}),
  });
  const actions = useLiveSaleActions(cart, props.cartBridge);
  const frozen = cartState === CartState.frozen_handed_off;
  // Frozen alone is not "paid": only a settled attempt for THIS cart is —
  // known to the renderer, or reported by main when the cart was reopened.
  const paid = frozen && isKnownPaid(cartId, settledCartId, cart.hydratedPaid);
  const addBlock = useRef<AddBlock>(null);
  addBlock.current = addBlockOf(cartState, paid);

  // An existing cart whose persisted lines are not known yet: show only a
  // small state. No catalogue (so no cart create and no add into an unknown
  // projection) and no empty cart that could be mistaken for the real one.
  if (cart.hydration !== 'ready') {
    return (
      <section className="v5-sale v5-live-sale" dir="rtl" lang="ar" aria-labelledby={SALE_TITLE_ID}>
        <SaleTitle scanAvailable={false} withStatus />
        <CartHydrationState failed={cart.hydration === 'failed'} onRetry={cart.retryHydration} />
      </section>
    );
  }

  const lastAction = (
    <CartStatusLine
      announcement={actions.undo.announcement}
      offer={actions.undo.offer}
      canUndo={actions.undo.canUndo}
      onUndo={() => void actions.undo.undo()}
    />
  );
  return (
    <section className="v5-sale v5-live-sale" dir="rtl" lang="ar" aria-labelledby={SALE_TITLE_ID}>
      <SaleTitle
        scanAvailable={false}
        withStatus={!props.catalogueEnabled}
        lastAction={lastAction}
      />
      <div className="v5-sale-workstation" data-catalogue={String(props.catalogueEnabled)}>
        {props.catalogueEnabled && (
          <LiveCatalogueRegion
            onLineAdded={actions.acceptAddedLine}
            onAddQueued={actions.onAddQueued}
            addBlock={() => addBlock.current}
            status={
              <>
                <ScanStatus available />
                {lastAction}
              </>
            }
            {...(props.cartBridge ? { cartBridge: props.cartBridge } : {})}
            {...(props.catalogueBridge ? { catalogueBridge: props.catalogueBridge } : {})}
          />
        )}
        <LiveSaleCart
          lines={cart.lines}
          lineFlags={lineFlags}
          discounts={cart.discountPlaceholders}
          subtotalMinor={cart.subtotalMinor}
          itemCount={cart.itemCount}
          frozenSubtotalMinor={frozenSubtotal(frozen, cart.envelope)}
          lastAddedLineId={actions.lastAdd?.lineId ?? null}
          lastAddNonce={actions.lastAdd?.nonce ?? 0}
          canHandoff={cartState === CartState.editing && cart.lines.length > 0}
          handingOff={cartState === CartState.handing_off}
          cancelled={cartState === CartState.cancelled}
          canVoid={canVoidCart(cartState, props.role, paid)}
          canContinue={!paid && frozen && cart.envelope !== null && paymentsEnabled}
          paid={paid}
          voided={actions.voided}
          handoffError={cart.handoffError}
          onIncrement={actions.onIncrement}
          onDecrement={actions.onDecrement}
          onRemove={actions.onRemove}
          onSaveNote={actions.onSaveNote}
          onRemoveDiscount={actions.onRemoveDiscount}
          onHandoff={actions.onHandoff}
          onContinue={() => {
            cart.continueToPayment(props.onPaymentContinue);
          }}
          onVoid={actions.onVoid}
          onNewSale={actions.onNewSale}
        />
      </div>
    </section>
  );
}
