import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../../../src/renderer/router.js';
import type { OperatorBridgeAPI, PairingBridgeAPI } from '../../../src/shared/bridge-api.js';
import type { PairingStatus } from '../../../src/shared/pairing-types.js';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../../../src/renderer/stores/operator-session-store.js';

/**
 * 004-operator-session T088 — SC-003 cashier route enumeration.
 *
 * Exercises ≥ 20 access paths as a signed-in cashier and verifies that:
 *
 *   - /app/manager/stuck-shifts (T092) redirects cashier to /sign-in via the
 *     nested OperatorRouteGuard allow={['manager','admin']} (role-visibility-matrix
 *     §Section 3 — ⛔ cashier).
 *   - /app/manager/cashiers redirects cashier to /sign-in for the same reason.
 *   - Multiple access patterns per protected route (direct deep-link, query
 *     strings) all resolve to /sign-in.
 *   - Accessible shell routes (/app/sales, /app/cart, /app/checkout,
 *     /app/inventory, /app/settings, /app/dashboard) do NOT trigger the inner
 *     guard and remain reachable by a signed-in cashier.
 *   - The cashier session in the store is preserved after the guard fires
 *     (the guard is a UX-only redirect, not a session termination — AD-1).
 *
 * Access-path enumeration (≥ 20):
 *   Paths 1–6   /app/manager/stuck-shifts — 6 access paths
 *   Paths 7–12  /app/manager/cashiers     — 6 access paths
 *   Paths 13–17 Accessible shell routes   — 5 positive paths
 *   Paths 18–22 Guard invariants          — 5 invariant checks
 */

// ── Fixtures ──────────────────────────────────────────────────────────────

const CASHIER_SESSION: OperatorSessionView = {
  id: 'sess-t088',
  operator_id: 'cashier-t088',
  display_name: 'Charlie Cashier',
  role: 'cashier',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-14T09:00:00.000Z',
};

function pairedBridge(): PairingBridgeAPI {
  const status: PairingStatus = {
    kind: 'paired',
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term-t088',
    terminal_label: 'Counter T088',
    paired_at: 1_735_689_600,
  };
  return {
    getStatus: vi.fn(() => Promise.resolve(status)),
    submit: vi.fn(() => Promise.reject(new Error('not used'))),
  };
}

function makeOperatorBridge(overrides?: Partial<OperatorBridgeAPI>): OperatorBridgeAPI {
  return {
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
    listBranchRoster: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    confirmTakeover: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    cancelTakeover: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
    resetCashierPin: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'role_mismatch' as const }),
    ),
    provisionCashierPin: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    unlockCashier: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'role_mismatch' as const }),
    ),
    forceCloseShift: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'role_mismatch' as const }),
    ),
    listStuckShifts: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'role_mismatch' as const }),
    ),
    dismissShiftClosedNotice: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const MANAGER_SESSION: OperatorSessionView = {
  id: 'sess-t088-mgr',
  operator_id: 'manager-t088',
  display_name: 'Morgan Manager',
  role: 'manager',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-14T09:00:00.000Z',
};

/** Pre-populate the store as a signed-in cashier (simulates a session in progress). */
function signInAsCashier(): void {
  useOperatorSessionStore.getState().beginSignIn();
  useOperatorSessionStore.getState().resolveSignedIn(CASHIER_SESSION);
}

/** Pre-populate the store as a signed-in operator with the given session. */
function signInAs(session: OperatorSessionView): void {
  useOperatorSessionStore.getState().beginSignIn();
  useOperatorSessionStore.getState().resolveSignedIn(session);
}

/**
 * Render AppRouter with a cashier pre-signed-in and an initial path, then
 * wait until the boot loading spinner is gone.
 */
async function renderAsCashier(initialEntry: string): Promise<void> {
  signInAsCashier();
  render(
    <AppRouter
      pairing={pairedBridge()}
      operator={makeOperatorBridge()}
      initialEntry={initialEntry}
    />,
  );
  // Wait for the async boot to complete (pairing.getStatus resolves).
  await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
}

/**
 * Render AppRouter with the given operator session pre-signed-in and an initial
 * path, then wait until the boot loading spinner is gone.
 */
async function renderAsSession(session: OperatorSessionView, initialEntry: string): Promise<void> {
  signInAs(session);
  render(
    <AppRouter
      pairing={pairedBridge()}
      operator={makeOperatorBridge()}
      initialEntry={initialEntry}
    />,
  );
  await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
});

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

// ── Paths 1–6  /app/manager/stuck-shifts ──────────────────────────────────

describe('SC-003 path 1 — /app/manager/stuck-shifts direct deep-link', () => {
  it('redirects cashier to /sign-in', async () => {
    await renderAsCashier('/app/manager/stuck-shifts');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
  });
});

describe('SC-003 path 2 — /app/manager/stuck-shifts window.location', () => {
  it('window.location.pathname is /sign-in after redirect', async () => {
    await renderAsCashier('/app/manager/stuck-shifts');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/sign-in');
    });
  });
});

describe('SC-003 path 3 — /app/manager/stuck-shifts?source=nav', () => {
  it('query string variant also redirects cashier to /sign-in', async () => {
    await renderAsCashier('/app/manager/stuck-shifts?source=nav');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
  });
});

describe('SC-003 path 4 — /app/manager/stuck-shifts?modal=force-close', () => {
  it('query string variant also redirects cashier to /sign-in', async () => {
    await renderAsCashier('/app/manager/stuck-shifts?modal=force-close');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
  });
});

describe('SC-003 path 5 — /app/manager/stuck-shifts?shift=abc123', () => {
  it('shift-id query param cannot bypass the guard', async () => {
    await renderAsCashier('/app/manager/stuck-shifts?shift=abc123');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
  });
});

describe('SC-003 path 6 — /app/manager/stuck-shifts app-shell absent', () => {
  it('app-shell is not in the DOM after guard redirect', async () => {
    await renderAsCashier('/app/manager/stuck-shifts');
    // The guard redirect mounts route-sign-in and unmounts app-shell on
    // separate commits; poll until BOTH have settled so we never observe the
    // transient window where they co-exist (D-001 root cause).
    await waitFor(() => {
      expect(screen.getByTestId('route-sign-in')).toBeInTheDocument();
      expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    });
  });
});

// ── Paths 7–12  /app/manager/cashiers ─────────────────────────────────────

describe('SC-003 path 7 — /app/manager/cashiers direct deep-link', () => {
  it('redirects cashier to /sign-in', async () => {
    await renderAsCashier('/app/manager/cashiers');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
  });
});

describe('SC-003 path 8 — /app/manager/cashiers window.location', () => {
  it('window.location.pathname is /sign-in after redirect', async () => {
    await renderAsCashier('/app/manager/cashiers');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/sign-in');
    });
  });
});

describe('SC-003 path 9 — /app/manager/cashiers?cashier=user1', () => {
  it('query string variant also redirects cashier to /sign-in', async () => {
    await renderAsCashier('/app/manager/cashiers?cashier=user1');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
  });
});

describe('SC-003 path 10 — /app/manager/cashiers?action=reset', () => {
  it('action=reset query string cannot bypass the guard', async () => {
    await renderAsCashier('/app/manager/cashiers?action=reset');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
  });
});

describe('SC-003 path 11 — /app/manager/cashiers?action=unlock', () => {
  it('action=unlock query string cannot bypass the guard', async () => {
    await renderAsCashier('/app/manager/cashiers?action=unlock');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
  });
});

describe('SC-003 path 12 — /app/manager/cashiers app-shell absent', () => {
  it('app-shell is not in the DOM after guard redirect', async () => {
    await renderAsCashier('/app/manager/cashiers');
    // Poll until both states settle (see path 6) — avoids the transient
    // co-existence window during the async guard redirect (D-001).
    await waitFor(() => {
      expect(screen.getByTestId('route-sign-in')).toBeInTheDocument();
      expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    });
  });
});

// ── Paths 13–17  Accessible shell routes (positive) ───────────────────────

describe('SC-003 path 13 — /app/sales (✅ cashier)', () => {
  it('cashier reaches /app/sales without redirect', async () => {
    await renderAsCashier('/app/sales');
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
    });
  });
});

describe('SC-003 path 14 — /app/cart (✅ cashier)', () => {
  it('cashier reaches /app/cart without redirect', async () => {
    await renderAsCashier('/app/cart');
    await waitFor(() => {
      // 023 Slice G: the sale loop renders in the v5 frame, not AppShell.
      expect(screen.getByTestId('v5-frame')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
    });
  });
});

describe('SC-003 path 15 — /app/checkout (✅ cashier)', () => {
  it('cashier reaches /app/checkout without redirect', async () => {
    await renderAsCashier('/app/checkout');
    await waitFor(() => {
      // 023 Slice G: the sale loop renders in the v5 frame, not AppShell.
      expect(screen.getByTestId('v5-frame')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
    });
  });
});

describe('SC-003 path 16 — /app/inventory (✅ cashier)', () => {
  it('cashier reaches /app/inventory without redirect', async () => {
    await renderAsCashier('/app/inventory');
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
    });
  });
});

describe('SC-003 path 17 — /app/settings (🔒 cashier)', () => {
  it('cashier reaches /app/settings without route-guard redirect', async () => {
    await renderAsCashier('/app/settings');
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
    });
  });
});

// ── Paths 18–22  Guard invariants ─────────────────────────────────────────

describe('SC-003 path 18 — cashier session preserved after stuck-shifts redirect', () => {
  it('store state remains signedIn with cashier role after guard redirect', async () => {
    await renderAsCashier('/app/manager/stuck-shifts');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
    const state = useOperatorSessionStore.getState().state;
    expect(state.kind).toBe('signedIn');
    if (state.kind === 'signedIn') {
      expect(state.session.role).toBe('cashier');
    }
  });
});

describe('SC-003 path 19 — /app/dashboard (⛔ cashier — shows unavailable surface)', () => {
  it('cashier reaches /app/dashboard without route-guard redirect; sees unavailable surface', async () => {
    await renderAsCashier('/app/dashboard');
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
      // DashboardRoute itself renders an ErrorState for cashier role (not a route-guard redirect).
      expect(screen.getByText(/this section is not available for your role/i)).toBeInTheDocument();
    });
  });
});

describe('SC-003 path 20 — cashier session preserved after cashiers redirect', () => {
  it('store state remains signedIn with cashier role after /app/manager/cashiers redirect', async () => {
    await renderAsCashier('/app/manager/cashiers');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
    const state = useOperatorSessionStore.getState().state;
    expect(state.kind).toBe('signedIn');
    if (state.kind === 'signedIn') {
      expect(state.session.role).toBe('cashier');
    }
  });
});

describe('SC-003 path 21 — /app index route (cashier)', () => {
  it('cashier reaches /app without route-guard redirect (outer guard only)', async () => {
    await renderAsCashier('/app');
    // /app has { index: true, element: <Navigate to="dashboard"> } so it redirects to
    // /app/dashboard which renders the "Section unavailable" surface for cashier.
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
    });
  });
});

describe('SC-003 path 22 — stuck-shift-surface not in DOM after guard redirect', () => {
  it('no stuck-shift content is rendered when cashier hits /app/manager/stuck-shifts', async () => {
    await renderAsCashier('/app/manager/stuck-shifts');
    await waitFor(() => {
      expect(screen.getByTestId('route-sign-in')).toBeInTheDocument();
      // The ForcedCloseSurface / StuckShiftSurface must not render for cashier.
      expect(screen.queryByTestId('stuck-shifts-surface')).not.toBeInTheDocument();
      expect(screen.queryByTestId('forced-close-surface')).not.toBeInTheDocument();
    });
  });
});

// ── PR #434 FIX 1 — /app/returns + /app/audit are manager/admin only ──────
//
// CodeRabbit (PR #434): `returns` and `audit` previously sat directly under the
// parent `/app` guard with NO `allow` filter, so a signed-in CASHIER could reach
// `/app/audit` (role-visibility-matrix marks Audit ⛔ cashier) and `/app/returns`
// (Phase-7 blocked). OWNER DECISION: gate BOTH to manager/admin via the same
// nested `<OperatorRouteGuard allow={['manager','admin']}>` pattern used by the
// `/app/manager/*` surfaces. Cashier deep-link → /sign-in; manager/admin reach
// the existing placeholder.

describe('SC-003 path 23 — /app/returns direct deep-link (⛔ cashier)', () => {
  it('redirects cashier to /sign-in', async () => {
    await renderAsCashier('/app/returns');
    // Poll until both states settle (mirrors path 6/12) — avoids the transient
    // co-existence window during the async guard redirect (D-001).
    await waitFor(() => {
      expect(screen.getByTestId('route-sign-in')).toBeInTheDocument();
      expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    });
  });
});

describe('SC-003 path 24 — /app/returns window.location (⛔ cashier)', () => {
  it('window.location.pathname is /sign-in after redirect', async () => {
    await renderAsCashier('/app/returns');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/sign-in');
    });
  });
});

describe('SC-003 path 25 — /app/audit direct deep-link (⛔ cashier)', () => {
  it('redirects cashier to /sign-in', async () => {
    await renderAsCashier('/app/audit');
    await waitFor(() => {
      expect(screen.getByTestId('route-sign-in')).toBeInTheDocument();
      expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    });
  });
});

describe('SC-003 path 26 — /app/audit window.location (⛔ cashier)', () => {
  it('window.location.pathname is /sign-in after redirect', async () => {
    await renderAsCashier('/app/audit');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/sign-in');
    });
  });
});

describe('SC-003 path 27 — /app/returns?ref=sale123 query string (⛔ cashier)', () => {
  it('query string variant cannot bypass the guard', async () => {
    await renderAsCashier('/app/returns?ref=sale123');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
  });
});

describe('SC-003 path 28 — /app/audit?from=nav query string (⛔ cashier)', () => {
  it('query string variant cannot bypass the guard', async () => {
    await renderAsCashier('/app/audit?from=nav');
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
  });
});

// ── PR #434 FIX 1 (positive) — manager + admin CAN reach returns + audit ───

describe('SC-003 path 29 — /app/returns (✅ manager)', () => {
  it('manager reaches /app/returns without redirect; placeholder shown', async () => {
    await renderAsSession(MANAGER_SESSION, '/app/returns');
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
      expect(screen.getByText(/Returns are not yet available/i)).toBeInTheDocument();
    });
  });
});

describe('SC-003 path 30 — /app/audit (✅ manager)', () => {
  it('manager reaches /app/audit without redirect; placeholder shown', async () => {
    await renderAsSession(MANAGER_SESSION, '/app/audit');
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
      expect(screen.getByText(/audit log view is not yet available/i)).toBeInTheDocument();
    });
  });
});

describe('SC-003 path 31 — /app/returns (✅ admin)', () => {
  it('admin reaches /app/returns without redirect; placeholder shown', async () => {
    await renderAsSession({ ...MANAGER_SESSION, id: 'sess-admin', role: 'admin' }, '/app/returns');
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
      expect(screen.getByText(/Returns are not yet available/i)).toBeInTheDocument();
    });
  });
});

describe('SC-003 path 32 — /app/audit (✅ admin)', () => {
  it('admin reaches /app/audit without redirect; placeholder shown', async () => {
    await renderAsSession({ ...MANAGER_SESSION, id: 'sess-admin', role: 'admin' }, '/app/audit');
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
      expect(screen.getByText(/audit log view is not yet available/i)).toBeInTheDocument();
    });
  });
});
