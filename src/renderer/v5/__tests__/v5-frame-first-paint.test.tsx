/**
 * RT-498 (VN-S10 S10-1) — NFR-4 first-paint budget, ported from the legacy
 * `AppShell.first-paint-perf.test.tsx` (T062a). Every `/app/*` screen now
 * paints inside the v5 frame, so the frame's <main> must appear within the
 * same 500 ms budget. The budget is the spec contract and is not softened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import { V5AppLayout } from '../frame/V5AppLayout';
import { AppRouter } from '../../router';
import type { PairingBridgeAPI } from '../../../shared/bridge-api';
import { installViewport } from './__helpers__/viewport-bands';

const NFR_4_BUDGET_MS = 500;

beforeEach(() => {
  installViewport(1280);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('V5 frame first-paint budget (NFR-4, ported from T062a)', () => {
  it('renders the frame <main> within 500 ms of mount', async () => {
    const t0 = performance.now();
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <Routes>
          <Route path="/app" element={<V5AppLayout />}>
            <Route path="dashboard" element={<div data-testid="dashboard-outlet" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('main');
    const elapsed = performance.now() - t0;
    expect(
      elapsed,
      `V5 frame first paint took ${elapsed.toFixed(1)} ms; NFR-4 budget is ${String(NFR_4_BUDGET_MS)} ms`,
    ).toBeLessThanOrEqual(NFR_4_BUDGET_MS);
    expect(screen.getByTestId('dashboard-outlet')).toBeInTheDocument();
  });

  // RT-504: ported from the legacy `AppShell.first-paint-perf.test.tsx`
  // companions. The boot pipeline is the path that reaches the frame.
  describe('paired boot pipeline (AppRouter)', () => {
    function pairedBridge(): { bridge: PairingBridgeAPI; getStatus: ReturnType<typeof vi.fn> } {
      const getStatus = vi.fn().mockResolvedValue({
        kind: 'paired',
        tenant_id: 'test-tenant',
        branch_id: 'test-branch',
        terminal_id: 'term-001',
        terminal_label: 'POS-001',
        paired_at: 1_735_689_600,
      });
      return { bridge: { getStatus, submit: vi.fn() }, getStatus };
    }

    it('renders a <main> landmark', async () => {
      const { bridge } = pairedBridge();
      render(<AppRouter pairing={bridge} initialEntry="/" />);
      const main = await screen.findByRole('main');
      expect(main.tagName.toLowerCase()).toBe('main');
    });

    it('reads the pairing status exactly once during boot', async () => {
      const { bridge, getStatus } = pairedBridge();
      render(<AppRouter pairing={bridge} initialEntry="/" />);
      await screen.findByRole('main');
      expect(getStatus).toHaveBeenCalledTimes(1);
    });
  });
});
