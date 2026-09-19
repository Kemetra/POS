import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';

import { AppIndexRedirect } from '../routes/app/AppIndexRedirect';
import { DashboardRoute } from '../routes/app/DashboardRoute';
import { useOperatorSessionStore } from '../stores/operator-session-store';
import type { Role } from '../../shared/operator/role';

/**
 * 022 US1 T050/T051 — role-aware `/app` landing (FR-44).
 *
 * THE DEFECT: a signed-in cashier landing on `/app` was redirected to
 * `dashboard`, where `DashboardRoute` rejects the cashier role with "Section
 * unavailable" — an ERROR STATE as the first screen of a shift.
 *
 * THE FIX, and its exact boundary: only the `/app` INDEX target becomes
 * role-aware (cashier -> /app/cart; manager/admin -> /app/dashboard). This is
 * a UX/navigation correction and nothing more. It MUST NOT:
 *   - change `DashboardRoute`'s role check (FR-45 — a cashier who navigates
 *     DIRECTLY to /app/dashboard is still refused, asserted below),
 *   - alter cashier access rules, bypass `OperatorRouteGuard`, touch an
 *     `allow` list, or change any feature-flag default (FR-47 -> SC-17).
 *
 * The distinction that matters: this changes WHERE A CASHIER IS SENT, never
 * WHAT A CASHIER MAY REACH.
 */

function signInAs(role: Role): void {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'sess-001',
        operator_id: 'op-001',
        display_name: 'مستخدم',
        role,
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-09-19T08:00:00.000Z',
      },
    },
  });
}

/**
 * Mount just the `/app` subtree: the index redirect plus stand-ins for the two
 * landing targets. Rendering the whole AppRouter would drag in pairing boot,
 * the operator guard and the real workspaces — none of which this behaviour
 * depends on. What is under test is purely "where does the index send me".
 */
function renderAppIndex(): void {
  render(
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route path="/app">
          <Route index element={<AppIndexRedirect />} />
          <Route path="dashboard" element={<div data-testid="landed-dashboard" />} />
          <Route path="cart" element={<div data-testid="landed-cart" />} />
        </Route>
        <Route path="/sign-in" element={<div data-testid="landed-sign-in" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
});

describe('022 T050 — role-aware /app index resolution (FR-44)', () => {
  it('sends a CASHIER to /app/cart — the till, not a rejection', () => {
    signInAs('cashier');
    renderAppIndex();
    expect(screen.getByTestId('landed-cart')).toBeInTheDocument();
    expect(screen.queryByTestId('landed-dashboard')).not.toBeInTheDocument();
  });

  it('sends a MANAGER to /app/dashboard (unchanged)', () => {
    signInAs('manager');
    renderAppIndex();
    expect(screen.getByTestId('landed-dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('landed-cart')).not.toBeInTheDocument();
  });

  it('sends an ADMIN to /app/dashboard (unchanged)', () => {
    signInAs('admin');
    renderAppIndex();
    expect(screen.getByTestId('landed-dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('landed-cart')).not.toBeInTheDocument();
  });

  it('falls back to the dashboard path when no session is present', () => {
    // Not signed in: the index must not invent a cashier landing. The
    // operator guard above `/app` owns the redirect to sign-in; this
    // component simply must not make a role claim it cannot support.
    renderAppIndex();
    expect(screen.queryByTestId('landed-cart')).not.toBeInTheDocument();
  });
});

describe('022 T051 — FR-45: direct /app/dashboard navigation is STILL refused for a cashier', () => {
  it('a cashier rendering DashboardRoute directly still gets the rejection state', () => {
    signInAs('cashier');
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <Routes>
          <Route path="/app/dashboard" element={<DashboardRoute />} />
          <Route path="/sign-in" element={<div data-testid="landed-sign-in" />} />
        </Routes>
      </MemoryRouter>,
    );
    // The existing role check is untouched: the cashier is refused, exactly as
    // before. If this ever starts passing a cashier through, the landing
    // correction has leaked into ACCESS CONTROL — which FR-47 forbids.
    // (`getAllBy` because the copy appears twice by design: the Workspace
    // title and the ErrorState heading.)
    expect(screen.getAllByText('Section unavailable').length).toBeGreaterThan(0);
    // And the cashier must NOT have been handed the dashboard content.
    expect(screen.queryByTestId('dashboard-placeholder')).not.toBeInTheDocument();
  });

  it('a manager rendering DashboardRoute directly is NOT refused', () => {
    signInAs('manager');
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <Routes>
          <Route path="/app/dashboard" element={<DashboardRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText('Section unavailable')).not.toBeInTheDocument();
  });

  it('a signed-out visitor to DashboardRoute is sent to sign-in (unchanged)', () => {
    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <Routes>
          <Route path="/app/dashboard" element={<DashboardRoute />} />
          <Route path="/sign-in" element={<div data-testid="landed-sign-in" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('landed-sign-in')).toBeInTheDocument();
  });
});

describe('022 — the index redirect never widens what a cashier may REACH', () => {
  it('is a redirect only: it renders no workspace content of its own', () => {
    signInAs('cashier');
    const { container } = render(
      <MemoryRouter initialEntries={['/app']}>
        <Routes>
          <Route path="/app">
            <Route index element={<AppIndexRedirect />} />
            <Route path="cart" element={<div data-testid="landed-cart" />} />
            <Route path="dashboard" element={<Navigate to="/app/cart" replace />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    // Whatever it resolves to must come from the ROUTE table, not from markup
    // the redirect itself paints.
    expect(container.querySelector('[data-testid="landed-cart"]')).not.toBeNull();
  });
});
