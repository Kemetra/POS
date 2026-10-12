import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { READY_COPY } from '../../../v5/entry/entry-copy';
import { PairedScreen } from '../PairedScreen';
import type { PairingBridgeAPI } from '../../../../shared/bridge-api';
import type { PairingStatus } from '../../../../shared/pairing-types';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const PAIRED_STATUS: Extract<PairingStatus, { kind: 'paired' }> = {
  kind: 'paired',
  tenant_id: 'Acme',
  branch_id: 'Main St',
  terminal_id: 'terminal-1',
  terminal_label: 'Counter 1',
  paired_at: 1735689600,
};

function makeBridge(status: PairingStatus = PAIRED_STATUS): PairingBridgeAPI {
  return {
    getStatus: vi.fn(() => Promise.resolve(status)),
    submit: vi.fn(() => Promise.reject(new Error('not used'))),
  };
}

function renderWithRouter(bridge: PairingBridgeAPI) {
  return render(
    <MemoryRouter initialEntries={['/paired']}>
      <Routes>
        <Route path="/paired" element={<PairedScreen pairing={bridge} />} />
        <Route path="/pairing" element={<div data-testid="route-pairing" />} />
        <Route path="/app/dashboard" element={<div data-testid="route-app-dashboard" />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * T053 — /paired → /app/dashboard journey.
 *
 * Option chosen: PairedScreen adds a "Continue to dashboard →" Button
 * (Button intent="primary") that navigates to /app/dashboard.
 * The boot router's getStatus() gate is NOT modified.
 */
describe('PairedScreen continue-to-dashboard (T053)', () => {
  it('does NOT modify the boot router pairing gate (unpaired still routes to /pairing)', async () => {
    const bridge = makeBridge({ kind: 'unpaired' });
    render(
      <MemoryRouter initialEntries={['/paired']}>
        <Routes>
          <Route path="/paired" element={<PairedScreen pairing={bridge} />} />
          <Route path="/pairing" element={<div data-testid="route-pairing" />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
  });

  it('/paired is not a dead-end — shows "Continue" button', async () => {
    const bridge = makeBridge();
    renderWithRouter(bridge);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: READY_COPY.continue })).toBeInTheDocument(),
    );
  });

  it('no "skip pairing" / "pair later" affordance on /paired', async () => {
    const bridge = makeBridge();
    renderWithRouter(bridge);
    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /skip pairing/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pair later/i })).not.toBeInTheDocument();
  });

  it('clicking Continue navigates to /app/dashboard', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    renderWithRouter(bridge);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: READY_COPY.continue })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: READY_COPY.continue }));
    await waitFor(() => expect(screen.getByTestId('route-app-dashboard')).toBeInTheDocument());
  });

  it('no IPC / bridge call / localStorage during Continue navigation', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const lsSpy = vi.spyOn(window, 'localStorage', 'get');
    renderWithRouter(bridge);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: READY_COPY.continue })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: READY_COPY.continue }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lsSpy).not.toHaveBeenCalled();
    lsSpy.mockRestore();
  });
});
