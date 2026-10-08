import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { SignInRoute } from '../routes/sign-in.js';
import type { OperatorBridgeAPI, SignInResponse } from '../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../stores/operator-session-store.js';

/**
 * 004-operator-session T079 [S5] — Cashier-Forbidden Information walling.
 *
 * Constitution III + FR-006 / FR-031: The cashier-facing sign-in surface
 * MUST NOT render any of the following:
 *   - Shift totals (sales/transaction counts)
 *   - KPI figures (revenue, averages, targets)
 *   - Drawer cash amounts or float values
 *   - Operator IDs or session tokens
 *   - Manager/admin credentials or identifiers
 *   - Any currency amounts associated with sessions
 *
 * These tests render the full sign-in route with a populated roster and
 * assert that forbidden data is never present in the DOM, even after
 * cashier selection and PIN entry interactions.
 */

const CASHIERS = [
  { id: 'c1', display_name: 'Alice Smith', role: 'cashier' as const },
  { id: 'c2', display_name: 'Bob Jones', role: 'cashier' as const },
];

function makeBridge(overrides?: Partial<OperatorBridgeAPI>): OperatorBridgeAPI {
  return {
    signIn: vi.fn(() =>
      Promise.resolve({ kind: 'refused', category: 'invalid_input' } as SignInResponse),
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
    listBranchRoster: vi.fn(() => Promise.resolve({ kind: 'roster' as const, cashiers: CASHIERS })),
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
    ...overrides,
  };
}

// SignInRoute uses useNavigate() (the /sign-in → /app redirect on
// signedIn), which requires a Router ancestor. These walling tests stay
// signedOut so they never navigate; the router is only there to satisfy
// the hook's context requirement.
function renderSignIn(operator: OperatorBridgeAPI) {
  return render(
    <MemoryRouter>
      <SignInRoute operator={operator} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
});

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('Cashier-Forbidden Information walling (T079)', () => {
  it('sign-in route does not render shift totals or sales figures', async () => {
    renderSignIn(makeBridge());
    await screen.findByTestId('roster-list');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const body = document.body.textContent ?? '';
    // No currency symbols paired with numbers (shift totals, sales)
    expect(body).not.toMatch(/\$\s*\d+/);
    expect(body).not.toMatch(/£\s*\d+/);
    expect(body).not.toMatch(/€\s*\d+/);
  });

  it('sign-in route does not render KPI labels', async () => {
    renderSignIn(makeBridge());
    await screen.findByTestId('roster-list');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/total sales/i);
    expect(body).not.toMatch(/transactions/i);
    expect(body).not.toMatch(/average order/i);
    expect(body).not.toMatch(/revenue/i);
    expect(body).not.toMatch(/target/i);
  });

  it('sign-in route does not render drawer cash or float values', async () => {
    renderSignIn(makeBridge());
    await screen.findByTestId('roster-list');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/drawer/i);
    expect(body).not.toMatch(/float/i);
    expect(body).not.toMatch(/cash in/i);
    expect(body).not.toMatch(/opening balance/i);
  });

  it('sign-in route does not render operator IDs or session tokens', async () => {
    renderSignIn(makeBridge());
    await screen.findByTestId('roster-list');
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/operator_id/i);
    expect(html).not.toMatch(/session_id/i);
    expect(html).not.toMatch(/jwt/i);
    expect(html).not.toMatch(/token/i);
  });

  it('cashier PIN surface does not expose forbidden data after selection', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    renderSignIn(bridge);
    // Wait for roster to populate
    await screen.findByTestId('roster-item-0');
    await user.click(screen.getByTestId('roster-item-0'));
    // PIN pad should be shown
    await screen.findByTestId('pin-section');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/\$\s*\d+/);
    expect(body).not.toMatch(/total sales/i);
    expect(body).not.toMatch(/drawer/i);
    expect(body).not.toMatch(/operator_id/i);
  });

  it('cashier name is shown but no email, phone, or audit info is exposed', async () => {
    renderSignIn(makeBridge());
    await screen.findByTestId('roster-item-0');
    // Display name is allowed
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    const html = document.body.innerHTML;
    // Email/phone/audit patterns must not appear
    expect(html).not.toMatch(/[@]\w+\.\w+/); // email pattern
    expect(html).not.toMatch(/\+\d{1,3}[\s\-]\d+/); // phone pattern
    expect(html).not.toMatch(/audit/i);
    expect(html).not.toMatch(/last_sign_in/i);
    expect(html).not.toMatch(/signed_in_at/i);
  });
});
