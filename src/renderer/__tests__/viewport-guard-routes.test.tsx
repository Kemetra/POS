import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../router';
import type { OperatorBridgeAPI, PairingBridgeAPI } from '../../shared/bridge-api';
import type { PairingStatus } from '../../shared/pairing-types';

/**
 * RT-241 (VNext W1-A, VN-S2) — pairing, the Ready screen and sign-in sit
 * outside the V5 frame, so before this slice they had no supported-viewport
 * guard. Below 1024px they now show only the Arabic ScreenTooSmall notice. The
 * guard wraps the route ELEMENT only: the boot read still runs exactly once, so
 * pairing semantics are unchanged.
 */

const TOO_SMALL_HEADING = /^الشاشة أصغر من 1024×768\s?\.$/;

function stubViewport(width: number): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? '0');
      return {
        matches: width >= min,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  );
}

function bridgeWith(status: PairingStatus): {
  bridge: PairingBridgeAPI;
  getStatus: ReturnType<typeof vi.fn>;
} {
  const getStatus = vi.fn(() => Promise.resolve(status));
  return {
    getStatus,
    bridge: { getStatus, submit: vi.fn(() => Promise.reject(new Error('unused'))) },
  };
}

const PAIRED: PairingStatus = {
  kind: 'paired',
  tenant_id: 'tenant-A',
  branch_id: 'branch-B',
  terminal_id: 'terminal-C',
  terminal_label: 'Counter 1',
  paired_at: 1735689600,
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('supported-viewport guard outside the frame', () => {
  it('pairing at 1023px shows only the too-small notice; the boot read still runs once', async () => {
    stubViewport(1023);
    const { bridge, getStatus } = bridgeWith({ kind: 'unpaired' });
    render(<AppRouter pairing={bridge} />);

    expect(await screen.findByRole('heading', { name: TOO_SMALL_HEADING })).toBeInTheDocument();
    expect(screen.queryByTestId('route-pairing')).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/pairing');
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('the Ready screen at 1023px shows only the too-small notice', async () => {
    stubViewport(1023);
    const { bridge } = bridgeWith(PAIRED);
    render(<AppRouter pairing={bridge} />);

    expect(await screen.findByRole('heading', { name: TOO_SMALL_HEADING })).toBeInTheDocument();
    expect(screen.queryByTestId('route-paired')).not.toBeInTheDocument();
  });

  it('sign-in at 1023px shows only the too-small notice and never mounts the sign-in screen', async () => {
    stubViewport(1023);
    const { bridge } = bridgeWith(PAIRED);
    // An empty operator bridge: any sign-in mount would call into it and throw.
    render(
      <AppRouter pairing={bridge} operator={{} as OperatorBridgeAPI} initialEntry="/sign-in" />,
    );

    expect(await screen.findByRole('heading', { name: TOO_SMALL_HEADING })).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('at 1024px pairing renders as before', async () => {
    stubViewport(1024);
    const { bridge } = bridgeWith({ kind: 'unpaired' });
    render(<AppRouter pairing={bridge} />);

    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: TOO_SMALL_HEADING })).not.toBeInTheDocument();
  });
});
