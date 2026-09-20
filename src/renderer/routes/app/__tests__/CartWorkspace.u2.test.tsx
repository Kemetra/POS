/**
 * 022 U2 (US2) — sale workspace / catalogue / cart.
 *
 * Covers T060 (two-region layout, cart dominant — FR-15), T064 (the honest VAT
 * placeholder is preserved EXACTLY — D-007) and T065 (the single cart mutation
 * path survives — 005's `resolveItemRef` seam, FR-20/FR-40).
 *
 * T064/T065 are PRESERVATION guards: they are written green-from-the-start and
 * exist so a presentation edit that breaks money honesty or forks the cart
 * write path fails here rather than in review. They assert current behaviour on
 * purpose — do not "update" them to match a diff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { CartWorkspace } from '../CartWorkspace';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { useCartStore } from '../../../stores/cart-store';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../../shared/bridge-api';

function makeCartBridge(): CartBridgeAPI {
  return {
    create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'c1' }),
    lines: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: vi.fn(),
    handoff: vi.fn(),
    subscribe: vi.fn(),
  };
}

function makeCatalogueBridge(): CatalogueBridgeAPI {
  return {
    lookupBarcode: vi.fn(),
    lookupSku: vi.fn(),
    search: vi.fn(),
    resolve: vi.fn(),
    refresh: vi.fn(),
    freshness: vi.fn(),
    counts: vi.fn(),
  };
}

function renderWorkspace() {
  return render(
    <MemoryRouter>
      <CartWorkspace />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  useCartStore.getState().reset();
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'sess-1',
    operator_id: 'op-1',
    display_name: 'Test Operator',
    role: 'manager',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: new Date().toISOString(),
  });
  (window as unknown as { api?: unknown }).api = {
    cart: makeCartBridge(),
    catalogue: makeCatalogueBridge(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('U2 / T060 — cart-dominant sale workspace (FR-15)', () => {
  it('marks the sale layout cart-dominant so the cart leads the workspace', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: true });
    renderWorkspace();

    // FR-15 reads "the visually dominant elements of the SALE WORKSPACE" — so
    // dominance is a property of the whole two-region layout, not just of the
    // cart pane's internals. The governing reference
    // (visual-references/03-sale-workspace.png) shows the cart occupying the
    // major region with the catalogue as the narrower rail.
    //
    // HONEST LIMIT: this asserts the CSS HOOK is present, not that the cart
    // visually dominates. The attribute is hardcoded and jsdom computes no
    // stylesheet-driven grid tracks, so FR-15 has no automated verification —
    // its evidence is the T0D1 screenshot comparison. Do not read this green
    // test as FR-15 coverage.
    const layout = screen.getByTestId('sale-layout');
    expect(layout).toHaveAttribute('data-cart-dominant', 'true');
  });

  it('marks the layout as two-region only when the catalogue is actually rendered', () => {
    // Codex P1 regression guard. `cart` and `productSearch` are INDEPENDENT
    // fail-closed flags, so `cart: true, productSearch: false` is a supported
    // (and default-ish) configuration in which SaleLayout renders the cart
    // ALONE. The U2 track flip made the first grid track the fixed 380px rail,
    // and CSS grid auto-places a lone child into track 1 — so a solitary cart
    // would have collapsed into a narrow rail beside an empty `1fr` column on
    // viewports wider than 1023px. The two-track template must therefore be
    // keyed on the catalogue's presence, not applied unconditionally.
    //
    // HONEST LIMIT: same as the sibling test above — this proves the CSS HOOK
    // tracks `showCatalogue`, not that the rendered tracks are correct. jsdom
    // computes no stylesheet-driven grid tracks. Not FR-15 coverage.
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: false });
    renderWorkspace();

    const layout = screen.getByTestId('sale-layout');
    expect(layout).toHaveAttribute('data-catalogue', 'false');
    // Dominance is unconditional: a lone cart is trivially the dominant region.
    expect(layout).toHaveAttribute('data-cart-dominant', 'true');
  });

  it('marks the layout two-region when the catalogue is present', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: true });
    renderWorkspace();

    const layout = screen.getByTestId('sale-layout');
    expect(layout).toHaveAttribute('data-catalogue', 'true');
  });

  it('keeps the gated (cart-off) surface Arabic-first (FR-19, plan A9)', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: false, productSearch: false });
    renderWorkspace();

    // plan.md A9: the cart-gated state was English-only after U1; U2 closes it.
    // FR-27: gated is not failed — the copy must read as "not enabled yet",
    // never as an error.
    const gated = screen.getByTestId('cart-gated-placeholder');
    expect(gated.textContent).toMatch(/[؀-ۿ]/u);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('U2 / T064 — honest VAT placeholder preserved exactly (D-007)', () => {
  it('renders VAT as a tax-pending placeholder and never a computed figure', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: false });
    renderWorkspace();

    const vat = screen.getByTestId('cart-vat-value');
    // The placeholder is an em dash plus the tax-pending note. It is NOT a
    // number: 012-vat-fiscal-receipt has not landed, so any digit here would be
    // a fabricated tax figure (FR-37).
    expect(vat.textContent).toContain('—');
    expect(vat.textContent).toMatch(/tax-pending/);
    expect(vat.textContent).not.toMatch(/\d/);
  });

  it('introduces no 15% VAT line from the reference image (Non-Capability)', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: false });
    renderWorkspace();

    // visual-references/03-sale-workspace.png shows "ضريبة القيمة المضافة (15%)".
    // The Non-Capability Inventory voids it: the image governs appearance only.
    const totals = screen.getByTestId('cart-totals');
    expect(totals.textContent).not.toMatch(/15\s*%/);
  });

  it('shows the empty-cart totals as placeholders, not zeroes', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: false });
    renderWorkspace();

    // An empty cart has no computed subtotal; rendering 0.00 would assert a
    // total the engine never produced.
    const totals = screen.getByTestId('cart-totals');
    expect(within(totals).getByLabelText('subtotal placeholder')).toHaveTextContent('—');
    expect(within(totals).getByLabelText('total placeholder')).toHaveTextContent('—');
  });
});

describe('U2 / T065 — single cart mutation path preserved (FR-20/FR-40)', () => {
  it('mounts the catalogue inside the same layout as the cart it writes into', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: true });
    renderWorkspace();

    // 005's seam: CartPane hands UP its internal addLine via onLineAdded
    // (a register-callback); CartWorkspace forwards it to CatalogueSalePane.
    // Both panes must live in the one layout for that single write path to
    // hold — a catalogue rendered outside it would imply a parallel mutation.
    const layout = screen.getByTestId('sale-layout');
    expect(layout).toContainElement(screen.getByTestId('catalogue-sale-pane'));
    expect(layout).toContainElement(screen.getByTestId('cart-totals'));
  });

  it('renders no second add-to-cart surface beside the catalogue', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: true });
    renderWorkspace();

    // Exactly one catalogue sale pane ⇒ exactly one confirm-add entry point.
    expect(screen.getAllByTestId('catalogue-sale-pane')).toHaveLength(1);
  });
});
