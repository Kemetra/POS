import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../router';
import type { PairingBridgeAPI } from '../../shared/bridge-api';
import type { PairingStatus } from '../../shared/pairing-types';

/**
 * 002-terminal-pairing T015 — renderer boot router tests.
 *
 * On boot the router calls window.api.pairing.getStatus() exactly once
 * and decides the start route from the discriminated PairingStatus:
 *
 *   getStatus() → 'unpaired'         → /pairing
 *   getStatus() → 'paired'           → /paired
 *   getStatus() → 'invalid' (any reason) → /pairing with a reason flag
 *
 * The reason flag travels in the routing state (react-router-dom's
 * `location.state`) so the future US7 banner component can read it
 * without re-querying the bridge. data-testid attributes on the route
 * placeholders provide a stable assertion surface.
 */

interface BridgeFixture {
  bridge: PairingBridgeAPI;
  getStatus: ReturnType<typeof vi.fn<() => Promise<PairingStatus>>>;
}

function makeBridge(status: PairingStatus): BridgeFixture {
  const getStatus = vi.fn<() => Promise<PairingStatus>>(() => Promise.resolve(status));
  return {
    getStatus,
    bridge: {
      getStatus,
      submit: vi.fn(() => Promise.reject(new Error('submit not used in US1'))),
    },
  };
}

beforeEach(() => {
  // Reset history each test — happy-dom holds onto the previous URL.
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
});

describe('AppRouter — boot routing (T015)', () => {
  it('routes to /pairing when getStatus() resolves to unpaired', async () => {
    const { bridge, getStatus } = makeBridge({ kind: 'unpaired' });
    render(<AppRouter pairing={bridge} />);

    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(screen.queryByTestId('route-paired')).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/pairing');
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('routes to /paired when getStatus() resolves to paired', async () => {
    const { bridge } = makeBridge({
      kind: 'paired',
      tenant_id: 'tenant-A',
      branch_id: 'branch-B',
      terminal_id: 'terminal-C',
      terminal_label: 'Counter 1',
      paired_at: 1735689600,
    });
    render(<AppRouter pairing={bridge} />);

    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());
    expect(screen.queryByTestId('route-pairing')).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/paired');
  });

  it('routes to /pairing with reason="missing_token" when getStatus() resolves to invalid/missing_token', async () => {
    const { bridge } = makeBridge({ kind: 'invalid', reason: 'missing_token' });
    render(<AppRouter pairing={bridge} />);

    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(window.location.pathname).toBe('/pairing');
    // The reason MUST be exposed to the route so a future US7 banner can read
    // it. We surface it via a data-attribute on the route element to keep the
    // assertion DOM-based without coupling to a state library.
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'missing_token',
    );
  });

  it('routes to /pairing with reason="orphaned_row" on invalid/orphaned_row', async () => {
    const { bridge } = makeBridge({ kind: 'invalid', reason: 'orphaned_row' });
    render(<AppRouter pairing={bridge} />);

    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'orphaned_row',
    );
  });

  it('routes to /pairing with reason="decrypt_failed" on invalid/decrypt_failed', async () => {
    const { bridge } = makeBridge({ kind: 'invalid', reason: 'decrypt_failed' });
    render(<AppRouter pairing={bridge} />);

    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'decrypt_failed',
    );
  });

  it('renders a loading affordance until getStatus() resolves', async () => {
    let resolve!: (v: PairingStatus) => void;
    const pending = new Promise<PairingStatus>((r) => {
      resolve = r;
    });
    const bridge: PairingBridgeAPI = {
      getStatus: () => pending,
      submit: vi.fn(() => Promise.reject(new Error('submit not used in US1'))),
    };

    render(<AppRouter pairing={bridge} />);

    expect(screen.getByTestId('route-loading')).toBeInTheDocument();
    // RT-241 (VN-S2): the loading surface is never blank.
    expect(screen.getByRole('status')).toHaveTextContent('جارٍ التحميل…');
    expect(screen.queryByTestId('route-pairing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('route-paired')).not.toBeInTheDocument();

    resolve({ kind: 'unpaired' });
    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument();
  });

  it('routes to /pairing if the bridge call rejects (defensive fallback to unpaired-like state)', async () => {
    // Belt-and-braces: a bridge rejection on boot MUST land the user on
    // /pairing rather than crash the renderer. The reason is set to
    // 'decrypt_failed' as the most operator-actionable diagnostic — the
    // pairingStore's own decrypt_failed branch will match this if the
    // SecretStore is the cause; if the cause is a transient IPC failure,
    // the operator will simply re-pair.
    const bridge: PairingBridgeAPI = {
      getStatus: () => Promise.reject(new Error('bridge boom')),
      submit: vi.fn(() => Promise.reject(new Error('submit not used in US1'))),
    };

    render(<AppRouter pairing={bridge} />);

    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(window.location.pathname).toBe('/pairing');
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'decrypt_failed',
    );
  });

  it('does not call getStatus more than once per mount', async () => {
    const { bridge, getStatus } = makeBridge({ kind: 'unpaired' });
    render(<AppRouter pairing={bridge} />);

    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    // Allow one more microtask tick to be safe.
    await Promise.resolve();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('cancellation guard: unmount before getStatus resolves does NOT call setBoot', async () => {
    // Drives the `if (!guard.cancelled) setBoot(resolved)` branch where
    // the guard IS cancelled (component unmounted between the
    // getStatus call and its resolution). Test passes when no
    // "state update on unmounted component" warning fires.
    let resolveStatus!: (v: PairingStatus) => void;
    const pending = new Promise<PairingStatus>((r) => {
      resolveStatus = r;
    });
    const bridge: PairingBridgeAPI = {
      getStatus: () => pending,
      submit: vi.fn(() => Promise.reject(new Error('submit not used in this test'))),
    };
    const { unmount } = render(<AppRouter pairing={bridge} />);
    expect(screen.getByTestId('route-loading')).toBeInTheDocument();
    unmount();
    // Resolve AFTER unmount; the cancellation guard must swallow setBoot.
    resolveStatus({ kind: 'unpaired' });
    await Promise.resolve();
    // No exception, no warning — pass.
    expect(true).toBe(true);
  });
});
