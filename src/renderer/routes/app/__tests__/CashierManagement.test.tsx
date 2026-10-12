import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import { CashierManagement } from '../manager/CashierManagement.js';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../../../stores/operator-session-store.js';
import { OperatorRouteGuard } from '../../operator-route-guard.js';
import { expectNoAxeViolations } from '../../../ui/primitives/__tests__/axe-config.js';
import {
  CASHIERS_COPY,
  PIN_STATE_LABEL,
  lockedUntilText,
} from '../../../v5/cashiers/cashiers-copy.js';
import type {
  CashierPinStatus,
  ListCashierPinStatusResponse,
  PairingBridgeAPI,
} from '../../../../shared/bridge-api.js';

/**
 * T078 → RT-424 (D-M1, doc 19 §3–§5) — the manager's Cashiers screen at
 * /app/manager/cashiers, rebuilt on the G-3 references.
 *
 *   - Role gate (AD-1 secondary): cashier / signed-out → /sign-in.
 *   - The list is `listCashierPinStatus`; each row shows a text badge and only
 *     the actions its state allows (hidden, not disabled — UX-05).
 *   - M5: two PIN fields, 4–6 digits, mismatch / wrong length refused in the
 *     renderer before any call.
 *   - Re-read on mount, after every action and on «إعادة المحاولة».
 *   - One pending guard for every call (RT-235 review).
 *   - PR-1: no PIN, roster id or refusal category ever reaches the DOM.
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

const LOCKED_UNTIL = '2026-10-12T14:35:00.000Z';
const AMAL: CashierPinStatus = { id: 'cash-1', display_name: 'أمل', pin: 'no_pin' };
const BASMA: CashierPinStatus = { id: 'cash-2', display_name: 'بسمة', pin: 'ready' };
const DALIA: CashierPinStatus = {
  id: 'cash-3',
  display_name: 'داليا',
  pin: 'locked',
  locked_until: LOCKED_UNTIL,
};

function listed(...cashiers: CashierPinStatus[]): ListCashierPinStatusResponse {
  return { kind: 'cashiers', cashiers };
}

type BridgeStub = {
  listCashierPinStatus: ReturnType<typeof vi.fn>;
  resetCashierPin: ReturnType<typeof vi.fn>;
  provisionCashierPin: ReturnType<typeof vi.fn>;
  unlockCashier: ReturnType<typeof vi.fn>;
};

function makeBridge(overrides: Partial<BridgeStub> = {}): BridgeStub {
  return {
    listCashierPinStatus: vi.fn().mockResolvedValue(listed(AMAL, BASMA, DALIA)),
    resetCashierPin: vi.fn().mockResolvedValue({ kind: 'pin_reset', audit_event_id: 'evt-1' }),
    provisionCashierPin: vi
      .fn()
      .mockResolvedValue({ kind: 'pin_provisioned', audit_event_id: 'evt-3' }),
    unlockCashier: vi.fn().mockResolvedValue({ kind: 'unlocked', audit_event_id: 'evt-2' }),
    ...overrides,
  };
}

function pairedAs(label: string): PairingBridgeAPI {
  return {
    getStatus: vi.fn().mockResolvedValue({
      kind: 'paired',
      tenant_id: 't1',
      branch_id: 'b1',
      terminal_id: 'term-1',
      terminal_label: label,
      paired_at: 0,
    }),
  } as unknown as PairingBridgeAPI;
}

function renderAt(
  session: OperatorSessionView | null,
  bridge: BridgeStub,
  pairing?: PairingBridgeAPI,
) {
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
            <CashierManagement
              operator={bridge as never}
              {...(pairing === undefined ? {} : { pairing })}
            />
          </OperatorRouteGuard>
        ),
      },
      { path: '/sign-in', element: <div data-testid="sign-in-page">sign-in</div> },
    ],
    { initialEntries: ['/app/manager/cashiers'] },
  );

  return render(<RouterProvider router={router} />);
}

/** Wait for the list and return the row of the named cashier. */
async function rowOf(name: string): Promise<HTMLElement> {
  const nameNode = await screen.findByText(name);
  const row = nameNode.closest('li');
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

function buttonNames(row: HTMLElement): string[] {
  return within(row)
    .queryAllByRole('button')
    .map((b) => b.textContent);
}

async function openDialog(
  user: ReturnType<typeof userEvent.setup>,
  cashier: string,
  action: string,
): Promise<HTMLElement> {
  await user.click(within(await rowOf(cashier)).getByRole('button', { name: action }));
  return screen.getByTestId('pin-dialog');
}

async function typePins(
  user: ReturnType<typeof userEvent.setup>,
  first: string,
  second: string,
): Promise<void> {
  await user.type(screen.getByLabelText(CASHIERS_COPY.newPinLabel), first);
  await user.type(screen.getByLabelText(CASHIERS_COPY.confirmPinLabel), second);
}

function deferred(): { promise: Promise<unknown>; settle: (v: unknown) => void } {
  let settle: (v: unknown) => void = () => undefined;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function rowButtons(): HTMLElement[] {
  return screen
    .getAllByTestId('cashier-row')
    .flatMap((row) => within(row).queryAllByRole('button'));
}

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
  vi.clearAllMocks();
});

describe('CashierManagement — role gate (AD-1 secondary, UX layer)', () => {
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

  it.each([
    ['manager', MANAGER_SESSION],
    ['admin', ADMIN_SESSION],
  ])('renders for %s', async (_role, session) => {
    renderAt(session, makeBridge());
    expect(await screen.findByTestId('cashier-management')).toBeInTheDocument();
  });
});

describe('CashierManagement — the list (RT-424 doc 19 §3)', () => {
  it('reads listCashierPinStatus once on mount, showing M-K0d until it lands', async () => {
    const pending = deferred();
    const bridge = makeBridge({ listCashierPinStatus: vi.fn(() => pending.promise) });
    renderAt(MANAGER_SESSION, bridge);
    expect(await screen.findByText(CASHIERS_COPY.loading)).toBeInTheDocument();
    expect(screen.queryByTestId('cashier-row')).not.toBeInTheDocument();

    pending.settle(listed(AMAL));
    expect(await screen.findByText('أمل')).toBeInTheDocument();
    expect(screen.queryByText(CASHIERS_COPY.loading)).not.toBeInTheDocument();
    expect(bridge.listCashierPinStatus).toHaveBeenCalledOnce();
    expect(bridge.listCashierPinStatus).toHaveBeenCalledWith();
  });

  it('shows the Arabic title, list heading and count', async () => {
    renderAt(MANAGER_SESSION, makeBridge());
    await rowOf('أمل');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(CASHIERS_COPY.title);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(CASHIERS_COPY.listHeading);
    expect(screen.getByText('3 كاشير')).toBeInTheDocument();
  });

  it('names the terminal in the subtitle when the pairing bridge gives a label', async () => {
    renderAt(MANAGER_SESSION, makeBridge(), pairedAs('POS-03'));
    await rowOf('أمل');
    const subtitle = await screen.findByText(CASHIERS_COPY.subtitle, { exact: false });
    expect(subtitle).toHaveTextContent('POS-03');
    expect(within(subtitle).getByText('POS-03').tagName).toBe('BDI');
  });

  it('state → action matrix: only the actions that fit each state are rendered', async () => {
    renderAt(MANAGER_SESSION, makeBridge());
    expect(buttonNames(await rowOf('أمل'))).toEqual([CASHIERS_COPY.setFirstPin]);
    expect(buttonNames(await rowOf('بسمة'))).toEqual([CASHIERS_COPY.changePin]);
    expect(buttonNames(await rowOf('داليا'))).toEqual([
      CASHIERS_COPY.unlock,
      CASHIERS_COPY.changePin,
    ]);
  });

  it('badges carry text (never colour alone); a lock shows its absolute end time', async () => {
    renderAt(MANAGER_SESSION, makeBridge());
    expect(within(await rowOf('أمل')).getByTestId('pin-status')).toHaveTextContent(
      PIN_STATE_LABEL.no_pin,
    );
    expect(within(await rowOf('بسمة')).getByTestId('pin-status')).toHaveTextContent(
      PIN_STATE_LABEL.ready,
    );
    const locked = within(await rowOf('داليا')).getByTestId('pin-status');
    expect(locked).toHaveTextContent(PIN_STATE_LABEL.locked);
    const time = within(locked).getByText(lockedUntilText(LOCKED_UNTIL));
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', LOCKED_UNTIL);
  });

  it('never renders a roster id (PR-1 minimum disclosure)', async () => {
    renderAt(MANAGER_SESSION, makeBridge());
    await rowOf('أمل');
    const html = document.body.innerHTML;
    for (const id of ['cash-1', 'cash-2', 'cash-3']) expect(html).not.toContain(id);
  });

  it('an empty roster is a fact, not a fault', async () => {
    renderAt(
      MANAGER_SESSION,
      makeBridge({ listCashierPinStatus: vi.fn().mockResolvedValue(listed()) }),
    );
    expect(await screen.findByText(CASHIERS_COPY.empty)).toBeInTheDocument();
    expect(screen.getByText('0 كاشير')).toBeInTheDocument();
    expect(screen.queryByTestId('cashier-management-error')).not.toBeInTheDocument();
  });

  it('M1: unreachable roster → M-K1 and «إعادة المحاولة», no rows, no category', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({
      listCashierPinStatus: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'refused', category: 'no_connection' })
        .mockResolvedValueOnce(listed(AMAL)),
    });
    renderAt(MANAGER_SESSION, bridge);
    const error = await screen.findByTestId('cashier-management-error');
    expect(error).toHaveTextContent(CASHIERS_COPY.rosterOffline);
    expect(screen.queryByTestId('cashier-row')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('no_connection');

    await user.click(within(error).getByRole('button', { name: CASHIERS_COPY.retry }));
    expect(await rowOf('أمل')).toBeInTheDocument();
    expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
  });

  it('M1: any other refusal → M-K1b (no connection hint), no category in the DOM', async () => {
    renderAt(
      MANAGER_SESSION,
      makeBridge({
        listCashierPinStatus: vi
          .fn()
          .mockResolvedValue({ kind: 'refused', category: 'role_mismatch' }),
      }),
    );
    const error = await screen.findByTestId('cashier-management-error');
    expect(error).toHaveTextContent(CASHIERS_COPY.rosterRefused);
    expect(error).not.toHaveTextContent(CASHIERS_COPY.rosterOffline);
    expect(document.body.innerHTML).not.toContain('role_mismatch');
  });

  it('a bridge without the read, or a throwing read, shows M-K1b rather than nothing', async () => {
    renderAt(
      MANAGER_SESSION,
      makeBridge({ listCashierPinStatus: vi.fn().mockRejectedValue(new Error('boom')) }),
    );
    expect(await screen.findByTestId('cashier-management-error')).toHaveTextContent(
      CASHIERS_COPY.rosterRefused,
    );
  });

  it('has no axe violations with rows of every state', async () => {
    const { container } = renderAt(MANAGER_SESSION, makeBridge(), pairedAs('POS-03'));
    await rowOf('داليا');
    await expectNoAxeViolations(container);
  });
});

describe('CashierManagement — first PIN (M2 → M5, 019 provisionCashierPin)', () => {
  it('the dialog names the cashier; «حفظ» is disabled until both fields hold 4 digits', async () => {
    const user = userEvent.setup();
    renderAt(MANAGER_SESSION, makeBridge());
    await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
    expect(within(screen.getByRole('dialog')).getByRole('heading')).toHaveTextContent(
      'تعيين أول رقم سري لـ أمل',
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText(CASHIERS_COPY.newPinLabel)).toHaveFocus();
    const save = screen.getByRole('button', { name: CASHIERS_COPY.save });
    expect(save).toBeDisabled();
    await typePins(user, '4729', '472');
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(CASHIERS_COPY.confirmPinLabel), '9');
    expect(save).toBeEnabled();
  });

  it('both PIN fields are password, numeric, LTR and take digits only (max 6)', async () => {
    const user = userEvent.setup();
    renderAt(MANAGER_SESSION, makeBridge());
    await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
    for (const label of [CASHIERS_COPY.newPinLabel, CASHIERS_COPY.confirmPinLabel]) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('inputmode', 'numeric');
      expect(input).toHaveAttribute('dir', 'ltr');
    }
    const first = screen.getByLabelText(CASHIERS_COPY.newPinLabel);
    await user.type(first, '12a3b4567');
    expect(first).toHaveValue('123456');
  });

  it('a mismatch → M-K3, both fields cleared, focus back on the first, no call', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    renderAt(MANAGER_SESSION, bridge);
    await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
    await typePins(user, '4729', '4728');
    await user.click(screen.getByRole('button', { name: CASHIERS_COPY.save }));

    expect(screen.getByTestId('pin-dialog-message')).toHaveTextContent(CASHIERS_COPY.mismatch);
    expect(screen.getByLabelText(CASHIERS_COPY.newPinLabel)).toHaveValue('');
    expect(screen.getByLabelText(CASHIERS_COPY.confirmPinLabel)).toHaveValue('');
    expect(screen.getByLabelText(CASHIERS_COPY.newPinLabel)).toHaveFocus();
    expect(screen.getByLabelText(CASHIERS_COPY.newPinLabel)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(bridge.provisionCashierPin).not.toHaveBeenCalled();
  });

  it('Enter with a short PIN → M-K4, fields cleared, no call', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    renderAt(MANAGER_SESSION, bridge);
    await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
    await typePins(user, '472', '472{Enter}');

    expect(screen.getByTestId('pin-dialog-message')).toHaveTextContent(CASHIERS_COPY.wrongLength);
    expect(screen.getByLabelText(CASHIERS_COPY.newPinLabel)).toHaveValue('');
    expect(bridge.provisionCashierPin).not.toHaveBeenCalled();
  });

  it('success → provision with the roster id and PIN only, M-K2, dialog closed, list re-read', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.listCashierPinStatus
      .mockResolvedValueOnce(listed(AMAL, BASMA, DALIA))
      .mockResolvedValueOnce(listed({ ...AMAL, pin: 'ready' }, BASMA, DALIA));
    renderAt(MANAGER_SESSION, bridge);
    await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: CASHIERS_COPY.save }));

    await waitFor(() =>
      expect(screen.getByTestId('action-success')).toHaveTextContent(
        'تم تعيين الرقم السري لـ أمل.',
      ),
    );
    expect(bridge.provisionCashierPin).toHaveBeenCalledWith({
      event_id: expect.any(String) as string,
      target_cashier_id: 'cash-1',
      initial_pin: '4729',
    });
    expect(screen.queryByTestId('pin-dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getAllByTestId('cashier-row')[0] as HTMLElement).getByTestId('pin-status'),
      ).toHaveTextContent(PIN_STATE_LABEL.ready),
    );
    expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
    expect(document.body.innerHTML).not.toContain('4729');
  });

  it('not_ready → M-K10 inside the dialog, which stays open; no category in the DOM', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({
      provisionCashierPin: vi.fn().mockResolvedValue({ kind: 'refused', category: 'not_ready' }),
    });
    renderAt(MANAGER_SESSION, bridge);
    await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: CASHIERS_COPY.save }));

    await waitFor(() =>
      expect(screen.getByTestId('pin-dialog-message')).toHaveTextContent(CASHIERS_COPY.notReady),
    );
    expect(screen.getByTestId('pin-dialog')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('not_ready');
  });

  it.each(['state_invalid', 'invalid_input', 'no_connection'])(
    '%s → M-K9 generic failure, dialog closed, list re-read, no category in the DOM',
    async (category) => {
      const user = userEvent.setup();
      const bridge = makeBridge({
        provisionCashierPin: vi.fn().mockResolvedValue({ kind: 'refused', category }),
      });
      renderAt(MANAGER_SESSION, bridge);
      await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
      await typePins(user, '4729', '4729');
      await user.click(screen.getByRole('button', { name: CASHIERS_COPY.save }));

      await waitFor(() =>
        expect(screen.getByTestId('action-error')).toHaveTextContent(CASHIERS_COPY.genericFailure),
      );
      expect(screen.queryByTestId('pin-dialog')).not.toBeInTheDocument();
      expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
      expect(document.body.innerHTML).not.toContain(category);
    },
  );

  it('Escape and «إلغاء» close the dialog without calling the bridge', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    renderAt(MANAGER_SESSION, bridge);
    await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('pin-dialog')).not.toBeInTheDocument();

    await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
    await user.click(screen.getByRole('button', { name: CASHIERS_COPY.cancel }));
    expect(screen.queryByTestId('pin-dialog')).not.toBeInTheDocument();
    expect(bridge.provisionCashierPin).not.toHaveBeenCalled();
  });

  it('the screen behind an open dialog is inert', async () => {
    const user = userEvent.setup();
    renderAt(MANAGER_SESSION, makeBridge());
    await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
    expect(screen.getByTestId('cashier-management')).toHaveAttribute('inert');
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('cashier-management')).not.toHaveAttribute('inert');
  });
});

describe('CashierManagement — change PIN (M3/M4 → M5, resetCashierPin)', () => {
  it('success → reset with the roster id and the new PIN, M-K2b, list re-read', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    renderAt(MANAGER_SESSION, bridge);
    await openDialog(user, 'بسمة', CASHIERS_COPY.changePin);
    expect(within(screen.getByRole('dialog')).getByRole('heading')).toHaveTextContent(
      'تغيير الرقم السري لـ بسمة',
    );
    await typePins(user, '908172', '908172');
    await user.click(screen.getByRole('button', { name: CASHIERS_COPY.save }));

    await waitFor(() =>
      expect(screen.getByTestId('action-success')).toHaveTextContent(
        'تم تغيير الرقم السري لـ بسمة.',
      ),
    );
    expect(bridge.resetCashierPin).toHaveBeenCalledWith({
      event_id: expect.any(String) as string,
      target_cashier_id: 'cash-2',
      new_pin: '908172',
    });
    expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
    expect(document.body.innerHTML).not.toContain('908172');
  });

  it('is offered on a locked row too (it also clears the lock)', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    renderAt(MANAGER_SESSION, bridge);
    await openDialog(user, 'داليا', CASHIERS_COPY.changePin);
    await typePins(user, '1234', '1234');
    await user.click(screen.getByRole('button', { name: CASHIERS_COPY.save }));
    await waitFor(() => {
      expect(bridge.resetCashierPin).toHaveBeenCalledOnce();
    });
  });

  it('a refusal → M-K9, no category in the DOM', async () => {
    const user = userEvent.setup();
    renderAt(
      MANAGER_SESSION,
      makeBridge({
        resetCashierPin: vi.fn().mockResolvedValue({ kind: 'refused', category: 'invalid_input' }),
      }),
    );
    await openDialog(user, 'بسمة', CASHIERS_COPY.changePin);
    await typePins(user, '1234', '1234');
    await user.click(screen.getByRole('button', { name: CASHIERS_COPY.save }));
    await waitFor(() =>
      expect(screen.getByTestId('action-error')).toHaveTextContent(CASHIERS_COPY.genericFailure),
    );
    expect(document.body.innerHTML).not.toContain('invalid_input');
  });
});

describe('CashierManagement — unlock (M4, unlockCashier)', () => {
  it('sends event_id and the roster id only (no PIN), shows M-K2c and re-reads', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.listCashierPinStatus
      .mockResolvedValueOnce(listed(AMAL, BASMA, DALIA))
      .mockResolvedValueOnce(
        listed(AMAL, BASMA, { id: DALIA.id, display_name: DALIA.display_name, pin: 'ready' }),
      );
    renderAt(MANAGER_SESSION, bridge);
    await user.click(
      within(await rowOf('داليا')).getByRole('button', { name: CASHIERS_COPY.unlock }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('action-success')).toHaveTextContent('تم فك القفل عن داليا.'),
    );
    const req = bridge.unlockCashier.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(req).sort()).toEqual(['event_id', 'target_cashier_id']);
    expect(req['target_cashier_id']).toBe('cash-3');
    await waitFor(() =>
      expect(
        within(screen.getAllByTestId('cashier-row')[2] as HTMLElement).getByTestId('pin-status'),
      ).toHaveTextContent(PIN_STATE_LABEL.ready),
    );
    expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
  });

  it('state_invalid (the lock already ended) reads as unlocked', async () => {
    const user = userEvent.setup();
    renderAt(
      MANAGER_SESSION,
      makeBridge({
        unlockCashier: vi.fn().mockResolvedValue({ kind: 'refused', category: 'state_invalid' }),
      }),
    );
    await user.click(
      within(await rowOf('داليا')).getByRole('button', { name: CASHIERS_COPY.unlock }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('action-success')).toHaveTextContent('تم فك القفل عن داليا.'),
    );
  });

  it('another refusal → M-K9, no category in the DOM', async () => {
    const user = userEvent.setup();
    renderAt(
      MANAGER_SESSION,
      makeBridge({
        unlockCashier: vi.fn().mockResolvedValue({ kind: 'refused', category: 'role_mismatch' }),
      }),
    );
    await user.click(
      within(await rowOf('داليا')).getByRole('button', { name: CASHIERS_COPY.unlock }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('action-error')).toHaveTextContent(CASHIERS_COPY.genericFailure),
    );
    expect(document.body.innerHTML).not.toContain('role_mismatch');
  });
});

describe('CashierManagement — a rejected bridge call (e.g. refused while locked)', () => {
  it('reads as M-K9, releases the pending guard and re-reads', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({
      unlockCashier: vi.fn().mockRejectedValue(new Error('session_locked')),
    });
    renderAt(MANAGER_SESSION, bridge);
    await user.click(
      within(await rowOf('داليا')).getByRole('button', { name: CASHIERS_COPY.unlock }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('action-error')).toHaveTextContent(CASHIERS_COPY.genericFailure);
    });
    await waitFor(() => {
      for (const btn of rowButtons()) expect(btn).toBeEnabled();
    });
    expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
    expect(document.body.innerHTML).not.toContain('session_locked');
  });
});

describe('CashierManagement — one pending guard and the re-read (RT-235 review, doc 19 §2)', () => {
  it('a second «حفظ» while the first call is in flight is ignored; Cancel and Escape are blocked', async () => {
    const user = userEvent.setup();
    const call = deferred();
    const bridge = makeBridge({ provisionCashierPin: vi.fn(() => call.promise) });
    renderAt(MANAGER_SESSION, bridge);
    await openDialog(user, 'أمل', CASHIERS_COPY.setFirstPin);
    await typePins(user, '4729', '4729');
    const save = screen.getByRole('button', { name: CASHIERS_COPY.save });
    await user.click(save);
    await user.click(save);

    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);
    expect(save).toBeDisabled();
    expect(screen.getByRole('button', { name: CASHIERS_COPY.cancel })).toBeDisabled();
    for (const btn of rowButtons()) expect(btn).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('pin-dialog')).toBeInTheDocument();

    call.settle({ kind: 'pin_provisioned', audit_event_id: 'evt-3' });
    await waitFor(() => expect(screen.getByTestId('action-success')).toBeInTheDocument());
    await waitFor(() => {
      for (const btn of rowButtons()) expect(btn).toBeEnabled();
    });
    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);
  });

  it('an in-flight unlock disables every row action until it and its re-read land', async () => {
    const user = userEvent.setup();
    const call = deferred();
    const bridge = makeBridge({ unlockCashier: vi.fn(() => call.promise) });
    renderAt(MANAGER_SESSION, bridge);
    await user.click(
      within(await rowOf('داليا')).getByRole('button', { name: CASHIERS_COPY.unlock }),
    );
    for (const btn of rowButtons()) expect(btn).toBeDisabled();

    call.settle({ kind: 'unlocked', audit_event_id: 'evt-2' });
    await waitFor(() => {
      for (const btn of rowButtons()) expect(btn).toBeEnabled();
    });
  });

  it('during a re-read the loaded rows stay, with their actions disabled, then are replaced in one step', async () => {
    const user = userEvent.setup();
    const reread = deferred();
    const bridge = makeBridge();
    bridge.listCashierPinStatus
      .mockResolvedValueOnce(listed(AMAL, BASMA, DALIA))
      .mockReturnValueOnce(reread.promise);
    renderAt(MANAGER_SESSION, bridge);
    await user.click(
      within(await rowOf('داليا')).getByRole('button', { name: CASHIERS_COPY.unlock }),
    );

    await waitFor(() => {
      expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
    });
    expect(screen.getAllByTestId('cashier-row')).toHaveLength(3);
    for (const btn of rowButtons()) expect(btn).toBeDisabled();

    reread.settle(listed(BASMA));
    await waitFor(() => {
      expect(screen.getAllByTestId('cashier-row')).toHaveLength(1);
    });
    for (const btn of rowButtons()) expect(btn).toBeEnabled();
  });

  it('a failed re-read after an action shows M1, not stale badges', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    bridge.listCashierPinStatus
      .mockResolvedValueOnce(listed(AMAL, BASMA, DALIA))
      .mockResolvedValueOnce({ kind: 'refused', category: 'no_connection' });
    renderAt(MANAGER_SESSION, bridge);
    await user.click(
      within(await rowOf('داليا')).getByRole('button', { name: CASHIERS_COPY.unlock }),
    );

    expect(await screen.findByTestId('cashier-management-error')).toHaveTextContent(
      CASHIERS_COPY.rosterOffline,
    );
    expect(screen.queryByTestId('cashier-row')).not.toBeInTheDocument();
    // The action's own outcome is still reported.
    expect(screen.getByTestId('action-success')).toBeInTheDocument();
  });
});
