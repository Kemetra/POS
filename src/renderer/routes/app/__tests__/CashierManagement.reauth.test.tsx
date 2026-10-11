import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { CashierManagement } from '../manager/CashierManagement.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { REAUTH_COPY, SIGN_IN_REFUSAL_COPY } from '../../../ui/operator/messages.js';

/**
 * RT-358 (RT-247 plan §2.5) — «Set first PIN» after the manager's sign-in
 * expired:
 *   • `reauth_required` shows the Arabic notice with only «تسجيل الدخول» —
 *     no «حاول مرة أخرى», no English, never the raw category;
 *   • the re-auth dialog opens on the same surface; on success the SAME PIN is
 *     submitted again exactly once; on cancel the PIN is cleared;
 *   • a second `reauth_required` right after a re-auth never prompts again.
 */

const CASHIER = { id: 'cash-1', display_name: 'Alice Cashier', role: 'cashier' as const };
const REAUTH_REQUIRED = { kind: 'refused', category: 'reauth_required' } as const;

function signInManager(): void {
  useOperatorSessionStore.getState().beginSignIn();
  useOperatorSessionStore.getState().resolveSignedIn({
    id: 's1',
    operator_id: 'op-1',
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    started_at: '2026-10-11T08:00:00.000Z',
  });
}

function makeBridge(
  provisionAnswers: unknown[],
  reauthAnswer: unknown = { kind: 'reauthenticated' },
) {
  const queue = [...provisionAnswers];
  return {
    listBranchRoster: vi.fn().mockResolvedValue({ kind: 'roster', cashiers: [CASHIER] }),
    resetCashierPin: vi.fn(),
    unlockCashier: vi.fn(),
    provisionCashierPin: vi.fn(() =>
      Promise.resolve(queue.shift() ?? { kind: 'pin_provisioned', audit_event_id: 'e' }),
    ),
    reauthenticate: vi.fn(() => Promise.resolve(reauthAnswer)),
  };
}

async function submitFirstPin(user: ReturnType<typeof userEvent.setup>, pin = '4729') {
  await user.click(await screen.findByRole('button', { name: 'Set first PIN' }));
  await user.type(screen.getByLabelText('Initial PIN'), pin);
  await user.click(screen.getByRole('button', { name: 'Save PIN' }));
}

async function reauthenticate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: REAUTH_COPY.action }));
  await user.type(screen.getByTestId('reauth-identifier'), 'mgr@example.test');
  await user.type(screen.getByTestId('reauth-password'), 'pw');
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: REAUTH_COPY.submit }),
  );
}

function renderSurface(bridge: ReturnType<typeof makeBridge>) {
  signInManager();
  return render(
    <MemoryRouter>
      <CashierManagement operator={bridge as never} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('RT-358 CashierManagement — re-auth required on «Set first PIN»', () => {
  it('shows the Arabic notice with only «تسجيل الدخول»; no retry, no English, no category', async () => {
    const user = userEvent.setup();
    renderSurface(makeBridge([REAUTH_REQUIRED]));
    await submitFirstPin(user);

    const notice = await screen.findByTestId('reauth-required');
    expect(notice).toHaveTextContent(SIGN_IN_REFUSAL_COPY.reauth_required);
    expect(screen.queryByTestId('action-error')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /Action could not be completed|try again|حاول مرة أخرى|reauth_required/i,
    );
    expect(screen.getAllByRole('button', { name: REAUTH_COPY.action })).toHaveLength(1);
  });

  it('success re-submits the same PIN exactly once and shows success', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge([REAUTH_REQUIRED, { kind: 'pin_provisioned', audit_event_id: 'e2' }]);
    renderSurface(bridge);
    await submitFirstPin(user, '4729');
    await screen.findByTestId('reauth-required');
    await reauthenticate(user);

    expect(await screen.findByTestId('action-success')).toBeInTheDocument();
    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(2);
    const calls = bridge.provisionCashierPin.mock.calls as unknown as [
      { target_cashier_id: string; initial_pin: string },
    ][];
    expect(calls[1]?.[0]).toMatchObject({ target_cashier_id: 'cash-1', initial_pin: '4729' });
    expect(screen.queryByRole('dialog', { name: REAUTH_COPY.title })).not.toBeInTheDocument();
  });

  it('cancel clears the PIN: nothing is re-submitted and the surface returns to idle', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge([REAUTH_REQUIRED]);
    renderSurface(bridge);
    await submitFirstPin(user);
    await user.click(await screen.findByRole('button', { name: REAUTH_COPY.action }));
    await user.click(screen.getByRole('button', { name: REAUTH_COPY.cancel }));

    expect(screen.queryByTestId('reauth-required')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Initial PIN')).not.toBeInTheDocument();
    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Set first PIN' }));
    expect(screen.getByLabelText('Initial PIN')).toHaveValue('');
  });

  it('a second reauth_required right after a re-auth does not prompt again', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge([REAUTH_REQUIRED, REAUTH_REQUIRED]);
    renderSurface(bridge);
    await submitFirstPin(user);
    await screen.findByTestId('reauth-required');
    await reauthenticate(user);

    await waitFor(() => {
      expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByTestId('action-error')).toHaveTextContent(
      SIGN_IN_REFUSAL_COPY.not_signed_in,
    );
    expect(screen.queryByTestId('reauth-required')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Action could not be completed|try again/i);
  });

  // A refusal on the retry right after a re-auth uses the Arabic sign-in copy:
  // never the English generic error, and never "already has a PIN" for a
  // state_invalid that may come from a lock or latch before the retry ran.
  it.each([
    ['state_invalid', /already has a PIN|Action could not be completed/],
    ['no_connection', /Action could not be completed/],
  ] as const)(
    'a %s right after a re-auth uses the Arabic sign-in copy',
    async (category, absent) => {
      const user = userEvent.setup();
      renderSurface(makeBridge([REAUTH_REQUIRED, { kind: 'refused', category }]));
      await submitFirstPin(user);
      await screen.findByTestId('reauth-required');
      await reauthenticate(user);

      expect(await screen.findByTestId('action-error')).toHaveTextContent(
        SIGN_IN_REFUSAL_COPY[category],
      );
      expect(document.body.textContent).not.toMatch(absent);
    },
  );

  it('while the PIN retry is in flight, no «تسجيل الدخول» action is offered (one prompt only)', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge([REAUTH_REQUIRED]);
    let release: (v: object) => void = () => undefined;
    bridge.provisionCashierPin
      .mockImplementationOnce(() => Promise.resolve(REAUTH_REQUIRED))
      .mockImplementationOnce(
        () =>
          new Promise<object>((resolve) => {
            release = resolve;
          }),
      );
    renderSurface(bridge);
    await submitFirstPin(user);
    await screen.findByTestId('reauth-required');
    await reauthenticate(user);

    await waitFor(() => {
      expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId('reauth-required')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: REAUTH_COPY.action })).not.toBeInTheDocument();

    release({ kind: 'pin_provisioned', audit_event_id: 'e2' });
    expect(await screen.findByTestId('action-success')).toBeInTheDocument();
    expect(bridge.reauthenticate).toHaveBeenCalledTimes(1);
  });

  it('a refused re-auth keeps the dialog open and does not re-submit', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge([REAUTH_REQUIRED], { kind: 'refused', category: 'invalid_input' });
    renderSurface(bridge);
    await submitFirstPin(user);
    await screen.findByTestId('reauth-required');
    await reauthenticate(user);

    expect(await screen.findByTestId('reauth-refusal')).toHaveTextContent(
      SIGN_IN_REFUSAL_COPY.invalid_input,
    );
    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);
  });
});
