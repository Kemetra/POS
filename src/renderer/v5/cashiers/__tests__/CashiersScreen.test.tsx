import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import type {
  CashierPinStatus,
  ListCashierPinStatusResponse,
  PairingBridgeAPI,
} from '../../../../shared/bridge-api';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { REAUTH_COPY, SIGN_IN_REFUSAL_COPY } from '../../../ui/operator/messages';
import { expectNoAxeViolations } from '../../../test-utils/axe-config';
import { DialogHost } from '../../foundation/Dialog';
import { CASHIERS_COPY as C } from '../cashiers-copy';
import { CashiersScreen } from '../CashiersScreen';

/**
 * RT-424 (RT-251 doc 19 §3–§5, G-3) — Manager → Cashiers, rendered.
 */

const MONA: CashierPinStatus = {
  id: 'user_clerk_MONA',
  display_name: 'منى عبد الرحمن',
  pin: 'ready',
};
const AHMED: CashierPinStatus = {
  id: 'user_clerk_AHMED',
  display_name: 'أحمد سمير',
  pin: 'no_pin',
};
const LOCK_ISO = new Date(2026, 9, 12, 14, 35, 0).toISOString();
const YASMIN: CashierPinStatus = {
  id: 'user_clerk_YASMIN',
  display_name: 'ياسمين خالد',
  pin: 'locked',
  locked_until: LOCK_ISO,
};
const ROSTER = [MONA, AHMED, YASMIN];

function cashiers(...list: CashierPinStatus[]): ListCashierPinStatusResponse {
  return { kind: 'cashiers', cashiers: list };
}

interface BridgeOpts {
  reads?: (ListCashierPinStatusResponse | Promise<ListCashierPinStatusResponse>)[];
  provision?: unknown[];
  reset?: unknown;
  unlock?: unknown;
  reauth?: unknown;
}

function makeBridge(opts: BridgeOpts = {}) {
  const reads = [...(opts.reads ?? [cashiers(...ROSTER)])];
  let last = reads[reads.length - 1] ?? cashiers(...ROSTER);
  const provisions = [...(opts.provision ?? [])];
  return {
    listCashierPinStatus: vi.fn(() => {
      const next = reads.shift();
      if (next !== undefined) last = next;
      return Promise.resolve(next ?? last);
    }),
    provisionCashierPin: vi.fn<(req: Record<string, unknown>) => Promise<unknown>>(() =>
      Promise.resolve(provisions.shift() ?? { kind: 'pin_provisioned', audit_event_id: 'e1' }),
    ),
    resetCashierPin: vi.fn<(req: Record<string, unknown>) => Promise<unknown>>(() =>
      Promise.resolve(opts.reset ?? { kind: 'pin_reset', audit_event_id: 'e2' }),
    ),
    unlockCashier: vi.fn<(req: Record<string, unknown>) => Promise<unknown>>(() =>
      Promise.resolve(opts.unlock ?? { kind: 'unlocked', audit_event_id: 'e3' }),
    ),
    reauthenticate: vi.fn(() => Promise.resolve(opts.reauth ?? { kind: 'reauthenticated' })),
  };
}

type Bridge = ReturnType<typeof makeBridge>;

function signInManager(): void {
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 's1',
    operator_id: 'op-mgr',
    display_name: 'سارة عبد الحميد',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    started_at: '2026-10-12T08:00:00.000Z',
  });
}

function renderScreen(bridge: Bridge, pairing?: PairingBridgeAPI) {
  signInManager();
  return render(
    <MemoryRouter>
      <DialogHost>
        <main>
          <CashiersScreen operator={bridge as never} {...(pairing ? { pairing } : {})} />
        </main>
      </DialogHost>
    </MemoryRouter>,
  );
}

function rowOf(name: string): HTMLElement {
  const row = screen.getAllByTestId('cashier-row').find((r) => r.textContent.includes(name));
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
}

async function openFirstPin(user: ReturnType<typeof userEvent.setup>) {
  await screen.findAllByTestId('cashier-row');
  await user.click(
    within(rowOf(AHMED.display_name)).getByRole('button', { name: C.action.first_pin }),
  );
  return screen.getByRole('dialog');
}

async function typePins(user: ReturnType<typeof userEvent.setup>, a: string, b: string) {
  if (a !== '') await user.type(screen.getByLabelText(C.newPin), a);
  if (b !== '') await user.type(screen.getByLabelText(C.confirmPin), b);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('RT-424 CashiersScreen — the list', () => {
  it('shows the loading line and no rows on the first load', async () => {
    const gate = deferred<ListCashierPinStatusResponse>();
    const bridge = makeBridge({ reads: [gate.promise] });
    renderScreen(bridge);
    expect(screen.getByText(C.loading)).toBeInTheDocument();
    expect(screen.queryAllByTestId('cashier-row')).toHaveLength(0);
    await act(async () => {
      gate.resolve(cashiers(...ROSTER));
      await gate.promise;
    });
    expect(await screen.findAllByTestId('cashier-row')).toHaveLength(3);
    expect(screen.queryByText(C.loading)).not.toBeInTheDocument();
  });

  it('shows the title, the list heading, the count and the terminal label', async () => {
    const pairing = {
      getStatus: vi.fn(() =>
        Promise.resolve({
          kind: 'paired',
          tenant_id: 't',
          branch_id: 'b',
          terminal_id: 'term',
          terminal_label: 'POS-03',
          paired_at: 0,
        }),
      ),
    } as unknown as PairingBridgeAPI;
    renderScreen(makeBridge(), pairing);
    expect(screen.getByRole('heading', { level: 1, name: C.title })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: C.listHeading })).toBeInTheDocument();
    expect(await screen.findByText(C.count(3))).toBeInTheDocument();
    expect(await screen.findByTestId('cashiers-terminal')).toHaveTextContent(
      `${C.subtitle} POS-03`,
    );
  });

  it('shows each badge in text, and the lock end as «حتى HH:MM» in Western digits', async () => {
    renderScreen(makeBridge());
    await screen.findAllByTestId('cashier-row');
    expect(within(rowOf(MONA.display_name)).getByTestId('cashier-pin-badge')).toHaveTextContent(
      C.badge.ready,
    );
    expect(within(rowOf(AHMED.display_name)).getByTestId('cashier-pin-badge')).toHaveTextContent(
      C.badge.no_pin,
    );
    const locked = within(rowOf(YASMIN.display_name)).getByTestId('cashier-pin-badge');
    expect(locked).toHaveTextContent(`${C.badge.locked} ${C.lockedUntil} 14:35`);
    expect(locked.querySelector('time')).toHaveAttribute('datetime', LOCK_ISO);
  });

  it('applies the M2–M4 matrix: what does not apply is absent, not disabled', async () => {
    renderScreen(makeBridge());
    await screen.findAllByTestId('cashier-row');
    const names = (row: HTMLElement) =>
      within(row)
        .queryAllByRole('button')
        .map((b) => b.textContent);
    expect(names(rowOf(AHMED.display_name))).toEqual([C.action.first_pin]);
    expect(names(rowOf(MONA.display_name))).toEqual([C.action.change_pin]);
    expect(names(rowOf(YASMIN.display_name))).toEqual([C.action.unlock, C.action.change_pin]);
  });

  it('describes every action by its row name, and never puts a roster id in the DOM', async () => {
    const { container } = renderScreen(makeBridge());
    await screen.findAllByTestId('cashier-row');
    const change = within(rowOf(MONA.display_name)).getByRole('button', {
      name: C.action.change_pin,
    });
    expect(change).toHaveAccessibleDescription(MONA.display_name);
    for (const c of ROSTER) expect(container.innerHTML).not.toContain(c.id);
  });

  it.each([
    ['no_connection', C.unreachable],
    ['role_mismatch', C.refused],
    ['not_signed_in', C.refused],
    ['invalid_input', C.refused],
  ] as const)(
    'a %s read shows the matching message and «إعادة المحاولة»',
    async (category, text) => {
      const bridge = makeBridge({ reads: [{ kind: 'refused', category }, cashiers(MONA)] });
      const user = userEvent.setup();
      renderScreen(bridge);
      const notice = await screen.findByTestId('cashier-management-error');
      expect(notice).toHaveTextContent(text);
      expect(notice).not.toHaveTextContent(category);
      await user.click(within(notice).getByRole('button', { name: C.retry }));
      expect(await screen.findAllByTestId('cashier-row')).toHaveLength(1);
      expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
    },
  );

  it('a rejected read (the session is locked) shows M-K1b, never an unhandled error', async () => {
    const bridge = makeBridge();
    bridge.listCashierPinStatus.mockRejectedValueOnce(new Error('session_locked'));
    renderScreen(bridge);
    expect(await screen.findByTestId('cashier-management-error')).toHaveTextContent(C.refused);
  });

  it('shows the empty-roster message with a zero count', async () => {
    renderScreen(makeBridge({ reads: [cashiers()] }));
    expect(await screen.findByTestId('cashiers-empty')).toHaveTextContent(C.empty);
    expect(screen.getByText(C.count(0))).toBeInTheDocument();
  });
});

describe('RT-424 CashiersScreen — the PIN dialog (M5)', () => {
  it('names the cashier in the title and keeps «حفظ» disabled until both fields hold 4–6 digits', async () => {
    const user = userEvent.setup();
    renderScreen(makeBridge());
    const dialog = await openFirstPin(user);
    expect(within(dialog).getByRole('heading')).toHaveTextContent(
      `${C.dialogTitle.first_pin} ${AHMED.display_name}`,
    );
    expect(screen.getByLabelText(C.newPin)).toHaveFocus();
    const save = within(dialog).getByRole('button', { name: C.save });
    expect(save).toBeDisabled();
    await typePins(user, '1234', '123');
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(C.confirmPin), '4');
    expect(save).toBeEnabled();
  });

  it('a mismatch shows M-K3, clears both fields, refocuses the first and sends nothing', async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderScreen(bridge);
    await openFirstPin(user);
    await typePins(user, '1234', '4321');
    await user.click(screen.getByRole('button', { name: C.save }));
    expect(screen.getByTestId('pin-dialog-message')).toHaveTextContent(C.mismatch);
    expect(screen.getByLabelText(C.newPin)).toHaveValue('');
    expect(screen.getByLabelText(C.confirmPin)).toHaveValue('');
    expect(screen.getByLabelText(C.newPin)).toHaveFocus();
    expect(screen.getByLabelText(C.newPin)).toHaveAttribute('aria-invalid', 'true');
    expect(bridge.provisionCashierPin).not.toHaveBeenCalled();
  });

  it('Enter on a short entry shows M-K4, clears both fields and sends nothing', async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderScreen(bridge);
    await openFirstPin(user);
    await typePins(user, '12', '12');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('pin-dialog-message')).toHaveTextContent(C.wrongLength);
    expect(screen.getByLabelText(C.newPin)).toHaveValue('');
    expect(screen.getByLabelText(C.newPin)).toHaveFocus();
    expect(bridge.provisionCashierPin).not.toHaveBeenCalled();
  });

  it('collects the PIN masked, LTR and numeric', async () => {
    const user = userEvent.setup();
    renderScreen(makeBridge());
    await openFirstPin(user);
    for (const label of [C.newPin, C.confirmPin]) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('inputmode', 'numeric');
      expect(input).toHaveAttribute('dir', 'ltr');
      expect(input).toHaveAttribute('autocomplete', 'off');
    }
  });

  it('Escape and «إلغاء» close the dialog without a call', async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderScreen(bridge);
    await openFirstPin(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await openFirstPin(user);
    await user.click(screen.getByRole('button', { name: C.cancel }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridge.provisionCashierPin).not.toHaveBeenCalled();
  });
});

describe('RT-424 CashiersScreen — actions', () => {
  it('first PIN: sends the roster id and the Western-digit PIN, closes, shows M-K2, re-reads', async () => {
    const bridge = makeBridge({
      reads: [cashiers(...ROSTER), cashiers(MONA, { ...AHMED, pin: 'ready' }, YASMIN)],
    });
    const user = userEvent.setup();
    const { container } = renderScreen(bridge);
    await openFirstPin(user);
    await typePins(user, '٤٧٢٩', '4729');
    await user.click(screen.getByRole('button', { name: C.save }));

    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);
    const req = bridge.provisionCashierPin.mock.calls[0]?.[0] ?? {};
    expect(Object.keys(req).sort()).toEqual(['event_id', 'initial_pin', 'target_cashier_id']);
    expect(req['target_cashier_id']).toBe(AHMED.id);
    expect(req['initial_pin']).toBe('4729');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByTestId('action-success')).toHaveTextContent(
      `${C.done.first_pin} ${AHMED.display_name}.`,
    );
    await waitFor(() =>
      expect(within(rowOf(AHMED.display_name)).getByTestId('cashier-pin-badge')).toHaveTextContent(
        C.badge.ready,
      ),
    );
    expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('4729');
  });

  it('first PIN: after the row changes, focus lands on that row’s remaining action', async () => {
    const bridge = makeBridge({
      reads: [cashiers(...ROSTER), cashiers(MONA, { ...AHMED, pin: 'ready' }, YASMIN)],
    });
    const user = userEvent.setup();
    renderScreen(bridge);
    await openFirstPin(user);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: C.save }));
    await waitFor(() =>
      expect(
        within(rowOf(AHMED.display_name)).getByRole('button', { name: C.action.change_pin }),
      ).toHaveFocus(),
    );
  });

  it('first PIN not_ready: M-K10 inside the dialog, fields cleared, dialog stays, list re-reads', async () => {
    const bridge = makeBridge({ provision: [{ kind: 'refused', category: 'not_ready' }] });
    const user = userEvent.setup();
    renderScreen(bridge);
    await openFirstPin(user);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: C.save }));
    expect(await screen.findByTestId('pin-dialog-message')).toHaveTextContent(C.notReady);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(C.newPin)).toHaveValue('');
    await waitFor(() => expect(screen.getByLabelText(C.newPin)).toHaveFocus());
    await waitFor(() => {
      expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    ['state_invalid', { kind: 'refused', category: 'state_invalid' }],
    ['invalid_input', { kind: 'refused', category: 'invalid_input' }],
  ])('first PIN %s: M-K9 inside the dialog, no category in the DOM', async (category, answer) => {
    const bridge = makeBridge({ provision: [answer] });
    const user = userEvent.setup();
    const { container } = renderScreen(bridge);
    await openFirstPin(user);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: C.save }));
    expect(await screen.findByTestId('pin-dialog-message')).toHaveTextContent(C.failure);
    expect(container.textContent).not.toContain(category);
  });

  it('a rejected Save (the session locked) reads as M-K9', async () => {
    const bridge = makeBridge();
    bridge.provisionCashierPin.mockRejectedValueOnce(new Error('session_locked'));
    const user = userEvent.setup();
    renderScreen(bridge);
    await openFirstPin(user);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: C.save }));
    expect(await screen.findByTestId('pin-dialog-message')).toHaveTextContent(C.failure);
  });

  it('change PIN (D1): resetCashierPin with new_pin, M-K2b, list re-reads', async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderScreen(bridge);
    await screen.findAllByTestId('cashier-row');
    await user.click(
      within(rowOf(MONA.display_name)).getByRole('button', { name: C.action.change_pin }),
    );
    expect(within(screen.getByRole('dialog')).getByRole('heading')).toHaveTextContent(
      `${C.dialogTitle.change_pin} ${MONA.display_name}`,
    );
    await typePins(user, '1357', '1357');
    await user.click(screen.getByRole('button', { name: C.save }));
    const req = bridge.resetCashierPin.mock.calls[0]?.[0] ?? {};
    expect(Object.keys(req).sort()).toEqual(['event_id', 'new_pin', 'target_cashier_id']);
    expect(req['target_cashier_id']).toBe(MONA.id);
    expect(await screen.findByTestId('action-success')).toHaveTextContent(
      `${C.done.change_pin} ${MONA.display_name}.`,
    );
    expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
  });

  it('change PIN refused: M-K9 inside the dialog', async () => {
    const bridge = makeBridge({ reset: { kind: 'refused', category: 'invalid_input' } });
    const user = userEvent.setup();
    renderScreen(bridge);
    await screen.findAllByTestId('cashier-row');
    await user.click(
      within(rowOf(MONA.display_name)).getByRole('button', { name: C.action.change_pin }),
    );
    await typePins(user, '1357', '1357');
    await user.click(screen.getByRole('button', { name: C.save }));
    expect(await screen.findByTestId('pin-dialog-message')).toHaveTextContent(C.failure);
  });

  it.each([
    ['unlocked', { kind: 'unlocked', audit_event_id: 'e' }],
    ['state_invalid (the lock had already ended)', { kind: 'refused', category: 'state_invalid' }],
  ])('unlock %s: no PIN field, M-K2c, list re-reads', async (_l, answer) => {
    const bridge = makeBridge({ unlock: answer });
    const user = userEvent.setup();
    renderScreen(bridge);
    await screen.findAllByTestId('cashier-row');
    await user.click(
      within(rowOf(YASMIN.display_name)).getByRole('button', { name: C.action.unlock }),
    );
    const req = bridge.unlockCashier.mock.calls[0]?.[0] ?? {};
    expect(Object.keys(req).sort()).toEqual(['event_id', 'target_cashier_id']);
    expect(req['target_cashier_id']).toBe(YASMIN.id);
    expect(await screen.findByTestId('action-success')).toHaveTextContent(
      `${C.done.unlock} ${YASMIN.display_name}.`,
    );
    await waitFor(() => {
      expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
    });
  });

  it('unlock refused: M-K9 on the screen, list re-reads', async () => {
    const bridge = makeBridge({ unlock: { kind: 'refused', category: 'role_mismatch' } });
    const user = userEvent.setup();
    const { container } = renderScreen(bridge);
    await screen.findAllByTestId('cashier-row');
    await user.click(
      within(rowOf(YASMIN.display_name)).getByRole('button', { name: C.action.unlock }),
    );
    expect(await screen.findByTestId('action-error')).toHaveTextContent(C.failure);
    expect(container.textContent).not.toContain('role_mismatch');
    await waitFor(() => {
      expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
    });
  });
});

describe('RT-424 CashiersScreen — one action at a time', () => {
  it('while a Save is in flight: Save, Cancel, Escape and every row action are blocked', async () => {
    const gate = deferred<unknown>();
    const bridge = makeBridge();
    bridge.provisionCashierPin.mockImplementationOnce(() => gate.promise);
    const user = userEvent.setup();
    renderScreen(bridge);
    await openFirstPin(user);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: C.save }));

    expect(screen.getByRole('button', { name: C.save })).toBeDisabled();
    expect(screen.getByRole('button', { name: C.cancel })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    for (const row of screen.getAllByTestId('cashier-row')) {
      for (const b of within(row).queryAllByRole('button', { hidden: true }))
        expect(b).toBeDisabled();
    }
    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve({ kind: 'pin_provisioned', audit_event_id: 'e' });
      await gate.promise;
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('after a refusal, the open dialog stays disabled until the re-read lands', async () => {
    const reread = deferred<ListCashierPinStatusResponse>();
    const bridge = makeBridge({
      reads: [cashiers(...ROSTER), reread.promise],
      provision: [{ kind: 'refused', category: 'not_ready' }],
    });
    const user = userEvent.setup();
    renderScreen(bridge);
    await openFirstPin(user);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: C.save }));
    expect(await screen.findByTestId('pin-dialog-message')).toHaveTextContent(C.notReady);

    // The re-read is still in flight: the fields, «حفظ» and «إلغاء» stay disabled.
    expect(screen.getByLabelText(C.newPin)).toBeDisabled();
    expect(screen.getByRole('button', { name: C.cancel })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);

    await act(async () => {
      reread.resolve(cashiers(...ROSTER));
      await reread.promise;
    });
    await waitFor(() => {
      expect(screen.getByLabelText(C.newPin)).toBeEnabled();
    });
    expect(screen.getByLabelText(C.newPin)).toHaveFocus();
  });

  it('a re-read keeps the rows on screen and disables every action until it lands', async () => {
    const reread = deferred<ListCashierPinStatusResponse>();
    const bridge = makeBridge({ reads: [cashiers(...ROSTER), reread.promise] });
    const user = userEvent.setup();
    renderScreen(bridge);
    await screen.findAllByTestId('cashier-row');
    await user.click(
      within(rowOf(YASMIN.display_name)).getByRole('button', { name: C.action.unlock }),
    );

    await waitFor(() => {
      expect(bridge.listCashierPinStatus).toHaveBeenCalledTimes(2);
    });
    expect(screen.getAllByTestId('cashier-row')).toHaveLength(3);
    for (const b of within(rowOf(MONA.display_name)).getAllByRole('button'))
      expect(b).toBeDisabled();

    await act(async () => {
      reread.resolve(cashiers(MONA, AHMED, { ...YASMIN, pin: 'ready' }));
      await reread.promise;
    });
    await waitFor(() => expect(within(rowOf(MONA.display_name)).getByRole('button')).toBeEnabled());
    expect(within(rowOf(YASMIN.display_name)).getByTestId('cashier-pin-badge')).toHaveTextContent(
      C.badge.ready,
    );
  });
});

describe('RT-424 CashiersScreen — M6 session expired (RT-358)', () => {
  const REAUTH_REQUIRED = { kind: 'refused', category: 'reauth_required' } as const;

  async function submitFirstPin(user: ReturnType<typeof userEvent.setup>) {
    await openFirstPin(user);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: C.save }));
  }

  async function reauthenticate(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: REAUTH_COPY.action }));
    await user.type(screen.getByTestId('reauth-identifier'), 'mgr@example.test');
    await user.type(screen.getByTestId('reauth-password'), 'pw');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: REAUTH_COPY.submit }),
    );
  }

  it('shows the M-A3 notice with only «تسجيل الدخول», and the PIN dialog closes', async () => {
    const user = userEvent.setup();
    renderScreen(makeBridge({ provision: [REAUTH_REQUIRED] }));
    await submitFirstPin(user);
    const notice = await screen.findByTestId('reauth-required');
    expect(notice).toHaveTextContent(SIGN_IN_REFUSAL_COPY.reauth_required);
    expect(
      within(notice)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([REAUTH_COPY.action]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('after a re-auth, sends the SAME PIN again exactly once and shows M-K2', async () => {
    const bridge = makeBridge({ provision: [REAUTH_REQUIRED] });
    const user = userEvent.setup();
    renderScreen(bridge);
    await submitFirstPin(user);
    await reauthenticate(user);
    expect(await screen.findByTestId('action-success')).toHaveTextContent(
      `${C.done.first_pin} ${AHMED.display_name}.`,
    );
    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(2);
    const pins = bridge.provisionCashierPin.mock.calls.map((c) => c[0]['initial_pin']);
    expect(pins).toEqual(['4729', '4729']);
    expect(screen.queryByTestId('reauth-required')).not.toBeInTheDocument();
  });

  it('cancelling the re-auth drops the PIN and sends nothing more', async () => {
    const bridge = makeBridge({ provision: [REAUTH_REQUIRED] });
    const user = userEvent.setup();
    renderScreen(bridge);
    await submitFirstPin(user);
    await user.click(await screen.findByRole('button', { name: REAUTH_COPY.action }));
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('reauth-required')).not.toBeInTheDocument();
    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);
  });

  it('a second reauth_required right after a re-auth never prompts again', async () => {
    const bridge = makeBridge({ provision: [REAUTH_REQUIRED, REAUTH_REQUIRED] });
    const user = userEvent.setup();
    renderScreen(bridge);
    await submitFirstPin(user);
    await reauthenticate(user);
    expect(await screen.findByTestId('action-error')).toHaveTextContent(
      SIGN_IN_REFUSAL_COPY.not_signed_in,
    );
    expect(screen.queryByTestId('reauth-required')).not.toBeInTheDocument();
    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(2);
  });
});

describe('RT-424 CashiersScreen — focus never falls to <body>', () => {
  it('after a successful «إعادة المحاولة», focus moves to the list heading', async () => {
    const bridge = makeBridge({
      reads: [{ kind: 'refused', category: 'no_connection' }, cashiers(...ROSTER)],
    });
    const user = userEvent.setup();
    renderScreen(bridge);
    const notice = await screen.findByTestId('cashier-management-error');
    await user.click(within(notice).getByRole('button', { name: C.retry }));
    await screen.findAllByTestId('cashier-row');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: C.listHeading })).toHaveFocus();
    });
  });

  it('after cancelling the re-auth, focus moves to that cashier’s row action', async () => {
    const bridge = makeBridge({ provision: [{ kind: 'refused', category: 'reauth_required' }] });
    const user = userEvent.setup();
    renderScreen(bridge);
    await openFirstPin(user);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: C.save }));
    await user.click(await screen.findByRole('button', { name: REAUTH_COPY.action }));
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        within(rowOf(AHMED.display_name)).getByRole('button', { name: C.action.first_pin }),
      ).toHaveFocus();
    });
  });
});

describe('RT-424 CashiersScreen — M6 retry details (ported from RT-358)', () => {
  const REAUTH_REQUIRED = { kind: 'refused', category: 'reauth_required' } as const;

  async function reachReauthDialog(user: ReturnType<typeof userEvent.setup>) {
    await openFirstPin(user);
    await typePins(user, '4729', '4729');
    await user.click(screen.getByRole('button', { name: C.save }));
    await user.click(await screen.findByRole('button', { name: REAUTH_COPY.action }));
    await user.type(screen.getByTestId('reauth-identifier'), 'mgr@example.test');
    await user.type(screen.getByTestId('reauth-password'), 'pw');
  }

  it('while the PIN retry after a re-auth is in flight, no «تسجيل الدخول» is offered', async () => {
    const gate = deferred<unknown>();
    const bridge = makeBridge({ provision: [REAUTH_REQUIRED] });
    const user = userEvent.setup();
    renderScreen(bridge);
    await reachReauthDialog(user);
    bridge.provisionCashierPin.mockImplementationOnce(() => gate.promise);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: REAUTH_COPY.submit }),
    );
    await waitFor(() => {
      expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId('reauth-required')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: REAUTH_COPY.action })).not.toBeInTheDocument();
    await act(async () => {
      gate.resolve({ kind: 'pin_provisioned', audit_event_id: 'e' });
      await gate.promise;
    });
    expect(await screen.findByTestId('action-success')).toBeInTheDocument();
  });

  it('a refused re-auth keeps the dialog open and sends no PIN again', async () => {
    const bridge = makeBridge({
      provision: [REAUTH_REQUIRED],
      reauth: { kind: 'refused', category: 'invalid_input' },
    });
    const user = userEvent.setup();
    renderScreen(bridge);
    await reachReauthDialog(user);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: REAUTH_COPY.submit }),
    );
    expect(await screen.findByTestId('reauth-refusal')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(bridge.provisionCashierPin).toHaveBeenCalledTimes(1);
  });
});

describe('RT-424 CashiersScreen — accessibility', () => {
  it('has no axe violations on the list, in the dialog and on the M1 state', async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderScreen(makeBridge());
    await screen.findAllByTestId('cashier-row');
    await expectNoAxeViolations(container);
    await openFirstPin(user);
    await expectNoAxeViolations(document.body);
    unmount();
    const failed = renderScreen(
      makeBridge({ reads: [{ kind: 'refused', category: 'no_connection' }] }),
    );
    await screen.findByTestId('cashier-management-error');
    await expectNoAxeViolations(failed.container);
  });
});
