import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

function renderPlaceholder() {
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
  // Seed a signed-in session so CartPane (and the workspace) renders
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'sess-1',
    operator_id: 'op-1',
    display_name: 'Test Operator',
    role: 'manager',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: new Date().toISOString(),
  });
  // Stub window.api so CatalogueSalePane's eager-create effect resolves without throwing
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

describe('CartWorkspace — catalogue surface gating (T049a)', () => {
  it('mounts the catalogue surface when cart AND productSearch are on', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: true });
    renderPlaceholder();
    expect(screen.getByTestId('catalogue-sale-pane')).toBeInTheDocument();
  });

  it('does NOT mount when productSearch is off', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: false });
    renderPlaceholder();
    expect(screen.queryByTestId('catalogue-sale-pane')).not.toBeInTheDocument();
  });

  it('does NOT mount when cart is off', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: false, productSearch: true });
    renderPlaceholder();
    expect(screen.queryByTestId('catalogue-sale-pane')).not.toBeInTheDocument();
  });
});

describe('CartWorkspace — POS v3.5 two-column sale-layout (Phase 2)', () => {
  it('wraps catalogue + cart in a sale-layout container when both surfaces show', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: true });
    renderPlaceholder();
    const layout = screen.getByTestId('sale-layout');
    expect(layout).toBeInTheDocument();
    // Both panes live inside the two-column layout (v3.5: catalogue + cart).
    expect(layout).toContainElement(screen.getByTestId('catalogue-sale-pane'));
  });

  it('renders the sale-layout even when only the cart pane shows (productSearch off)', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, productSearch: false });
    renderPlaceholder();
    // The layout container is the stable workspace frame; the catalogue column
    // is simply absent when productSearch is off.
    expect(screen.getByTestId('sale-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('catalogue-sale-pane')).not.toBeInTheDocument();
  });
});
