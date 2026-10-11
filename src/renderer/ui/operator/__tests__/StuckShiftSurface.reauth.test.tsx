import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { StuckShiftSurface } from '../ForcedCloseSurface.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { REAUTH_COPY, SIGN_IN_REFUSAL_COPY } from '../messages.js';

/**
 * RT-358 (RT-247 plan §2.5) — the stuck-shifts list after the manager's
 * sign-in expired: the Arabic notice with only «تسجيل الدخول» (no Retry, no
 * English); a successful re-auth reloads the list; a second
 * `reauth_required` right after a re-auth never prompts again.
 */

const SHIFT = {
  shift_id: 'shift-1',
  cashier_display_name: 'Nour',
  terminal_label: 'T1',
  opened_at: '2026-10-11T08:00:00.000Z',
  duration_minutes: 30,
};
const REAUTH_REQUIRED = { kind: 'refused', category: 'reauth_required' } as const;

function makeBridge(answers: unknown[]) {
  const queue = [...answers];
  return {
    listStuckShifts: vi.fn(() =>
      Promise.resolve(queue.shift() ?? { kind: 'stuck_shifts', shifts: [SHIFT] }),
    ),
    forceCloseShift: vi.fn(),
    reauthenticate: vi.fn(() => Promise.resolve({ kind: 'reauthenticated' })),
  };
}

function renderSurface(bridge: ReturnType<typeof makeBridge>) {
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
  return render(<StuckShiftSurface operator={bridge as never} />);
}

async function reauthenticate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: REAUTH_COPY.action }));
  await user.type(screen.getByTestId('reauth-identifier'), 'mgr@example.test');
  await user.type(screen.getByTestId('reauth-password'), 'pw');
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: REAUTH_COPY.submit }),
  );
}

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('RT-358 StuckShiftSurface — re-auth required', () => {
  it('shows the Arabic notice with only «تسجيل الدخول»; no Retry, no English', async () => {
    renderSurface(makeBridge([REAUTH_REQUIRED]));

    const notice = await screen.findByTestId('reauth-required');
    expect(notice).toHaveTextContent(SIGN_IN_REFUSAL_COPY.reauth_required);
    expect(screen.queryByTestId('stuck-shift-surface-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Unable to load|try again|reauth_required/i);
  });

  it('a successful re-auth reloads the list', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge([REAUTH_REQUIRED, { kind: 'stuck_shifts', shifts: [SHIFT] }]);
    renderSurface(bridge);
    await reauthenticate(user);

    expect(await screen.findByTestId('stuck-shift-card-shift-1')).toBeInTheDocument();
    expect(bridge.listStuckShifts).toHaveBeenCalledTimes(2);
  });

  it('a second reauth_required right after a re-auth: Arabic copy, no Retry, no new prompt', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge([REAUTH_REQUIRED, REAUTH_REQUIRED]);
    renderSurface(bridge);
    await reauthenticate(user);

    await waitFor(() => {
      expect(bridge.listStuckShifts).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByTestId('stuck-shift-surface-reauth-failed')).toHaveTextContent(
      SIGN_IN_REFUSAL_COPY.not_signed_in,
    );
    expect(screen.queryByTestId('reauth-required')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Unable to load|try again/i);
  });

  it('cancelling the dialog leaves the notice in place', async () => {
    const user = userEvent.setup();
    renderSurface(makeBridge([REAUTH_REQUIRED]));
    await user.click(await screen.findByRole('button', { name: REAUTH_COPY.action }));
    await user.click(screen.getByRole('button', { name: REAUTH_COPY.cancel }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('reauth-required')).toBeInTheDocument();
  });
});
