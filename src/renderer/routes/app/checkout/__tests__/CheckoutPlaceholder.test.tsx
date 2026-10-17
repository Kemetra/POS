import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { CheckoutPlaceholder } from '../CheckoutPlaceholder';
import { expectNoAxeViolations } from '../../../../test-utils/axe-config';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/**
 * RT-503 (VN-S10 S10-6, G-6 «الدفع غير مفعّل») — `/app/checkout` while the
 * payments flag is off: an Arabic notice in a ScreenSection and the way back to
 * the Sale. It replaces the 003-era reservation of eleven tender slots; it
 * carries no payment logic, IPC, persistence or printing.
 */

function renderPlaceholder(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <CheckoutPlaceholder />
    </MemoryRouter>,
  );
}

describe('CheckoutPlaceholder (payments flag off)', () => {
  it('titles the page «الدفع» with the honest neutral notice', () => {
    renderPlaceholder();
    expect(screen.getByRole('heading', { level: 1, name: 'الدفع' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('الدفع غير مفعّل على هذا الجهاز.');
  });

  it('offers «العودة إلى البيع», a link to /app/cart', () => {
    renderPlaceholder();
    expect(screen.getByRole('link', { name: 'العودة إلى البيع' })).toHaveAttribute(
      'href',
      '/app/cart',
    );
  });

  it('reserves no tender slot and shows no English copy', () => {
    const { container } = renderPlaceholder();
    expect(container.querySelector('[data-slot-id]')).toBeNull();
    expect(container.textContent).not.toMatch(/[A-Za-z]/);
  });

  // Boundary kept from the retired reserved-slot guard: no IPC, persistence or
  // printing, on mount or when the way back is used.
  it('makes zero fetch, storage and print calls on mount and on a click of the way back', async () => {
    const fetchMock = vi.fn();
    const printMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('print', printMock);
    const localStorageSpy = vi.spyOn(window, 'localStorage', 'get');
    const sessionStorageSpy = vi.spyOn(window, 'sessionStorage', 'get');
    try {
      renderPlaceholder();
      await userEvent.click(screen.getByRole('link', { name: 'العودة إلى البيع' }));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(printMock).not.toHaveBeenCalled();
      expect(localStorageSpy).not.toHaveBeenCalled();
      expect(sessionStorageSpy).not.toHaveBeenCalled();
    } finally {
      localStorageSpy.mockRestore();
      sessionStorageSpy.mockRestore();
    }
  });

  it('does not read window.api on mount', () => {
    const api = new Proxy(
      {},
      {
        get: () => {
          throw new Error('window.api touched');
        },
      },
    );
    (window as unknown as { api: unknown }).api = api;
    try {
      expect(() => renderPlaceholder()).not.toThrow();
    } finally {
      delete (window as unknown as { api?: unknown }).api;
    }
  });

  it('is axe-clean', async () => {
    const { container } = renderPlaceholder();
    await expectNoAxeViolations(container);
  });
});
