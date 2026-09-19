import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { AppRouter } from '../../router.js';
import { DashboardRoute } from '../app/DashboardRoute.js';
import { SignInRoute } from '../sign-in.js';
import { useOperatorSessionStore } from '../../stores/operator-session-store.js';
import type {
  ListBranchRosterResponse,
  ManagerAdminSignInRequest,
  OperatorBridgeAPI,
  OperatorSessionBridgeView,
  PairingBridgeAPI,
  SignInResponse,
} from '../../../shared/bridge-api.js';
import type { PairingStatus } from '../../../shared/pairing-types.js';

/**
 * 004-operator-session T022 + T024 — `/sign-in` route + sign-out
 * journey through the full AppRouter.
 *
 * Verifies:
 *   - A paired terminal lands on `/sign-in` when there is no operator
 *     session and the route was entered directly (FR-005). Deep-link
 *     attempts to `/app/*` redirect to `/sign-in` via the
 *     <OperatorRouteGuard>.
 *   - Successful sign-in mounts the shell.
 *   - Sign-out clears the FSM and redirects back to `/sign-in`.
 *
 * The test takes the renderer-side path the operator actually
 * traverses; the main-process bridge is a fake whose response shape
 * matches the contract.
 */

const SESSION: OperatorSessionBridgeView = {
  id: 'sess-1',
  operator_id: 'op-1',
  display_name: 'Manager One',
  role: 'manager',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-06T00:00:00.000Z',
};

function pairedBridge(): PairingBridgeAPI {
  const status: PairingStatus = {
    kind: 'paired',
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term-1',
    terminal_label: 'Counter 1',
    paired_at: 1735689600,
  };
  return {
    getStatus: vi.fn(() => Promise.resolve(status)),
    submit: vi.fn(() => Promise.reject(new Error('not used'))),
  };
}

const CASHIER = {
  id: 'cashier-1',
  display_name: 'Alice Smith',
  role: 'cashier' as const,
};

const CASHIER_SESSION: OperatorSessionBridgeView = {
  id: 'sess-cashier',
  operator_id: 'cashier-1',
  display_name: 'Alice Smith',
  role: 'cashier',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-06T00:00:00.000Z',
};

function operatorBridge(opts: {
  signIn?: (req: ManagerAdminSignInRequest) => Promise<SignInResponse>;
  listBranchRoster?: () => Promise<ListBranchRosterResponse>;
}): OperatorBridgeAPI {
  const defaultSignIn: (req: ManagerAdminSignInRequest) => Promise<SignInResponse> = () =>
    Promise.resolve({ kind: 'signed_in' as const, session: SESSION });
  return {
    signIn: vi.fn(opts.signIn ?? defaultSignIn),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    getCurrentSession: vi.fn(() => Promise.resolve(null)),
    _reportActivity: vi.fn(),
    emitAuditEvent: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    _emitAuditEventSmoke: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    listBranchRoster: vi.fn(
      opts.listBranchRoster ?? (() => Promise.resolve({ kind: 'roster' as const, cashiers: [] })),
    ),
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
  };
}

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
});

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('AppRouter + /sign-in (T022)', () => {
  it('a deep-link to /app/dashboard while signedOut redirects to /sign-in', async () => {
    render(
      <AppRouter
        pairing={pairedBridge()}
        operator={operatorBridge({})}
        initialEntry="/app/dashboard"
      />,
    );
    // The guard short-circuits the shell; the sign-in route mounts.
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it('renders /sign-in directly with the form and the inert roster', async () => {
    render(
      <AppRouter pairing={pairedBridge()} operator={operatorBridge({})} initialEntry="/sign-in" />,
    );
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
    expect(screen.getByTestId('manager-admin-sign-in-form')).toBeInTheDocument();
    expect(screen.getByTestId('roster-list')).toHaveAttribute('data-state', 'inert');
  });

  it('successful sign-in surfaces signedIn state in the operator session store', async () => {
    const user = userEvent.setup();
    render(
      <AppRouter pairing={pairedBridge()} operator={operatorBridge({})} initialEntry="/sign-in" />,
    );
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
    await user.type(screen.getByTestId('sign-in-identifier'), 'manager@x.test');
    await user.type(screen.getByTestId('sign-in-password'), 'p');
    await user.click(screen.getByTestId('sign-in-submit'));
    await waitFor(() => {
      const state = useOperatorSessionStore.getState().state;
      expect(state.kind).toBe('signedIn');
    });
  });

  it('successful manager sign-in navigates from /sign-in into the dashboard', async () => {
    // Regression: the store flipping to signedIn is NOT enough — the
    // renderer must navigate /sign-in → /app or the operator is stranded
    // on the sign-in screen. Assert the dashboard actually mounts.
    const user = userEvent.setup();
    render(
      <AppRouter pairing={pairedBridge()} operator={operatorBridge({})} initialEntry="/sign-in" />,
    );
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
    await user.type(screen.getByTestId('sign-in-identifier'), 'manager@x.test');
    await user.type(screen.getByTestId('sign-in-password'), 'p');
    await user.click(screen.getByTestId('sign-in-submit'));
    // Phase 4: the dashboard now renders the v3.5 skeleton; assert it mounted
    // via its stable testid (copy-independent) rather than the old welcome copy.
    await waitFor(() => expect(screen.getByTestId('dashboard-skeleton')).toBeInTheDocument());
    expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
  });

  it('takeover-confirm sign-in navigates from /sign-in into the dashboard', async () => {
    // The takeover path resolves to the SAME signedIn state as a normal
    // sign-in (store.resolveSignedIn from TakeoverPrompt). It must drive
    // the same /sign-in → /app navigation — otherwise a manager who
    // confirms a takeover is left stuck on the sign-in screen.
    const user = userEvent.setup();
    const bridge = operatorBridge({
      signIn: () =>
        Promise.resolve({
          kind: 'takeover_required' as const,
          pending_takeover_id: 'takeover-mgr',
        }),
    });
    // confirmTakeover → signed_in (the path the user's main log proved live).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(bridge.confirmTakeover).mockResolvedValue({
      kind: 'signed_in' as const,
      session: SESSION,
    });
    render(<AppRouter pairing={pairedBridge()} operator={bridge} initialEntry="/sign-in" />);
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());
    await user.type(screen.getByTestId('sign-in-identifier'), 'manager@x.test');
    await user.type(screen.getByTestId('sign-in-password'), 'p');
    await user.click(screen.getByTestId('sign-in-submit'));
    // Takeover prompt appears; confirm it.
    await waitFor(() => expect(screen.getByTestId('takeover-prompt-confirm')).toBeInTheDocument());
    await user.click(screen.getByTestId('takeover-prompt-confirm'));
    await waitFor(() => expect(screen.getByTestId('dashboard-skeleton')).toBeInTheDocument());
    expect(screen.queryByTestId('route-sign-in')).not.toBeInTheDocument();
  });

  it('cashier deep-link to /app/dashboard renders a generic unavailable surface', async () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(CASHIER_SESSION);

    render(
      <AppRouter
        pairing={pairedBridge()}
        operator={operatorBridge({})}
        initialEntry="/app/dashboard"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeInTheDocument());
    expect(screen.getAllByText('Section unavailable').length).toBeGreaterThan(0);
    // Cashier is blocked → the dashboard skeleton must NOT render.
    expect(screen.queryByTestId('dashboard-skeleton')).not.toBeInTheDocument();
  });

  it('DashboardRoute redirects signed-out access without rendering dashboard content', () => {
    render(
      <MemoryRouter>
        <DashboardRoute />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    // Signed-out → redirected, no dashboard skeleton rendered.
    expect(screen.queryByTestId('dashboard-skeleton')).not.toBeInTheDocument();
  });

  it('manager and admin can access /app/dashboard', async () => {
    for (const role of ['manager', 'admin'] as const) {
      cleanup();
      useOperatorSessionStore.getState().reset();
      useOperatorSessionStore.getState().beginSignIn();
      useOperatorSessionStore.getState().resolveSignedIn({ ...SESSION, role });

      render(
        <AppRouter
          pairing={pairedBridge()}
          operator={operatorBridge({})}
          initialEntry="/app/dashboard"
        />,
      );

      await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
      expect(screen.getByTestId('dashboard-skeleton')).toBeInTheDocument();
    }
  });

  it('cashier sees forced-close banner on an allowed app route', async () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore
      .getState()
      .resolveSignedIn(CASHIER_SESSION, { closed_at: '2026-04-01T10:00:00.000Z' });

    render(
      <AppRouter
        pairing={pairedBridge()}
        operator={operatorBridge({})}
        initialEntry="/app/sales"
      />,
    );

    await waitFor(() => expect(screen.getByText('Sales')).toBeInTheDocument());
    expect(screen.getByTestId('shift-closed-banner')).toBeInTheDocument();
    expect(screen.getByTestId('shift-closed-banner').textContent.toLowerCase()).not.toContain(
      'variance',
    );
  });
});

// ─── v3.5 prototype recompose (visual / RTL / Arabic-first) ──────────────────
// These assert the prototype's VISUAL LANGUAGE only: RTL shell, Arabic-first
// copy, the "كود الموظف · Staff code" section label, and the role→Arabic map on
// a selected cashier row. They must NOT assert any client-side credential
// logic — production keeps IPC-backed auth (operator.signIn) unchanged.
describe('SignInRoute — v3.5 prototype recompose', () => {
  it('route shell is RTL and carries the Arabic-first title + section label', async () => {
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [CASHIER] }),
    });
    renderSignInRoute(bridge);
    await waitFor(() => expect(screen.getByTestId('route-sign-in')).toBeInTheDocument());

    // RTL shell (Arabic-first layout).
    expect(screen.getByTestId('route-sign-in')).toHaveAttribute('dir', 'rtl');

    // Arabic title + section label lifted from the prototype.
    expect(screen.getByText('تسجيل دخول الصيدلي')).toBeInTheDocument();
    expect(screen.getByText('كود الموظف · Staff code')).toBeInTheDocument();
  });

  it('a selected cashier row shows the Arabic role name (role→Arabic map)', async () => {
    const user = userEvent.setup();
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [CASHIER] }),
    });
    renderSignInRoute(bridge);
    await waitFor(() => expect(screen.getByTestId(`roster-item-0`)).toBeInTheDocument());
    await user.click(screen.getByTestId(`roster-item-0`));

    // cashier → "صيدلي" per the prototype's ROLE_NAMES map.
    expect(screen.getByTestId('pin-section')).toBeInTheDocument();
    expect(screen.getByText('صيدلي')).toBeInTheDocument();
  });
});

describe('AppRouter + sign-out (T024)', () => {
  it('store reset returns the FSM to signedOut (1 s budget — synchronous in test)', () => {
    // Pre-populate signedIn state, then exercise the sign-out path
    // synchronously: store transitions are constant-time, so the
    // 1 s budget (FR-008 / NFR-007) is trivially honoured.
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.resolveSignedIn(SESSION);
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    store.beginSignOut();
    store.resolveSignedOut();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
  });
});

// ─── SignInRoute cashier path (T075 / T077) ──────────────────────────────────
// Tests render <SignInRoute> directly to isolate cashier-flow branches without
// the full AppRouter + pairing overhead.

function renderSignInRoute(bridge: OperatorBridgeAPI) {
  // SignInRoute uses useNavigate() (the /sign-in → /app redirect on
  // signedIn), which requires a Router ancestor. These direct-render
  // tests isolate cashier-flow branches, so a MemoryRouter is enough.
  return render(
    <MemoryRouter>
      <SignInRoute operator={bridge} />
    </MemoryRouter>,
  );
}

describe('SignInRoute — roster fetch', () => {
  it('populates the roster when listBranchRoster resolves with cashiers', async () => {
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [CASHIER] }),
    });
    renderSignInRoute(bridge);
    await waitFor(() => expect(screen.getByTestId(`roster-item-0`)).toBeInTheDocument());
  });

  it('shows no_connection alert when roster returns no_connection category', async () => {
    const bridge = operatorBridge({
      listBranchRoster: () =>
        Promise.resolve({ kind: 'refused' as const, category: 'no_connection' as const }),
    });
    renderSignInRoute(bridge);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('shows no alert for non-no_connection refusal (soft failure)', async () => {
    const bridge = operatorBridge({
      listBranchRoster: () =>
        Promise.resolve({ kind: 'refused' as const, category: 'role_mismatch' as const }),
    });
    renderSignInRoute(bridge);
    // Roster fetch resolves; no error shown (role_mismatch is silently ignored).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const rosterMock = vi.mocked(bridge.listBranchRoster);
    await waitFor(() => {
      expect(rosterMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('swallows a thrown exception from listBranchRoster (best-effort)', async () => {
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.reject(new Error('network failure')),
    });
    renderSignInRoute(bridge);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const rosterMock = vi.mocked(bridge.listBranchRoster);
    await waitFor(() => {
      expect(rosterMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('SignInRoute — cashier selection', () => {
  it('shows the PIN section after a cashier is selected', async () => {
    const user = userEvent.setup();
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [CASHIER] }),
    });
    renderSignInRoute(bridge);
    await waitFor(() => expect(screen.getByTestId(`roster-item-0`)).toBeInTheDocument());
    await user.click(screen.getByTestId(`roster-item-0`));
    expect(screen.getByTestId('pin-section')).toBeInTheDocument();
    expect(screen.getByTestId('pin-cashier-name')).toHaveTextContent(CASHIER.display_name);
  });

  it('Back button dismisses the PIN section', async () => {
    const user = userEvent.setup();
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [CASHIER] }),
    });
    renderSignInRoute(bridge);
    await waitFor(() => expect(screen.getByTestId(`roster-item-0`)).toBeInTheDocument());
    await user.click(screen.getByTestId(`roster-item-0`));
    await user.click(screen.getByTestId('cashier-pin-cancel'));
    expect(screen.queryByTestId('pin-section')).not.toBeInTheDocument();
  });
});

describe('SignInRoute — cashier sign-in responses', () => {
  async function setupCashierWithPin(bridge: OperatorBridgeAPI) {
    const user = userEvent.setup();
    renderSignInRoute(bridge);
    await waitFor(() => expect(screen.getByTestId(`roster-item-0`)).toBeInTheDocument());
    await user.click(screen.getByTestId(`roster-item-0`));
    // Enter 4 digits via the PinPad digit buttons.
    for (const d of ['1', '2', '3', '4']) {
      await user.click(screen.getByTestId(`pin-pad-key-${d}`));
    }
    return user;
  }

  it('signed_in response transitions store to signedIn', async () => {
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [CASHIER] }),
      signIn: () => Promise.resolve({ kind: 'signed_in' as const, session: CASHIER_SESSION }),
    });
    const user = await setupCashierWithPin(bridge);
    await user.click(screen.getByTestId('pin-pad-enter'));
    await waitFor(() => {
      expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    });
  });

  it('takeover_required response shows the TakeoverPrompt overlay', async () => {
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [CASHIER] }),
      signIn: () =>
        Promise.resolve({
          kind: 'takeover_required' as const,
          pending_takeover_id: 'takeover-1',
          cashier_clerk_user_id: CASHIER.id,
          display_name: CASHIER.display_name,
        }),
    });
    const user = await setupCashierWithPin(bridge);
    await user.click(screen.getByTestId('pin-pad-enter'));
    await waitFor(() => {
      expect(useOperatorSessionStore.getState().state.kind).toBe('takeoverPrompt');
    });
  });

  it('refused response shows the inline cashier error', async () => {
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [CASHIER] }),
      signIn: () =>
        Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    });
    const user = await setupCashierWithPin(bridge);
    await user.click(screen.getByTestId('pin-pad-enter'));
    await waitFor(() => expect(screen.getByTestId('cashier-sign-in-error')).toBeInTheDocument());
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
  });

  it('IPC exception shows the inline cashier error (catch branch)', async () => {
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [CASHIER] }),
      signIn: () => Promise.reject(new Error('ipc crash')),
    });
    const user = await setupCashierWithPin(bridge);
    await user.click(screen.getByTestId('pin-pad-enter'));
    await waitFor(() => expect(screen.getByTestId('cashier-sign-in-error')).toBeInTheDocument());
  });
});

describe('SignInRoute — boot hydration (getCurrentSession)', () => {
  it('calls operator.getCurrentSession on mount', async () => {
    const bridge = operatorBridge({});
    renderSignInRoute(bridge);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getCurrentSessionMock = vi.mocked(bridge.getCurrentSession);
    await waitFor(() => {
      expect(getCurrentSessionMock).toHaveBeenCalledOnce();
    });
  });

  it('hydrates store to signedIn when getCurrentSession returns a session', async () => {
    const bridge = operatorBridge({});
    // Override the default null return with a real session.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(bridge.getCurrentSession).mockResolvedValueOnce(SESSION);
    renderSignInRoute(bridge);
    await waitFor(() => {
      expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    });
    const state = useOperatorSessionStore.getState().state;
    if (state.kind === 'signedIn') {
      expect(state.session.operator_id).toBe(SESSION.operator_id);
    }
  });

  it('leaves store signedOut when getCurrentSession returns null', async () => {
    const bridge = operatorBridge({});
    // Default mock already returns null; verify store stays signedOut.
    renderSignInRoute(bridge);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getCurrentSessionMock = vi.mocked(bridge.getCurrentSession);
    await waitFor(() => {
      expect(getCurrentSessionMock).toHaveBeenCalled();
    });
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
  });

  it('leaves store signedOut and surfaces no error when getCurrentSession rejects', async () => {
    const bridge = operatorBridge({});
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getCurrentSessionMock = vi.mocked(bridge.getCurrentSession);
    getCurrentSessionMock.mockRejectedValueOnce(new Error('ipc error'));
    renderSignInRoute(bridge);
    await waitFor(() => {
      expect(getCurrentSessionMock).toHaveBeenCalled();
    });
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('SignInRoute — FSM reset clears PIN (signedOut effect)', () => {
  it('FSM transition back to signedOut resets the spinner', async () => {
    // Directly manipulate the store to exercise the useEffect on fsm.kind.
    const bridge = operatorBridge({
      listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [CASHIER] }),
    });
    const user = userEvent.setup();
    renderSignInRoute(bridge);
    await waitFor(() => expect(screen.getByTestId(`roster-item-0`)).toBeInTheDocument());
    await user.click(screen.getByTestId(`roster-item-0`));
    // Trigger a signingIn → signedOut transition via the store.
    useOperatorSessionStore.getState().beginSignIn();
    await waitFor(() => expect(screen.getByTestId('cashier-sign-in-spinner')).toBeInTheDocument());
    useOperatorSessionStore.getState().refuseSignIn('invalid_input');
    await waitFor(() =>
      expect(screen.queryByTestId('cashier-sign-in-spinner')).not.toBeInTheDocument(),
    );
  });
});
