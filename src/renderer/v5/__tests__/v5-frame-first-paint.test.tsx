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
});
