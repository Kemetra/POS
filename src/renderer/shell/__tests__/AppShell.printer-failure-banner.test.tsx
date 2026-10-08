/**
 * T291 — AppShell mounts <PrinterFailureBanner> fed by useBannerState.
 *
 * The banner is a sibling under the connection StatusBanner (per §A1 brief (f)
 * stack order; AppShell is the real host — `BannerHost.tsx` never existed).
 * Its `printFailure` is sourced from the snapshot-poll hook (useBannerState →
 * sales.subscribe(banner_state)). When the terminal has no print failure the
 * banner is unmounted (renders nothing).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppShell } from '../AppShell';
import type { SalesBridgeAPI } from '../../../shared/bridge-api';
import type { BannerState } from '../../../shared/sales/types';
import { useDrawerNoticeStore } from '../../ui/receipts/drawer-notice-store';

afterEach(() => {
  cleanup();
  useDrawerNoticeStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

function salesBridge(banner: BannerState): SalesBridgeAPI {
  return {
    read: vi.fn(),
    findByNumber: vi.fn(),
    subscribe: vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, subscription_token: 't', banner_state: banner }),
    ),
    unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
  };
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/app/dashboard']}>
      <Routes>
        <Route path="/app/*" element={<AppShell />}>
          <Route path="dashboard" element={<div data-testid="dashboard-outlet">Dashboard</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('T291 — AppShell printer-failure banner integration', () => {
  it('mounts the banner when the terminal has an unresolved print failure', async () => {
    (window as unknown as { api: { sales: SalesBridgeAPI } }).api = {
      sales: salesBridge({
        printer_failure: {
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        },
        drawer_failure: null,
      }),
    };
    renderShell();
    await waitFor(() => expect(screen.getByText('فشل طباعة الإيصال')).toBeInTheDocument());
  });

  it('does NOT render the banner when there is no print failure (both-null)', async () => {
    (window as unknown as { api: { sales: SalesBridgeAPI } }).api = {
      sales: salesBridge({ printer_failure: null, drawer_failure: null }),
    };
    renderShell();
    // The dashboard renders; the banner does not.
    await screen.findByTestId('dashboard-outlet');
    expect(screen.queryByText('فشل طباعة الإيصال')).toBeNull();
  });

  it('does not crash when no sales bridge is available (banner stays unmounted)', () => {
    renderShell();
    expect(screen.getByTestId('dashboard-outlet')).toBeInTheDocument();
    expect(screen.queryByText('فشل طباعة الإيصال')).toBeNull();
  });

  it('the Reprint + Manual entry-point callbacks are wired (clicking does not crash)', async () => {
    // has_successful_print:true enables Reprint. Both entry-points are Slice
    // 5/6 stubs; this proves they are wired (enabled⟹wired) and inert-safe.
    (window as unknown as { api: { sales: SalesBridgeAPI } }).api = {
      sales: salesBridge({
        printer_failure: {
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: true,
        },
        drawer_failure: null,
      }),
    };
    renderShell();
    await waitFor(() => expect(screen.getByText('فشل طباعة الإيصال')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'نسخة' }));
    await userEvent.click(screen.getByRole('button', { name: 'إيصال يدوي' }));
    // No throw; banner still present (entry-points are inert stubs).
    expect(screen.getByText('فشل طباعة الإيصال')).toBeInTheDocument();
  });

  it('mounts the drawer-failure banner and its Manual entry-point is wired', async () => {
    // Drawer twin of the printer-banner wiring check: a `.drawer_failure` slice
    // feeds useDrawerBannerState → the D-B1 drawer notice, whose recovery affordance
    // is the Slice-6 manual-override entry-point. Clicking it exercises the
    // AppShell `onManualOverride` stub the printer-only fixtures never reach.
    (window as unknown as { api: { sales: SalesBridgeAPI } }).api = {
      sales: salesBridge({
        printer_failure: null,
        drawer_failure: { sale_id: 'sale-1', last_successful_open_at: null },
      }),
    };
    // RT-241 (D-B1): this session already read a clean projection.
    useDrawerNoticeStore.getState().observe(null);
    renderShell();
    const drawerBanner = await screen.findByTestId('drawer-notice');
    expect(drawerBanner).toBeInTheDocument();
    // Scope the click to the drawer banner — its Manual receipt button is the
    // only one on screen (printer_failure is null), but scoping keeps the intent
    // explicit and survives a future printer+drawer coexistence fixture.
    await userEvent.click(within(drawerBanner).getByRole('button', { name: 'إيصال يدوي' }));
    // No throw; the banner persists (the entry-point is an inert Slice-6 stub).
    expect(screen.getByTestId('drawer-notice')).toBeInTheDocument();
  });

  it('RT-241 (D-B1): a drawer failure from before this run is not shown on the manager shell', async () => {
    const bridge = salesBridge({
      printer_failure: null,
      drawer_failure: { sale_id: 'sale-old', last_successful_open_at: null },
    });
    (window as unknown as { api: { sales: SalesBridgeAPI } }).api = { sales: bridge };
    renderShell();
    await waitFor(() => {
      expect(useDrawerNoticeStore.getState().baseline).toBe('sale-old');
    });
    expect(screen.queryByTestId('drawer-notice')).not.toBeInTheDocument();
  });
});
