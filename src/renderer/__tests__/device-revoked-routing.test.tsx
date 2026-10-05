import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../router';
import type { PairingBridgeAPI } from '../../shared/bridge-api';
import type { PairingStatus, PairingStatusChangedEvent } from '../../shared/pairing-types';

/**
 * RT-215 — routing to pairing recovery for a revoked device.
 *
 *  - At BOOT, unconditionally: `getStatus()` reports `invalid / device_revoked`
 *    (durable on the pairing row), so the router starts at /pairing with the
 *    recovery copy.
 *  - At RUNTIME: main pushes `pairing:status-changed` when the latched session
 *    reached its safe point (or there was none), and the renderer moves to
 *    /pairing with the same copy, from wherever it is.
 */

const PAIRED: PairingStatus = {
  kind: 'paired',
  tenant_id: 'tenant-A',
  branch_id: 'branch-B',
  terminal_id: 'terminal-C',
  terminal_label: 'Counter 1',
  paired_at: 1735689600,
};

interface Bridge {
  bridge: PairingBridgeAPI;
  push(event: PairingStatusChangedEvent): void;
  listeners(): number;
}

function makeBridge(status: PairingStatus): Bridge {
  const subs = new Set<(e: PairingStatusChangedEvent) => void>();
  return {
    bridge: {
      getStatus: vi.fn(() => Promise.resolve(status)),
      submit: vi.fn(() => Promise.reject(new Error('unused'))),
      onStatusChanged: (cb) => {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
    },
    push(event) {
      act(() => {
        for (const cb of subs) cb(event);
      });
    },
    listeners: () => subs.size,
  };
}

const RECOVERY_COPY =
  'This terminal’s access was revoked. Unsent sales are kept on this terminal. Enter a new pairing code from the admin portal to continue.';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
});

describe('RT-215 — device revoked routing', () => {
  it('at boot, a revoked device starts at /pairing with the recovery copy', async () => {
    const b = makeBridge({ kind: 'invalid', reason: 'device_revoked' });
    render(<AppRouter pairing={b.bridge} />);
    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(window.location.pathname).toBe('/pairing');
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'device_revoked',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(RECOVERY_COPY);
    expect(screen.queryByTestId('route-paired')).not.toBeInTheDocument();
  });

  it('at runtime, the device_revoked push moves a paired terminal to /pairing with the recovery copy', async () => {
    const b = makeBridge(PAIRED);
    render(<AppRouter pairing={b.bridge} />);
    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());
    b.push({ kind: 'invalid', reason: 'device_revoked' });
    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(window.location.pathname).toBe('/pairing');
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'device_revoked',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(RECOVERY_COPY);
  });

  it('a pushed reason replaces the boot reason on /pairing', async () => {
    const b = makeBridge({ kind: 'invalid', reason: 'missing_token' });
    render(<AppRouter pairing={b.bridge} />);
    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    b.push({ kind: 'invalid', reason: 'device_revoked' });
    await waitFor(() =>
      expect(screen.getByTestId('route-pairing')).toHaveAttribute(
        'data-invalid-reason',
        'device_revoked',
      ),
    );
  });

  it('a paired / unpaired push does not navigate', async () => {
    const b = makeBridge(PAIRED);
    render(<AppRouter pairing={b.bridge} />);
    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());
    b.push({ kind: 'paired' });
    b.push({ kind: 'unpaired' });
    expect(window.location.pathname).toBe('/paired');
  });

  it('subscribes once and unsubscribes on unmount', async () => {
    const b = makeBridge(PAIRED);
    const { unmount } = render(<AppRouter pairing={b.bridge} />);
    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());
    expect(b.listeners()).toBe(1);
    unmount();
    expect(b.listeners()).toBe(0);
  });

  it('a bridge without the push still routes at boot', async () => {
    const bridge: PairingBridgeAPI = {
      getStatus: () => Promise.resolve({ kind: 'invalid', reason: 'device_revoked' }),
      submit: () => Promise.reject(new Error('unused')),
    };
    render(<AppRouter pairing={bridge} />);
    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(RECOVERY_COPY);
  });
});
