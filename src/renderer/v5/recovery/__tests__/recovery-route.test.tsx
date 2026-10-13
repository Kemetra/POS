/**
 * RT-441 — the `/app/manager/recovery` route element and the dashboard link:
 * nothing for a cashier, the screen for a manager, and a session admitted in
 * recovery mode is sent straight to the screen.
 */
import type { JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import type { Role } from '../../../../shared/operator/role';
import { RECOVERY_PATH, RecoveryLink } from '../../../routes/app/RecoveryLink';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { RecoveryRoute } from '../RecoveryRoute';
import { RECOVERY_COPY } from '../recovery-copy';
import { fakeBridges, heldView, type FakeBridges } from './__helpers__/recovery-fixtures';

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

function Where(): JSX.Element {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function at(path: string, element: JSX.Element) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {element}
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function signIn(role: Role): void {
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: `session-${role}`,
    operator_id: `op-${role}`,
    display_name: 'منى',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-13T08:00:00Z',
  });
}

function exposeBridges(bridges: FakeBridges): void {
  (window as unknown as { api: unknown }).api = {
    recovery: bridges.recovery,
    approval: bridges.approval,
  };
}

describe('RecoveryRoute', () => {
  it('goes back to the dashboard when this build has no recovery bridge', async () => {
    at(RECOVERY_PATH, <RecoveryRoute bridges={null} />);
    await waitFor(() => {
      expect(screen.getByTestId('where')).toHaveTextContent('/app/dashboard');
    });
  });

  it('reads window.api by default', async () => {
    exposeBridges(fakeBridges());
    at(RECOVERY_PATH, <RecoveryRoute />);
    expect(await screen.findByText(RECOVERY_COPY.noneStuck)).toBeInTheDocument();
  });

  it('renders the screen over the given bridges', async () => {
    at(RECOVERY_PATH, <RecoveryRoute bridges={fakeBridges()} />);
    expect(await screen.findByText(RECOVERY_COPY.noneHeld)).toBeInTheDocument();
  });
});

describe('RecoveryLink', () => {
  it.each<Role>(['cashier'])('shows nothing and reads nothing for a %s', (role) => {
    signIn(role);
    const bridges = fakeBridges(heldView({ recovery_mode: true }));
    exposeBridges(bridges);
    at('/app/dashboard', <RecoveryLink />);
    expect(screen.queryByTestId('dashboard-recovery-link')).not.toBeInTheDocument();
    expect(bridges.recovery.listHeld).not.toHaveBeenCalled();
  });

  it('shows nothing while signed out', () => {
    at('/app/dashboard', <RecoveryLink />);
    expect(screen.queryByTestId('dashboard-recovery-link')).not.toBeInTheDocument();
  });

  it.each<Role>(['manager', 'admin'])('links a %s to the recovery screen', async (role) => {
    signIn(role);
    const bridges = fakeBridges();
    exposeBridges(bridges);
    at('/app/dashboard', <RecoveryLink />);
    expect(screen.getByRole('link', { name: RECOVERY_COPY.link })).toHaveAttribute(
      'href',
      RECOVERY_PATH,
    );
    await waitFor(() => {
      expect(bridges.recovery.listHeld).toHaveBeenCalled();
    });
    expect(screen.getByTestId('where')).toHaveTextContent('/app/dashboard');
  });

  it('sends a session in recovery mode straight to the recovery screen', async () => {
    signIn('manager');
    exposeBridges(fakeBridges(heldView({ recovery_mode: true })));
    at('/app/dashboard', <RecoveryLink />);
    await waitFor(() => {
      expect(screen.getByTestId('where')).toHaveTextContent(RECOVERY_PATH);
    });
  });

  it('stays put when the read is refused or fails, or there is no bridge', async () => {
    signIn('manager');
    at('/app/dashboard', <RecoveryLink />);
    expect(screen.getByTestId('dashboard-recovery-link')).toBeInTheDocument();
    cleanup();
    const refused = fakeBridges();
    refused.recovery.listHeld.mockResolvedValue({ kind: 'refused', reason: 'no_session' });
    exposeBridges(refused);
    at('/app/dashboard', <RecoveryLink />);
    await waitFor(() => {
      expect(refused.recovery.listHeld).toHaveBeenCalled();
    });
    cleanup();
    const failed = fakeBridges();
    failed.recovery.listHeld.mockRejectedValue(new Error('ipc down'));
    exposeBridges(failed);
    at('/app/dashboard', <RecoveryLink />);
    await waitFor(() => {
      expect(failed.recovery.listHeld).toHaveBeenCalled();
    });
    expect(screen.getByTestId('where')).toHaveTextContent('/app/dashboard');
  });
});
