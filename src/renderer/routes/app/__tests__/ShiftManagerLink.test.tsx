/**
 * RT-17 follow-up (comment 10958) — the legacy manager dashboard's way into
 * `/app/shift/manager`: one link, shown only with the shift flag on and a
 * manager or admin signed in.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { SHIFT_COPY } from '../../../v5/shift/shift-copy';
import {
  enableShiftFlag,
  renderAt,
  resetShiftStores,
  signIn,
} from '../../../v5/__tests__/__helpers__/shift-test-kit';
import { DashboardRoute } from '../DashboardRoute';
import { ShiftManagerLink } from '../ShiftManagerLink';

afterEach(() => {
  cleanup();
  resetShiftStores();
});

function renderLink() {
  return renderAt({
    path: '/app/dashboard',
    pattern: '/app/dashboard',
    element: <ShiftManagerLink />,
  });
}

describe('ShiftManagerLink', () => {
  it.each(['manager', 'admin'] as const)('is shown for a %s with the flag on', (role) => {
    signIn(role);
    enableShiftFlag();
    renderLink();
    const link = screen.getByRole('link', { name: SHIFT_COPY.managerLink });
    expect(link).toHaveAttribute('href', '/app/shift/manager');
  });

  it('is hidden for a cashier', () => {
    signIn('cashier');
    enableShiftFlag();
    expect(renderLink().container).toBeEmptyDOMElement();
  });

  it.each(['manager', 'admin'] as const)('is hidden for a %s with the flag off', (role) => {
    signIn(role);
    enableShiftFlag(false);
    expect(renderLink().container).toBeEmptyDOMElement();
  });

  it('is hidden while signed out', () => {
    enableShiftFlag();
    expect(renderLink().container).toBeEmptyDOMElement();
  });

  it('navigates to /app/shift/manager', () => {
    signIn('manager');
    enableShiftFlag();
    renderLink();
    fireEvent.click(screen.getByRole('link', { name: SHIFT_COPY.managerLink }));
    expect(screen.getByTestId('where')).toHaveTextContent('/app/shift/manager');
  });
});

describe('the legacy dashboard route carries the link', () => {
  function renderDashboard() {
    return renderAt({
      path: '/app/dashboard',
      pattern: '/app/dashboard',
      element: <DashboardRoute />,
    });
  }

  it.each(['manager', 'admin'] as const)('shows it to a %s with the flag on', (role) => {
    signIn(role);
    enableShiftFlag();
    renderDashboard();
    expect(screen.getByRole('link', { name: SHIFT_COPY.managerLink })).toHaveAttribute(
      'href',
      '/app/shift/manager',
    );
  });

  it('does not show it with the flag off', () => {
    signIn('manager');
    enableShiftFlag(false);
    renderDashboard();
    expect(screen.queryByRole('link', { name: SHIFT_COPY.managerLink })).not.toBeInTheDocument();
  });

  it('shows a cashier no link (the route refuses the role)', () => {
    signIn('cashier');
    enableShiftFlag();
    renderDashboard();
    expect(screen.queryByRole('link', { name: SHIFT_COPY.managerLink })).not.toBeInTheDocument();
  });
});
