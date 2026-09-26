import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { CatalogueSalePane } from '../CatalogueSalePane.js';
import { useCatalogueSearchStore } from '../../../stores/catalogueSearchStore.js';
import { useCartStore } from '../../../stores/cart-store.js';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../../shared/bridge-api.js';
import type { ProductSnapshotDisplay } from '../../../../shared/catalogue/product-snapshot.js';
import { expectNoAxeViolations } from '../../primitives/__tests__/axe-config.js';

/**
 * 009-product-search-and-barcode-lookup T051 — live-composition accessibility.
 *
 * Where T019 (`a11y.test.tsx`) axe-checks each surface component in ISOLATION,
 * this is the assembled-screen sweep: it renders the real composition root
 * (`CatalogueSalePane`), drives the search FSM (`catalogueSearchStore`) through
 * each of the seven states a cashier can reach, and asserts the LIVE-rendered
 * DOM is axe-clean in every one. This proves the assembled screen — not just the
 * parts — has zero axe violations, including any cross-surface interaction
 * (shared ids, landmark/region conflicts) that isolation cannot catch.
 *
 * The seven states (per the FSM): idle, searching, results, not_found,
 * catalogue_unavailable, ambiguous, confirm_pending. Each is driven via the same
 * bridge-injection + fireEvent patterns as `CatalogueSalePane.test.tsx`, then we
 * waitFor the actual rendered surface (DOM, not just `state.kind`) before axe
 * inspects the container.
 *
 * Provenance: NFR-5 (accessibility floor) / P14 (44×44 keyboard-operable) /
 * SC-1 (every reachable state is usable). Disabled-rule policy is owned by
 * `axe-config.ts` (color-contrast + meta-viewport, with rationale there).
 */

const PRODUCT: ProductSnapshotDisplay = {
  product_id: 'p-1',
  display_name_ar: 'بنادول إكسترا 500 مجم',
  display_name_en: 'Panadol Extra 500mg',
  price_minor: 1500,
  unit_pack_label: '×20 أقراص',
  selling_barcode: '6221000000001',
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

function catalogueBridge(over: Partial<CatalogueBridgeAPI> = {}): CatalogueBridgeAPI {
  return {
    lookupBarcode: vi.fn(),
    lookupSku: vi.fn(),
    search: vi.fn(),
    resolve: vi.fn(),
    refresh: vi.fn(),
    freshness: vi.fn(),
    counts: vi.fn(),
    ...over,
  };
}

function cartBridge(): CartBridgeAPI {
  return {
    create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-1' }),
    lines: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: vi.fn(),
    handoff: vi.fn(),
    subscribe: vi.fn(),
  };
}

beforeEach(() => {
  useCatalogueSearchStore.getState().reset();
  // Reset the cart store too so `activeCart` never leaks across cases — the same
  // posture as CatalogueSalePane.test.tsx (CodeRabbit #327).
  useCartStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * Every case mounts with an explicit `cartId="cart-1"`, uniform across cases,
 * so a confirmed add never needs a lazy `cart.create` (#466) — every state
 * renders a stable DOM with no pending create in flight.
 */
describe('T051 — live composition is axe-clean in every FSM state (NFR-5 / SC-1)', () => {
  it('idle (initial render) is axe-clean', async () => {
    const { container } = render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge()}
        cartBridge={cartBridge()}
      />,
    );
    // Idle is the mount state — the search input + scan field are present.
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('searching (in-flight) is axe-clean', async () => {
    // A search that never resolves keeps the FSM in `searching` so the busy
    // surface is observable.
    const search = vi.fn().mockReturnValue(new Promise<never>(() => {}));
    const { container } = render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'بنادول' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-searching')).toBeInTheDocument();
    });
    await expectNoAxeViolations(container);
  });

  it('results (≥1 match) is axe-clean', async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ kind: 'results', items: [PRODUCT], truncated: false });
    const { container } = render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'بنادول' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByRole('option')).toBeInTheDocument();
    });
    await expectNoAxeViolations(container);
  });

  it('not_found is axe-clean', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'not_found' });
    const { container } = render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: '6221000000000' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-not-found')).toBeInTheDocument();
    });
    await expectNoAxeViolations(container);
  });

  it('catalogue_unavailable is axe-clean', async () => {
    const search = vi.fn().mockResolvedValue({ kind: 'catalogue_unavailable' });
    const { container } = render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ search })}
        cartBridge={cartBridge()}
      />,
    );
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'xyz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-unavailable')).toBeInTheDocument();
    });
    await expectNoAxeViolations(container);
  });

  it('ambiguous is axe-clean', async () => {
    const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'ambiguous' });
    const { container } = render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cartBridge()}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '111' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('catalogue-ambiguous')).toBeInTheDocument();
    });
    await expectNoAxeViolations(container);
  });

  it('confirm_pending (exact single match) is axe-clean', async () => {
    const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'one', product: PRODUCT });
    const { container } = render(
      <CatalogueSalePane
        cartId="cart-1"
        onLineAdded={vi.fn()}
        catalogueBridge={catalogueBridge({ lookupBarcode })}
        cartBridge={cartBridge()}
      />,
    );
    const scan = screen.getByTestId('scan-capture-field');
    fireEvent.change(scan, { target: { value: '6221000000001' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    // The confirm panel (mounted by CatalogueAddController) carries the Add button.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add|إضافة/i })).toBeInTheDocument();
    });
    await expectNoAxeViolations(container);
  });
});
