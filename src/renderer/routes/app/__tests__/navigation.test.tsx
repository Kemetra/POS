import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, Navigate } from 'react-router-dom';

import { AppShell } from '../../../shell/AppShell';
import { DashboardPlaceholder } from '../DashboardPlaceholder';
import { SalesWorkspace } from '../SalesWorkspace';
import { CartWorkspace } from '../CartWorkspace';
import { InventoryPlaceholder } from '../InventoryPlaceholder';
import { SettingsHelpPlaceholder } from '../SettingsHelpPlaceholder';

afterEach(cleanup);

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      // happy-dom has no real MediaQueryList constructor; cast is required in tests.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      return {
        matches: query.includes('min-width: 1280px') || query.includes('min-width: 1024px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderApp(initialPath = '/app/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/app" element={<AppShell />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPlaceholder />} />
          <Route path="sales" element={<SalesWorkspace />} />
          <Route path="cart" element={<CartWorkspace />} />
          <Route path="inventory" element={<InventoryPlaceholder />} />
          <Route path="settings" element={<SettingsHelpPlaceholder />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * T038 — Navigation: each NavRail entry reachable via click.
 */
describe('navigation test (T038)', () => {
  it('clicking Sales nav entry shows SalesWorkspace', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('link', { name: 'Sales' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /sales/i })).toBeInTheDocument(),
    );
  });

  it('clicking the Sale (cart) nav entry shows CartWorkspace', async () => {
    // POS v3.5: the cart entry's English accessible name is "Sale" (Arabic
    // visible label "نقطة البيع"); it still routes to /app/cart → CartWorkspace
    // whose Workspace heading remains "Cart".
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('link', { name: 'Sale' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /cart/i })).toBeInTheDocument());
  });

  it('clicking Inventory nav entry shows InventoryPlaceholder', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('link', { name: 'Inventory' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /inventory/i })).toBeInTheDocument(),
    );
  });

  it('clicking Settings/Help nav entry shows SettingsHelpPlaceholder', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('link', { name: /settings/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument(),
    );
  });

  it('clicking Dashboard nav entry shows DashboardPlaceholder', async () => {
    const user = userEvent.setup();
    renderApp('/app/sales');
    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /dashboard/i })).toBeInTheDocument(),
    );
  });
});
