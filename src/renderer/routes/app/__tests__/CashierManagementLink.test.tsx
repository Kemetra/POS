/**
 * RT-235 — the legacy manager dashboard's way into `/app/manager/cashiers`:
 * one link, shown only to a signed-in manager or admin. Without it the
 * Cashier Management surface (Set first PIN / Reset PIN / Unlock) has no entry
 * point in the packaged app, so no cashier could ever get a first PIN.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import {
  renderAt,
  resetShiftStores,
  signIn,
} from '../../../v5/__tests__/__helpers__/shift-test-kit';
import { CASHIER_MANAGEMENT_LINK_LABEL, CashierManagementLink } from '../CashierManagementLink';
import { DashboardRoute } from '../DashboardRoute';

afterEach(() => {
  cleanup();
  resetShiftStores();
});

function renderLink() {
  return renderAt({
    path: '/app/dashboard',
    pattern: '/app/dashboard',
    element: <CashierManagementLink />,
  });
}

describe('CashierManagementLink', () => {
  it.each(['manager', 'admin'] as const)(
    'is shown for a %s and points at /app/manager/cashiers',
    (role) => {
      signIn(role);
      renderLink();
      expect(screen.getByRole('link', { name: CASHIER_MANAGEMENT_LINK_LABEL })).toHaveAttribute(
        'href',
        '/app/manager/cashiers',
      );
    },
  );

  it('is hidden for a cashier', () => {
    signIn('cashier');
    expect(renderLink().container).toBeEmptyDOMElement();
  });

  it('is hidden while signed out', () => {
    expect(renderLink().container).toBeEmptyDOMElement();
  });

  it('navigates to /app/manager/cashiers', () => {
    signIn('manager');
    renderLink();
    fireEvent.click(screen.getByRole('link', { name: CASHIER_MANAGEMENT_LINK_LABEL }));
    expect(screen.getByTestId('where')).toHaveTextContent('/app/manager/cashiers');
  });
});

describe('the legacy dashboard route carries the cashier-management link', () => {
  function renderDashboard() {
    return renderAt({
      path: '/app/dashboard',
      pattern: '/app/dashboard',
      element: <DashboardRoute />,
    });
  }

  it.each(['manager', 'admin'] as const)('shows it to a %s', (role) => {
    signIn(role);
    renderDashboard();
    expect(screen.getByRole('link', { name: CASHIER_MANAGEMENT_LINK_LABEL })).toHaveAttribute(
      'href',
      '/app/manager/cashiers',
    );
  });

  it('shows a cashier no link', () => {
    signIn('cashier');
    renderDashboard();
    expect(
      screen.queryByRole('link', { name: CASHIER_MANAGEMENT_LINK_LABEL }),
    ).not.toBeInTheDocument();
  });
});
