/**
 * RT-499 (VN-S10 S10-2, G-6) — the manager home, `/app/dashboard`: one card per
 * manager screen, the cashier refusal, the recovery-mode redirect, and no figure
 * anywhere (there is no metrics contract).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { RECOVERY_PATH } from '../../../../routes/app/RecoveryLink';
import { DashboardRoute } from '../../../../routes/app/DashboardRoute';
import { expectNoAxeViolations } from '../../../../ui/primitives/__tests__/axe-config';
import {
  fakeBridges,
  heldView,
  type FakeBridges,
} from '../../../recovery/__tests__/__helpers__/recovery-fixtures';
import {
  enableShiftFlag,
  renderAt,
  resetShiftStores,
  signIn,
} from '../../../__tests__/__helpers__/shift-test-kit';
import { HOME_COPY } from '../home-copy';

afterEach(() => {
  cleanup();
  resetShiftStores();
  delete (window as unknown as { api?: unknown }).api;
});

function exposeBridges(bridges: FakeBridges): void {
  (window as unknown as { api: unknown }).api = {
    recovery: bridges.recovery,
    approval: bridges.approval,
  };
}

function renderHome() {
  return renderAt({
    path: '/app/dashboard',
    pattern: '/app/dashboard',
    element: <DashboardRoute />,
  });
}

function tileNames(): string[] {
  return within(screen.getByRole('list'))
    .getAllByRole('link')
    .map((a) => a.textContent);
}

describe('the manager home', () => {
  it.each(['manager', 'admin'] as const)(
    'shows a %s the four cards in G-6 order when the shift flag is on',
    (role) => {
      signIn(role);
      enableShiftFlag();
      renderHome();
      expect(screen.getByRole('heading', { level: 1, name: HOME_COPY.title })).toBeInTheDocument();
      const links = within(screen.getByRole('list')).getAllByRole('link');
      expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
        ['/app/shift/manager', `${HOME_COPY.shift.title}${HOME_COPY.shift.description}`],
        ['/app/manager/cashiers', `${HOME_COPY.cashiers.title}${HOME_COPY.cashiers.description}`],
        ['/app/manager/recovery', `${HOME_COPY.recovery.title}${HOME_COPY.recovery.description}`],
        [
          '/app/manager/stuck-shifts',
          `${HOME_COPY.stuckShifts.title}${HOME_COPY.stuckShifts.description}`,
        ],
      ]);
    },
  );

  it('names each card by its title and describes it by its one line', () => {
    signIn('manager');
    enableShiftFlag();
    renderHome();
    for (const tile of [
      HOME_COPY.shift,
      HOME_COPY.cashiers,
      HOME_COPY.recovery,
      HOME_COPY.stuckShifts,
    ]) {
      expect(screen.getByRole('link', { name: tile.title })).toHaveAccessibleDescription(
        tile.description,
      );
    }
  });

  it('leaves out «حالة الوردية» when the shift flag is off, and keeps the other three', () => {
    signIn('manager');
    enableShiftFlag(false);
    renderHome();
    expect(screen.queryByRole('link', { name: HOME_COPY.shift.title })).not.toBeInTheDocument();
    expect(tileNames()).toHaveLength(3);
    expect(screen.getByRole('link', { name: HOME_COPY.stuckShifts.title })).toBeInTheDocument();
  });

  it('links «الورديات العالقة» to the stuck-shifts screen', () => {
    signIn('admin');
    renderHome();
    fireEvent.click(screen.getByRole('link', { name: HOME_COPY.stuckShifts.title }));
    expect(screen.getByTestId('where')).toHaveTextContent('/app/manager/stuck-shifts');
  });

  it('renders no figure: no digit in any script', () => {
    signIn('manager');
    enableShiftFlag();
    renderHome();
    expect(screen.getByTestId('v5-screen-section').textContent).not.toMatch(/[0-9\u0660-\u0669]/);
  });

  it('touches no fetch, localStorage or sessionStorage on mount', () => {
    signIn('manager');
    enableShiftFlag();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const local = vi.spyOn(window, 'localStorage', 'get');
    const session = vi.spyOn(window, 'sessionStorage', 'get');
    renderHome();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('has no axe violations', async () => {
    signIn('manager');
    enableShiftFlag();
    const { container } = renderHome();
    await expectNoAxeViolations(container);
  });

  it('keeps the recovery-mode redirect: a manager in recovery mode goes straight to recovery', async () => {
    signIn('manager');
    exposeBridges(fakeBridges(heldView({ recovery_mode: true })));
    renderHome();
    await waitFor(() => {
      expect(screen.getByTestId('where')).toHaveTextContent(RECOVERY_PATH);
    });
  });

  it('stays on the home when the session is not in recovery mode', async () => {
    signIn('manager');
    const bridges = fakeBridges();
    exposeBridges(bridges);
    renderHome();
    await waitFor(() => {
      expect(bridges.recovery.listHeld).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();
  });

  it('sends a signed-out visitor to sign-in and renders no card', () => {
    renderHome();
    expect(screen.getByTestId('where')).toHaveTextContent('/sign-in');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('the cashier on a direct visit', () => {
  function renderAsCashier() {
    signIn('cashier');
    enableShiftFlag();
    const bridges = fakeBridges(heldView({ recovery_mode: true }));
    exposeBridges(bridges);
    return { ...renderHome(), bridges };
  }

  it('sees the Arabic refusal under the same title, and no card', () => {
    renderAsCashier();
    expect(screen.getByRole('heading', { level: 1, name: HOME_COPY.title })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(HOME_COPY.cashierRefusal);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('Section unavailable')).not.toBeInTheDocument();
  });

  it('goes back to the Sale from «العودة إلى البيع»', () => {
    renderAsCashier();
    fireEvent.click(screen.getByRole('button', { name: HOME_COPY.backToSale }));
    expect(screen.getByTestId('where')).toHaveTextContent('/app/cart');
  });

  it('never reads recovery state and is never redirected to it', () => {
    const { bridges } = renderAsCashier();
    expect(bridges.recovery.listHeld).not.toHaveBeenCalled();
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderAsCashier();
    await expectNoAxeViolations(container);
  });
});
