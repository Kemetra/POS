import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { PairingScreen } from '../PairingScreen';
import { RECHECK_COOLDOWN_MS } from '../RevocationRecheck';
import { RECHECK_STILL_REVOKED_MESSAGE, RECHECK_UNREACHABLE_MESSAGE } from '../messages';
import type { PairingBridgeAPI } from '../../../../shared/bridge-api';
import type { PairingInvalidReason, PairingRecheckResult } from '../../../../shared/pairing-types';

/**
 * RT-215 10897-A (owner approval 10906) — the ONE user-initiated "Check
 * again" on `/pairing`, shown only while the terminal is device-revoked.
 */

function makeBridge(recheck?: () => Promise<PairingRecheckResult>): PairingBridgeAPI {
  const bridge: PairingBridgeAPI = {
    getStatus: vi.fn(() => Promise.reject(new Error('unused'))),
    submit: vi.fn(() => Promise.reject(new Error('unused'))),
  };
  if (recheck !== undefined) bridge.recheckRevocation = recheck;
  return bridge;
}

function renderPairing(bridge: PairingBridgeAPI, invalidReason?: PairingInvalidReason): void {
  const reason = invalidReason !== undefined ? { invalidReason } : {};
  render(
    <MemoryRouter initialEntries={['/pairing']}>
      <Routes>
        <Route path="/pairing" element={<PairingScreen pairing={bridge} {...reason} />} />
        <Route path="/paired" element={<div data-testid="route-paired" />} />
      </Routes>
    </MemoryRouter>,
  );
}

const checkAgain = (): HTMLElement => screen.getByRole('button', { name: 'Check again' });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RT-215 10897-A — "Check again" on /pairing', () => {
  it('is shown while the terminal is device-revoked', () => {
    renderPairing(
      makeBridge(() => Promise.resolve({ outcome: 'cleared' })),
      'device_revoked',
    );
    expect(checkAgain()).toBeEnabled();
  });

  it.each<PairingInvalidReason | undefined>([
    undefined,
    'missing_token',
    'orphaned_row',
    'decrypt_failed',
  ])('is NOT shown for %s (only device_revoked can be rechecked)', (reason) => {
    renderPairing(
      makeBridge(() => Promise.resolve({ outcome: 'cleared' })),
      reason,
    );
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  it('is NOT shown when the bridge has no recheck (older preload / test fakes)', () => {
    renderPairing(makeBridge(), 'device_revoked');
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  it('cleared: leaves /pairing for /paired (as a successful pairing does)', async () => {
    const recheck = vi.fn(() => Promise.resolve<PairingRecheckResult>({ outcome: 'cleared' }));
    renderPairing(makeBridge(recheck), 'device_revoked');
    fireEvent.click(checkAgain());
    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('still_revoked: stays on /pairing with a clear "still revoked" message', async () => {
    renderPairing(
      makeBridge(() => Promise.resolve({ outcome: 'still_revoked' })),
      'device_revoked',
    );
    fireEvent.click(checkAgain());
    await waitFor(() =>
      expect(screen.getByTestId('recheck-message')).toHaveTextContent(
        RECHECK_STILL_REVOKED_MESSAGE,
      ),
    );
    expect(screen.getByTestId('route-pairing')).toBeInTheDocument();
  });

  it.each<[string, () => Promise<PairingRecheckResult>]>([
    ['unreachable', () => Promise.resolve({ outcome: 'unreachable' })],
    ['a rejected call', () => Promise.reject(new Error('ipc'))],
  ])('%s: "couldn’t reach the server, try again"', async (_label, recheck) => {
    renderPairing(makeBridge(recheck), 'device_revoked');
    fireEvent.click(checkAgain());
    await waitFor(() =>
      expect(screen.getByTestId('recheck-message')).toHaveTextContent(RECHECK_UNREACHABLE_MESSAGE),
    );
    expect(screen.getByTestId('route-pairing')).toBeInTheDocument();
  });

  it('one check at a time: disabled while in flight, then for a short cooldown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let settle: (r: PairingRecheckResult) => void = () => undefined;
    const recheck = vi.fn(
      () =>
        new Promise<PairingRecheckResult>((resolve) => {
          settle = resolve;
        }),
    );
    renderPairing(makeBridge(recheck), 'device_revoked');
    fireEvent.click(checkAgain());
    fireEvent.click(screen.getByRole('button', { name: 'Checking…' }));
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();

    await act(async () => {
      settle({ outcome: 'still_revoked' });
      await Promise.resolve();
    });
    expect(checkAgain()).toBeDisabled(); // cooldown
    fireEvent.click(checkAgain());
    expect(recheck).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(RECHECK_COOLDOWN_MS);
    });
    expect(checkAgain()).toBeEnabled();
  });
});
