import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import { CashierManagement } from '../manager/CashierManagement.js';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../../../stores/operator-session-store.js';
import { OperatorRouteGuard } from '../../operator-route-guard.js';

/**
 * T078 — cashier management surface at /app/manager/cashiers.
 *
 * Security invariants (PR-1):
 *   - No PIN value, PIN hash, or sealed material ever renders in the DOM.
 *   - Error surfaces are generic only (no cashier id, no credential detail).
 *   - Bridge calls carry only allowed arguments — no PIN on unlock.
 *
 * Role gate (AD-1 secondary):
 *   - cashier → redirect to /sign-in.
 *   - manager / admin → content renders.
 *   - signedOut → redirect to /sign-in.
 */

const MANAGER_SESSION: OperatorSessionView = {
  id: 'sess-mgr',
  operator_id: 'op-mgr',
  display_name: 'Manager One',
  role: 'manager',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-11T00:00:00.000Z',
};

const CASHIER_SESSION: OperatorSessionView = {
  ...MANAGER_SESSION,
  id: 'sess-cas',
  operator_id: 'op-cas',
  display_name: 'Cashier One',
  role: 'cashier',
};

const ADMIN_SESSION: OperatorSessionView = {
  ...MANAGER_SESSION,
  id: 'sess-adm',
  operator_id: 'op-adm',
  display_name: 'Admin One',
  role: 'admin',
};

type BridgeStub = {
  listBranchRoster: ReturnType<typeof vi.fn>;
  resetCashierPin: ReturnType<typeof vi.fn>;
  provisionCashierPin: ReturnType<typeof vi.fn>;
  unlockCashier: ReturnType<typeof vi.fn>;
};

function makeBridge(overrides: Partial<BridgeStub> = {}): BridgeStub {
  return {
    listBranchRoster: vi.fn().mockResolvedValue({
      kind: 'roster',
      cashiers: [
        { id: 'cash-1', display_name: 'Alice Cashier', role: 'cashier' },
        { id: 'cash-2', display_name: 'Bob Cashier', role: 'cashier' },
      ],
    }),
    resetCashierPin: vi.fn().mockResolvedValue({ kind: 'pin_reset', audit_event_id: 'evt-1' }),
    provisionCashierPin: vi
      .fn()
      .mockResolvedValue({ kind: 'pin_provisioned', audit_event_id: 'evt-3' }),
    unlockCashier: vi.fn().mockResolvedValue({ kind: 'unlocked', audit_event_id: 'evt-2' }),
    ...overrides,
  };
}

function renderAt(session: OperatorSessionView | null, bridge: BridgeStub) {
  if (session) {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(session);
  }

  const router = createMemoryRouter(
    [
      {
        path: '/app/manager/cashiers',
        element: (
          <OperatorRouteGuard allow={['manager', 'admin']}>
            <CashierManagement operator={bridge as never} />
          </OperatorRouteGuard>
        ),
      },
      { path: '/sign-in', element: <div data-testid="sign-in-page">sign-in</div> },
    ],
    { initialEntries: ['/app/manager/cashiers'] },
  );

  return render(<RouterProvider router={router} />);
}

/** Click the first button matching name and assert it exists. */
async function clickFirst(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  const btns = screen.getAllByRole('button', { name });
  expect(btns.length).toBeGreaterThan(0);
  await user.click(btns[0] as HTMLElement);
}

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
  vi.clearAllMocks();
});

describe('CashierManagement (T078)', () => {
  describe('role gate (AD-1 secondary — UX layer)', () => {
    it('redirects signedOut to /sign-in', () => {
      renderAt(null, makeBridge());
      expect(screen.getByTestId('sign-in-page')).toBeInTheDocument();
      expect(screen.queryByTestId('cashier-management')).not.toBeInTheDocument();
    });

    it('redirects cashier role to /sign-in', () => {
      renderAt(CASHIER_SESSION, makeBridge());
      expect(screen.getByTestId('sign-in-page')).toBeInTheDocument();
      expect(screen.queryByTestId('cashier-management')).not.toBeInTheDocument();
    });

    it('renders surface for manager role', async () => {
      renderAt(MANAGER_SESSION, makeBridge());
      await waitFor(() => expect(screen.getByTestId('cashier-management')).toBeInTheDocument());
    });

    it('renders surface for admin role', async () => {
      renderAt(ADMIN_SESSION, makeBridge());
      await waitFor(() => expect(screen.getByTestId('cashier-management')).toBeInTheDocument());
    });
  });

  describe('touch-target floor (DESIGN.md 44px — primitive-bypass audit P1)', () => {
    it('row action buttons carry the .btn--md class (44px floor via primitive styling)', async () => {
      renderAt(MANAGER_SESSION, makeBridge());
      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      // Reset PIN + Unlock for two cashiers = 4 row buttons; each must use the
      // shared button class so it inherits the 44px floor (was bare <button>).
      for (const name of [/set first pin/i, /reset pin/i, /unlock/i]) {
        for (const btn of screen.getAllByRole('button', { name })) {
          expect(btn).toHaveClass('btn');
          expect(btn).toHaveClass('btn--md');
        }
      }
    });
  });

  describe('roster display', () => {
    it('calls listBranchRoster on mount', async () => {
      const bridge = makeBridge();
      renderAt(MANAGER_SESSION, bridge);
      await waitFor(() => {
        expect(bridge.listBranchRoster).toHaveBeenCalledOnce();
      });
    });

    it('renders cashier display names from roster', async () => {
      renderAt(MANAGER_SESSION, makeBridge());
      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
        expect(screen.getByText('Bob Cashier')).toBeInTheDocument();
      });
    });

    it('never renders cashier id in DOM (PR-1 minimum disclosure)', async () => {
      renderAt(MANAGER_SESSION, makeBridge());
      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      const html = document.body.innerHTML;
      expect(html).not.toContain('cash-1');
      expect(html).not.toContain('cash-2');
    });

    it('shows generic error message on roster refusal (no category detail in DOM)', async () => {
      const bridge = makeBridge({
        listBranchRoster: vi.fn().mockResolvedValue({
          kind: 'refused',
          category: 'role_mismatch',
        }),
      });
      renderAt(MANAGER_SESSION, bridge);
      await waitFor(() =>
        expect(screen.getByTestId('cashier-management-error')).toBeInTheDocument(),
      );
      expect(document.body.innerHTML).not.toContain('role_mismatch');
    });
  });

  describe('Reset PIN action (T072 bridge)', () => {
    it('calls resetCashierPin with event_id, target_cashier_id, new_pin', async () => {
      const user = userEvent.setup();
      const bridge = makeBridge();
      renderAt(MANAGER_SESSION, bridge);

      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });

      await clickFirst(user, /reset pin/i);

      const pinInput = await screen.findByLabelText(/new pin/i);
      await user.type(pinInput, '1234');
      await user.click(screen.getByRole('button', { name: /confirm reset/i }));

      await waitFor(() => {
        expect(bridge.resetCashierPin).toHaveBeenCalledOnce();
      });

      const calls = bridge.resetCashierPin.mock.calls as Array<Array<Record<string, unknown>>>;
      expect(calls.length).toBeGreaterThan(0);
      const call = calls[0]?.[0] ?? {};
      expect(typeof call['event_id']).toBe('string');
      expect((call['event_id'] as string).length).toBeGreaterThan(0);
      expect(call['target_cashier_id']).toBe('cash-1');
      expect(call['new_pin']).toBe('1234');
    });

    it('PIN value never appears in DOM at any point', async () => {
      const user = userEvent.setup();
      renderAt(MANAGER_SESSION, makeBridge());

      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      await clickFirst(user, /reset pin/i);

      const pinInput = await screen.findByLabelText(/new pin/i);
      await user.type(pinInput, '5678');

      expect(pinInput).toHaveAttribute('type', 'password');
    });

    it('shows generic success message on pin_reset (no cashier id in DOM)', async () => {
      const user = userEvent.setup();
      renderAt(MANAGER_SESSION, makeBridge());

      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      await clickFirst(user, /reset pin/i);
      const pinInput = await screen.findByLabelText(/new pin/i);
      await user.type(pinInput, '4321');
      await user.click(screen.getByRole('button', { name: /confirm reset/i }));

      await waitFor(() => expect(screen.getByTestId('action-success')).toBeInTheDocument());
      expect(document.body.innerHTML).not.toContain('cash-1');
    });

    it('shows generic error message on refused (no category in DOM)', async () => {
      const user = userEvent.setup();
      const bridge = makeBridge({
        resetCashierPin: vi.fn().mockResolvedValue({ kind: 'refused', category: 'invalid_input' }),
      });
      renderAt(MANAGER_SESSION, bridge);

      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      await clickFirst(user, /reset pin/i);
      const pinInput = await screen.findByLabelText(/new pin/i);
      await user.type(pinInput, '0000');
      await user.click(screen.getByRole('button', { name: /confirm reset/i }));

      await waitFor(() => expect(screen.getByTestId('action-error')).toBeInTheDocument());
      expect(document.body.innerHTML).not.toContain('invalid_input');
    });
  });

  describe('Set first PIN action (RT-235 — 019 provisionCashierPin bridge)', () => {
    async function openSetFirstPin(
      user: ReturnType<typeof userEvent.setup>,
      bridge: BridgeStub,
    ): Promise<HTMLElement> {
      renderAt(MANAGER_SESSION, bridge);
      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      await clickFirst(user, /set first pin/i);
      return screen.findByLabelText(/initial pin/i);
    }

    it('offers a Set first PIN button for every rostered cashier', async () => {
      renderAt(MANAGER_SESSION, makeBridge());
      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      expect(screen.getAllByRole('button', { name: /set first pin/i })).toHaveLength(2);
    });

    it('calls provisionCashierPin with event_id, the roster id as target_cashier_id and initial_pin only', async () => {
      const user = userEvent.setup();
      const bridge = makeBridge();
      const pinInput = await openSetFirstPin(user, bridge);
      await user.type(pinInput, '4729');
      await user.click(screen.getByRole('button', { name: /save pin/i }));

      await waitFor(() => {
        expect(bridge.provisionCashierPin).toHaveBeenCalledOnce();
      });
      const call =
        (bridge.provisionCashierPin.mock.calls as Array<Array<Record<string, unknown>>>)[0]?.[0] ??
        {};
      expect(typeof call['event_id']).toBe('string');
      expect((call['event_id'] as string).length).toBeGreaterThan(0);
      expect(call['target_cashier_id']).toBe('cash-1');
      expect(call['initial_pin']).toBe('4729');
      expect(Object.keys(call).sort()).toEqual(['event_id', 'initial_pin', 'target_cashier_id']);
    });

    it('collects the PIN in a password field and never renders it, then closes the dialog on success', async () => {
      const user = userEvent.setup();
      const pinInput = await openSetFirstPin(user, makeBridge());
      expect(pinInput).toHaveAttribute('type', 'password');
      await user.type(pinInput, '4729');
      await user.click(screen.getByRole('button', { name: /save pin/i }));

      await waitFor(() =>
        expect(screen.getByTestId('action-success')).toHaveTextContent(/first pin set/i),
      );
      expect(screen.queryByRole('dialog', { name: /set first pin/i })).not.toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain('4729');
      expect(document.body.innerHTML).not.toContain('cash-1');
    });

    it('state_invalid → tells the manager the cashier already has a PIN and to use Reset PIN (no category in DOM)', async () => {
      const user = userEvent.setup();
      const bridge = makeBridge({
        provisionCashierPin: vi
          .fn()
          .mockResolvedValue({ kind: 'refused', category: 'state_invalid' }),
      });
      const pinInput = await openSetFirstPin(user, bridge);
      await user.type(pinInput, '4729');
      await user.click(screen.getByRole('button', { name: /save pin/i }));

      const msg = await screen.findByTestId('action-error');
      expect(msg).toHaveTextContent(/already has a pin/i);
      expect(msg).toHaveTextContent(/reset pin/i);
      expect(document.body.innerHTML).not.toContain('state_invalid');
    });

    it('not_ready → truthful "cannot be activated yet" state, not a generic failure (no category in DOM)', async () => {
      const user = userEvent.setup();
      const bridge = makeBridge({
        provisionCashierPin: vi.fn().mockResolvedValue({ kind: 'refused', category: 'not_ready' }),
      });
      const pinInput = await openSetFirstPin(user, bridge);
      await user.type(pinInput, '4729');
      await user.click(screen.getByRole('button', { name: /save pin/i }));

      const msg = await screen.findByTestId('action-error');
      expect(msg).toHaveTextContent(/can.?t be activated yet/i);
      expect(document.body.innerHTML).not.toContain('not_ready');
    });

    it('any other refusal → generic error (no category in DOM)', async () => {
      const user = userEvent.setup();
      const bridge = makeBridge({
        provisionCashierPin: vi
          .fn()
          .mockResolvedValue({ kind: 'refused', category: 'no_connection' }),
      });
      const pinInput = await openSetFirstPin(user, bridge);
      await user.type(pinInput, '4729');
      await user.click(screen.getByRole('button', { name: /save pin/i }));

      const msg = await screen.findByTestId('action-error');
      expect(msg).toHaveTextContent(/could not be completed/i);
      expect(document.body.innerHTML).not.toContain('no_connection');
    });

    it('RT-235 review: a second Save while the first call is in flight is ignored (one request, success not overwritten)', async () => {
      const user = userEvent.setup();
      let settle: (value: unknown) => void = () => undefined;
      const bridge = makeBridge({
        provisionCashierPin: vi.fn(
          () =>
            new Promise((resolve) => {
              settle = resolve;
            }),
        ),
      });
      const pinInput = await openSetFirstPin(user, bridge);
      await user.type(pinInput, '4729');
      const save = screen.getByRole('button', { name: /save pin/i });

      await user.click(save);
      await user.click(save);

      expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);
      expect(save).toBeDisabled();

      settle({ kind: 'pin_provisioned', audit_event_id: 'evt-3' });
      await waitFor(() =>
        expect(screen.getByTestId('action-success')).toHaveTextContent(/first pin set/i),
      );
      expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);
    });

    it('Escape and Cancel close the dialog without calling the bridge', async () => {
      const user = userEvent.setup();
      const bridge = makeBridge();
      await openSetFirstPin(user, bridge);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: /set first pin/i })).not.toBeInTheDocument();

      await clickFirst(user, /set first pin/i);
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.queryByRole('dialog', { name: /set first pin/i })).not.toBeInTheDocument();
      expect(bridge.provisionCashierPin).not.toHaveBeenCalled();
    });
  });

  describe('Unlock action (T073 bridge)', () => {
    it('calls unlockCashier with event_id and target_cashier_id only (no PIN field)', async () => {
      const user = userEvent.setup();
      const bridge = makeBridge();
      renderAt(MANAGER_SESSION, bridge);

      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      await clickFirst(user, /unlock/i);

      await waitFor(() => {
        expect(bridge.unlockCashier).toHaveBeenCalledOnce();
      });
      const calls = bridge.unlockCashier.mock.calls as Array<Array<Record<string, unknown>>>;
      expect(calls.length).toBeGreaterThan(0);
      const call = calls[0]?.[0] ?? {};
      expect(typeof call['event_id']).toBe('string');
      expect(call['target_cashier_id']).toBe('cash-1');
      expect('new_pin' in call).toBe(false);
      expect('pin' in call).toBe(false);
    });

    it('shows generic success message on unlocked', async () => {
      const user = userEvent.setup();
      renderAt(MANAGER_SESSION, makeBridge());

      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      await clickFirst(user, /unlock/i);

      await waitFor(() => expect(screen.getByTestId('action-success')).toBeInTheDocument());
    });

    it('state_invalid refusal treated as success (already unlocked, no-op)', async () => {
      const user = userEvent.setup();
      const bridge = makeBridge({
        unlockCashier: vi.fn().mockResolvedValue({ kind: 'refused', category: 'state_invalid' }),
      });
      renderAt(MANAGER_SESSION, bridge);

      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      await clickFirst(user, /unlock/i);

      await waitFor(() => expect(screen.getByTestId('action-success')).toBeInTheDocument());
    });

    it('generic error message on other refusal (no category in DOM)', async () => {
      const user = userEvent.setup();
      const bridge = makeBridge({
        unlockCashier: vi.fn().mockResolvedValue({ kind: 'refused', category: 'role_mismatch' }),
      });
      renderAt(MANAGER_SESSION, bridge);

      await waitFor(() => {
        expect(screen.getByText('Alice Cashier')).toBeInTheDocument();
      });
      await clickFirst(user, /unlock/i);

      await waitFor(() => expect(screen.getByTestId('action-error')).toBeInTheDocument());
      expect(document.body.innerHTML).not.toContain('role_mismatch');
    });
  });
});
