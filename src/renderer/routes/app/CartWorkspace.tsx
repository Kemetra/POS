/**
 * T043 — CartWorkspace with US3 state-variant support.
 *
 * In dev builds, reads `?state=` from the URL and renders the matching state
 * primitive. Production builds tree-shake the dev branch via the
 * `import.meta.env.DEV` guard.
 *
 * 005-sales-cart S1: when the `cart` feature flag is on (read from
 * `feature-flags-store`), this route mounts the live `CartPane` in 003's
 * reserved cart slot. The flag defaults to `false`, so the 003-era
 * placeholder remains the default surface until §A5 sign-off.
 */
import { useCallback, useRef, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoadingState, EmptyState, ErrorState } from '../../ui/states';
import { Workspace } from '../../shell/regions/Workspace';
import { CartPane, type AddedLineResult } from '../../ui/cart/CartPane';
import { CatalogueSalePane } from '../../ui/catalogue/CatalogueSalePane';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';

function resolveDevState(): string {
  const metaEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (metaEnv?.DEV && typeof window !== 'undefined') {
    return new URLSearchParams(window.location.search).get('state') ?? '';
  }
  return '';
}

export function CartWorkspace(): JSX.Element {
  const cartFlag = useFeatureFlagsStore((s) => s.cart);
  const productSearchFlag = useFeatureFlagsStore((s) => s.productSearch);
  const devState = resolveDevState();

  if (devState === 'loading') {
    return <LoadingState message="Loading Cart…" />;
  }
  if (devState === 'empty') {
    return (
      <EmptyState heading="Cart is empty" description="No items have been added to the cart yet." />
    );
  }
  if (devState === 'error') {
    return (
      <ErrorState
        heading="Cart unavailable"
        description="Could not load cart data. Please try again."
      />
    );
  }

  if (cartFlag) {
    return <SaleLayout showCatalogue={productSearchFlag} />;
  }

  return (
    <Workspace title="Cart">
      <section className="placeholder-pane">
        <p>Cart functionality coming soon.</p>
      </section>
    </Workspace>
  );
}

/**
 * 009 T049a — Cart workspace with the optional catalogue sale surface.
 *
 * CartPane's `onLineAdded` is a REGISTER-callback: it hands up its internal
 * `addLine(res)` fn. We capture it in a ref and pass a stable wrapper to
 * `CatalogueSalePane`, so a confirmed add flows search → confirm → CartPane's
 * line list — the single write path (FR-20). No parallel cart mutation.
 */
function SaleLayout({ showCatalogue }: { showCatalogue: boolean }): JSX.Element {
  const navigate = useNavigate();
  const addLineRef = useRef<((res: AddedLineResult) => void) | null>(null);
  const registerAddLine = useCallback((addLine: (res: AddedLineResult) => void): void => {
    addLineRef.current = addLine;
  }, []);
  const forwardAddLine = useCallback((res: AddedLineResult): void => {
    addLineRef.current?.(res);
  }, []);

  // 006 wiring: after a confirmed handoff, "Continue to payment" mounts the
  // envelope into the payment store (inside CartPane) and navigates to the
  // checkout route, which renders PaymentSurface off that envelope. Routing
  // lives here (the route owner, always under the router) so CartPane stays
  // Router-agnostic — see its 109 bare-render unit tests.
  const handlePaymentContinue = useCallback((): void => {
    void navigate('/app/checkout');
  }, [navigate]);

  return (
    <Workspace title="Cart">
      {/*
        POS v3.5 Phase 2 — two-column sale workspace (catalogue + cart).
        Presentation only: the `sale-layout` container arranges the existing
        catalogue and cart panes side by side (catalogue leads, cart trails;
        the root `dir="rtl"` from Phase 1 places catalogue left / cart right).
        Wiring is unchanged — `forwardAddLine`/`registerAddLine` remain the
        single add-line write path (FR-20).
      */}
      <div className="sale-layout" data-testid="sale-layout">
        {showCatalogue && <CatalogueSalePane onLineAdded={forwardAddLine} />}
        <CartPane onLineAdded={registerAddLine} onPaymentContinue={handlePaymentContinue} />
      </div>
    </Workspace>
  );
}
