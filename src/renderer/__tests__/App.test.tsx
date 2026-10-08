import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import App from '../App';
import type { PreloadBridgeAPI } from '../../shared/bridge-api';
import type { PairingStatus } from '../../shared/pairing-types';

/**
 * 002-terminal-pairing T016 — App root smoke.
 *
 * The Phase 2 renderToString test no longer fits because App now reads
 * `window.api` and uses hooks (boot-time getStatus). We mount the
 * component via testing-library with a stubbed bridge and assert the
 * router lands on /pairing for the unpaired branch — proving the
 * window.api → AppRouter wiring is intact.
 */

afterEach(() => {
  cleanup();
  // Clear our window.api stub between tests.
  delete (window as unknown as { api?: PreloadBridgeAPI }).api;
});

function stubBridge(status: PairingStatus): PreloadBridgeAPI {
  return {
    ping: vi.fn(() => Promise.resolve('pong' as const)),
    appVersion: vi.fn(() => Promise.resolve('0.0.0-test')),
    log: vi.fn(() => Promise.resolve()),
    appConfig: vi.fn(() => Promise.resolve({})),
    pairing: {
      getStatus: vi.fn(() => Promise.resolve(status)),
      submit: vi.fn(() => Promise.reject(new Error('submit not used in US1'))),
    },
    operator: {
      signIn: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
      ),
      signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
      getCurrentSession: vi.fn(() => Promise.resolve(null)),
      _reportActivity: vi.fn(),
      emitAuditEvent: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
      ),
      _emitAuditEventSmoke: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
      ),
      listBranchRoster: vi.fn(() => Promise.resolve({ kind: 'roster' as const, cashiers: [] })),
      confirmTakeover: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
      ),
      cancelTakeover: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
      resetCashierPin: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
      ),
      provisionCashierPin: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
      ),
      unlockCashier: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
      ),
      forceCloseShift: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
      ),
      listStuckShifts: vi.fn(() => Promise.resolve({ kind: 'stuck_shifts' as const, shifts: [] })),
      dismissShiftClosedNotice: vi.fn(() => Promise.resolve()),
      unlockSession: vi.fn(() => Promise.resolve({ kind: 'unlocked' as const })),
      getLockState: vi.fn(() =>
        Promise.resolve({
          state: 'active' as const,
          locked_at: null,
          role: null,
          display_name: null,
          summary: null,
        }),
      ),
      onSessionStateChanged: vi.fn(() => () => undefined),
    },
    cart: {
      create: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, reason: 'not_implemented' as const }),
      ),
      lines: {
        add: vi.fn(() =>
          Promise.resolve({ kind: 'refused' as const, reason: 'not_implemented' as const }),
        ),
        update: vi.fn(() =>
          Promise.resolve({ kind: 'refused' as const, reason: 'not_implemented' as const }),
        ),
        remove: vi.fn(() =>
          Promise.resolve({ kind: 'refused' as const, reason: 'not_implemented' as const }),
        ),
        setNote: vi.fn(() =>
          Promise.resolve({ kind: 'refused' as const, reason: 'not_implemented' as const }),
        ),
      },
      discountPlaceholders: {
        add: vi.fn(() =>
          Promise.resolve({ kind: 'refused' as const, reason: 'not_implemented' as const }),
        ),
        remove: vi.fn(() =>
          Promise.resolve({ kind: 'refused' as const, reason: 'not_implemented' as const }),
        ),
      },
      void: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, reason: 'not_implemented' as const }),
      ),
      handoff: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, reason: 'not_implemented' as const }),
      ),
      subscribe: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, reason: 'not_implemented' as const }),
      ),
    },
  };
}

describe('App', () => {
  it('mounts the router and lands on /pairing when bridge reports unpaired', async () => {
    (window as unknown as { api: PreloadBridgeAPI }).api = stubBridge({ kind: 'unpaired' });
    window.history.replaceState(null, '', '/');

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
  });

  it('mounts the router and lands on /paired when bridge reports paired', async () => {
    (window as unknown as { api: PreloadBridgeAPI }).api = stubBridge({
      kind: 'paired',
      tenant_id: 't',
      branch_id: 'b',
      terminal_id: 'term',
      terminal_label: 'Counter',
      paired_at: 1735689600,
    });
    window.history.replaceState(null, '', '/');

    render(<App />);

    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());
  });
});
