import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, Navigate } from 'react-router-dom';

import { AppShell } from '../../../shell/AppShell';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { DashboardRoute } from '../DashboardRoute';
import { SalesWorkspace } from '../SalesWorkspace';
import { InventoryPlaceholder } from '../InventoryPlaceholder';
import { SettingsHelpPlaceholder } from '../SettingsHelpPlaceholder';

afterEach(cleanup);

beforeEach(() => {
  // RT-499: the dashboard route is the manager home, so it needs a signed-in manager.
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'sess-mgr',
    operator_id: 'op-mgr',
    display_name: 'سارة عبد الحميد',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    started_at: '2026-10-15T07:00:00.000Z',
  });
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      // happy-dom has no real MediaQueryList constructor; cast is required in tests.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      return {
        matches:
          query.includes('min-width: 1280px') ||
          query.includes('min-width: 1024px') ||
          query.includes('min-height'),
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
  useOperatorSessionStore.getState().reset();
});

function renderApp(initialPath = '/app/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/app" element={<AppShell />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<DashboardRoute />} />
          <Route path="sales" element={<SalesWorkspace />} />
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
      expect(screen.getByRole('heading', { level: 1, name: 'المبيعات' })).toBeInTheDocument(),
    );
  });

  it('the Sale (cart) nav entry points at /app/cart', () => {
    // POS v3.5: the cart entry's English accessible name is "Sale" (Arabic
    // visible label "نقطة البيع"). Since the 023 cutover /app/cart is served by
    // the V5 Sale under its own layout (app-cart-cutover.test.tsx), so this
    // AppShell-only harness checks the link target, not the screen.
    renderApp();
    expect(screen.getByRole('link', { name: 'Sale' })).toHaveAttribute('href', '/app/cart');
  });

  it('clicking Inventory nav entry shows InventoryPlaceholder', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('link', { name: 'Inventory' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'المخزون' })).toBeInTheDocument(),
    );
  });

  it('clicking Settings/Help nav entry shows SettingsHelpPlaceholder', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('link', { name: /settings/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'الإعدادات' })).toBeInTheDocument(),
    );
  });

  it('clicking Dashboard nav entry shows the manager home', async () => {
    const user = userEvent.setup();
    renderApp('/app/sales');
    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'لوحة المتابعة' })).toBeInTheDocument(),
    );
  });
});
