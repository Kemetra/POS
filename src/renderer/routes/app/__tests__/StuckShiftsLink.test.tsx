/**
 * RT-499 (D-10-2) — the manager home's way into `/app/manager/stuck-shifts`:
 * one tile, shown only to a signed-in manager or admin.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import {
  renderAt,
  resetShiftStores,
  signIn,
} from '../../../v5/__tests__/__helpers__/shift-test-kit';
import { STUCK_SHIFTS_PATH, StuckShiftsLink } from '../StuckShiftsLink';

afterEach(() => {
  cleanup();
  resetShiftStores();
});

function renderLink() {
  return renderAt({
    path: '/app/dashboard',
    pattern: '/app/dashboard',
    element: <StuckShiftsLink />,
  });
}

describe('StuckShiftsLink', () => {
  it.each(['manager', 'admin'] as const)(
    'is shown for a %s and points at the stuck-shifts route',
    (role) => {
      signIn(role);
      renderLink();
      expect(screen.getByTestId('dashboard-stuck-shifts-link')).toHaveAttribute(
        'href',
        STUCK_SHIFTS_PATH,
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

  it('navigates to the stuck-shifts route', () => {
    signIn('manager');
    renderLink();
    fireEvent.click(screen.getByTestId('dashboard-stuck-shifts-link'));
    expect(screen.getByTestId('where')).toHaveTextContent(STUCK_SHIFTS_PATH);
  });
});
