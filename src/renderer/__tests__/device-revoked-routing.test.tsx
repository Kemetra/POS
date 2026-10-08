import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../router';
import { createPairingPushRelay } from '../routes/pairing/PairingRecoveryListener';
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

describe('Codex P2 4186254473 — a push sent before the listener subscribed is not lost', () => {
  /** A bridge whose boot read is held until released; pushes go to every subscriber. */
  function heldBootBridge() {
    const subs = new Set<(e: PairingStatusChangedEvent) => void>();
    let releaseBoot: (s: PairingStatus) => void = () => undefined;
    const bootRead = new Promise<PairingStatus>((r) => {
      releaseBoot = r;
    });
    const getStatus = vi.fn(() => bootRead);
    const bridge: PairingBridgeAPI = {
      getStatus,
      submit: vi.fn(() => Promise.reject(new Error('unused'))),
      onStatusChanged: (cb) => {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
    };
    return {
      bridge,
      getStatus,
      subscribers: () => subs.size,
      push(event: PairingStatusChangedEvent) {
        act(() => {
          for (const cb of subs) cb(event);
        });
      },
      async boot(status: PairingStatus) {
        await act(async () => {
          releaseBoot(status);
          await bootRead;
        });
      },
    };
  }

  it('the router subscribes BEFORE the boot status read', () => {
    const b = heldBootBridge();
    render(<AppRouter pairing={b.bridge} />);
    expect(b.subscribers()).toBe(1); // registered while the boot read is pending
    expect(b.getStatus).toHaveBeenCalledTimes(1);
  });

  it('a push emitted while the boot read is still pending ends on the recovery route', async () => {
    const b = heldBootBridge();
    render(<AppRouter pairing={b.bridge} />);
    b.push({ kind: 'invalid', reason: 'device_revoked' }); // before the listener exists
    await b.boot(PAIRED); // the boot read was taken before the revocation
    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'device_revoked',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(RECOVERY_COPY);
  });

  it('a later paired push cancels an earlier missed revocation', async () => {
    const b = heldBootBridge();
    render(<AppRouter pairing={b.bridge} />);
    b.push({ kind: 'invalid', reason: 'device_revoked' });
    b.push({ kind: 'paired' });
    await b.boot(PAIRED);
    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());
  });

  it('idempotent: a push the listener already handled is not replayed', async () => {
    const b = heldBootBridge();
    render(<AppRouter pairing={b.bridge} />);
    await b.boot(PAIRED);
    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());
    b.push({ kind: 'invalid', reason: 'device_revoked' }); // the listener handles it
    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(window.location.pathname).toBe('/pairing');
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'device_revoked',
    );
  });

  it('rev546c: under React.StrictMode (dev double effects) a missed push still ends on recovery', async () => {
    const b = heldBootBridge();
    render(
      <StrictMode>
        <AppRouter pairing={b.bridge} />
      </StrictMode>,
    );
    b.push({ kind: 'invalid', reason: 'device_revoked' }); // before the listener exists
    await b.boot(PAIRED);
    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'device_revoked',
    );
  });

  it('a push handled live after attach drops an older missed one (never replayed twice)', async () => {
    const b = heldBootBridge();
    render(<AppRouter pairing={b.bridge} />);
    b.push({ kind: 'invalid', reason: 'decrypt_failed' }); // missed
    await b.boot(PAIRED);
    // The live push arrives right after attach; the missed one must not win afterwards.
    b.push({ kind: 'invalid', reason: 'device_revoked' });
    await waitFor(() =>
      expect(screen.getByTestId('route-pairing')).toHaveAttribute(
        'data-invalid-reason',
        'device_revoked',
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'device_revoked',
    );
  });

  it('unsubscribes the early recorder on unmount', () => {
    const b = heldBootBridge();
    const { unmount } = render(<AppRouter pairing={b.bridge} />);
    unmount();
    expect(b.subscribers()).toBe(0);
  });
});

describe('createPairingPushRelay — deferred replay of a missed push (rev546c)', () => {
  const REVOKED: PairingStatusChangedEvent = { kind: 'invalid', reason: 'device_revoked' };
  const DECRYPT: PairingStatusChangedEvent = { kind: 'invalid', reason: 'decrypt_failed' };
  const flush = (): Promise<void> => Promise.resolve();

  it('replays to the handler that survives an attach / detach / re-attach, exactly once', async () => {
    const relay = createPairingPushRelay();
    relay.deliver(REVOKED);
    const first = vi.fn();
    const second = vi.fn();
    relay.attach(first)();
    relay.attach(second);
    await flush();
    expect(first).not.toHaveBeenCalled();
    expect(second.mock.calls).toEqual([[REVOKED]]);
    const third = vi.fn();
    relay.attach(third);
    await flush();
    expect(third).not.toHaveBeenCalled();
  });

  it('a live push delivered before the deferred replay supersedes the missed one', async () => {
    const relay = createPairingPushRelay();
    relay.deliver(DECRYPT);
    const handler = vi.fn();
    relay.attach(handler);
    relay.deliver(REVOKED);
    await flush();
    expect(handler.mock.calls).toEqual([[REVOKED]]);
  });
});
