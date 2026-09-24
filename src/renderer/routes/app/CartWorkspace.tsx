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
import { CartPane } from '../../ui/cart/CartPane';
import type { AddedLineResult } from '../../sale/useSaleCartController';
import { CatalogueSalePane } from '../../ui/catalogue/CatalogueSalePane';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';

/**
 * 022 U2 / T060 — the sale workspace heading (FR-19 Arabic-first).
 *
 * Bilingual on purpose, mirroring `CartPane`'s own header: the Arabic leads and
 * the LTR "Cart" companion trails so the route keeps its English accessible
 * name. That parity is load-bearing — `navigation.test.tsx` proves the cart nav
 * entry routes here by matching the heading, and `SalesWorkspace.test.tsx`
 * asserts the default render. Both are BEHAVIOURAL (routing/render) tests, so
 * they must pass unmodified; dropping "Cart" would have forced edits to them
 * for a presentation change, which the 022 standing constraint forbids.
 */
const SALE_WORKSPACE_TITLE = 'نقطة البيع · السلة · Cart';

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

  // 022 U2 / FR-19 + FR-27: the cart-gated surface. Arabic-first (plan A9 —
  // U1 left this state English-only and named U2/U5 to close it), and phrased
  // as NOT-YET-ENABLED rather than broken: a gated surface is not a failed one,
  // so it carries no alert role and no error treatment.
  return (
    <Workspace title={SALE_WORKSPACE_TITLE}>
      <section className="placeholder-pane" data-testid="cart-gated-placeholder">
        <p>سلة البيع غير مفعّلة على هذا الجهاز بعد.</p>
        <p className="placeholder-pane__hint">
          لا يوجد خطأ — لم يتم تفعيل هذه الميزة بعد.
          <span dir="ltr"> (Cart is not enabled on this terminal yet.)</span>
        </p>
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
    <Workspace title={SALE_WORKSPACE_TITLE}>
      {/*
        022 U2 / T060 — two-region sale workspace (catalogue + cart).

        Presentation only: the `sale-layout` container arranges the existing
        catalogue and cart panes side by side. Wiring is unchanged —
        `forwardAddLine`/`registerAddLine` remain the single add-line write
        path (FR-20), which is what T065 guards.

        FR-15 says the cart's line items and running total are the dominant
        elements "of the sale workspace" — the whole two-region surface, not
        just the cart's own internals. The v3.5 pass had this backwards
        (`1fr 380px` gave the CATALOGUE the flexible major region and left the
        cart a fixed rail); `data-cart-dominant` drives the corrected track
        sizing in `@layer components`, matching the governing reference
        (visual-references/03-sale-workspace.png).

        The attribute is only a CSS hook carrying the intent — it is hardcoded,
        so the unit test that reads it proves the hook is present, NOT that the
        cart visually dominates. FR-15's real verification is the T0D1
        screenshot comparison; see the CSS rule for the RTL side-placement
        reasoning (track 1 is the visual right under `dir="rtl"`).

        `data-catalogue` gates the TWO-TRACK template, because `cart` and
        `productSearch` are independent fail-closed flags: `cart: true,
        productSearch: false` renders the cart ALONE. Grid auto-places a lone
        child into track 1 — which the FR-15 flip made the fixed 380px rail —
        so an unconditional two-track template collapsed a solitary cart into a
        narrow rail beside an empty `1fr` column above 1023px. Dominance stays
        unconditional; only the track COUNT follows the catalogue.
      */}
      <div
        className="sale-layout"
        data-testid="sale-layout"
        data-cart-dominant="true"
        data-catalogue={showCatalogue ? 'true' : 'false'}
      >
        {showCatalogue && <CatalogueSalePane onLineAdded={forwardAddLine} />}
        <CartPane onLineAdded={registerAddLine} onPaymentContinue={handlePaymentContinue} />
      </div>
    </Workspace>
  );
}
