import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { InventoryPlaceholder } from '../InventoryPlaceholder';
import { expectNoAxeViolations } from '../../../ui/primitives/__tests__/axe-config';

/**
 * RT-503 (VN-S10 S10-6, G-6 state 11) — Inventory: an honest Arabic notice and
 * the link tile to the read-only catalogue check (010 diagnostics). The screen
 * lives at /app/inventory/diagnostics and is reached from WITHIN Inventory (not
 * as an eighth nav entry). It implies no inventory management.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderInventory(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <InventoryPlaceholder />
    </MemoryRouter>,
  );
}

describe('InventoryPlaceholder', () => {
  it('titles the page «المخزون» with the honest neutral notice', () => {
    renderInventory();
    expect(screen.getByRole('heading', { level: 1, name: 'المخزون' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('إدارة المخزون غير متاحة على هذا الجهاز.');
  });

  it('renders the «فحص الكتالوج» tile linking to the diagnostics route', () => {
    renderInventory();
    const link = screen.getByTestId('inventory-diagnostics-link');
    expect(link).toHaveAttribute('href', '/app/inventory/diagnostics');
    expect(link).toHaveTextContent('فحص الكتالوج');
    expect(link).toHaveTextContent('حالة كتالوج الأصناف على هذا الجهاز، والبحث فيه.');
    expect(screen.getByRole('link', { name: /فحص الكتالوج/ })).toBe(link);
  });

  it('shows no English copy and ignores the retired dev ?state= gallery', () => {
    window.history.replaceState({}, '', '/?state=loading');
    try {
      const { container } = renderInventory();
      expect(container.textContent).not.toMatch(/[A-Za-z]/);
      expect(screen.getByRole('heading', { level: 1, name: 'المخزون' })).toBeInTheDocument();
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('makes zero fetch calls on mount', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderInventory();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is axe-clean', async () => {
    const { container } = renderInventory();
    await expectNoAxeViolations(container);
  });
});
