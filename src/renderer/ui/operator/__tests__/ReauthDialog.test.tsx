import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ReauthDialog, ReauthRequiredNotice } from '../ReauthDialog.js';
import { EMPTY_INPUT_MESSAGE, REAUTH_COPY, SIGN_IN_REFUSAL_COPY } from '../messages.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import type { ReauthenticateResponse } from '../../../../shared/bridge-api.js';

/**
 * RT-358 (RT-247 plan §2.5, Q4 = dialog) — the in-place re-auth prompt.
 *
 *   • Notice: the owner-approved copy and ONE action «تسجيل الدخول»; no retry,
 *     no English, never the raw category.
 *   • Dialog (UX-11 via the v5 Dialog): focus on the identifier, Esc cancels,
 *     Tab stays inside, focus returns to the invoker; the manager's name shown
 *     read-only; wrong credentials use the sign-in refusal copy.
 */

function signInAs(display_name: string): void {
  useOperatorSessionStore.getState().beginSignIn();
  useOperatorSessionStore.getState().resolveSignedIn({
    id: 's1',
    operator_id: 'op-1',
    display_name,
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    started_at: '2026-10-11T08:00:00.000Z',
  });
}

function bridge(answer: ReauthenticateResponse) {
  return { reauthenticate: vi.fn(() => Promise.resolve(answer)) };
}

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('RT-358 ReauthRequiredNotice', () => {
  it('shows the approved Arabic copy and only «تسجيل الدخول»', async () => {
    const onSignIn = vi.fn();
    render(<ReauthRequiredNotice onSignIn={onSignIn} />);

    const notice = screen.getByTestId('reauth-required');
    expect(notice).toHaveTextContent(SIGN_IN_REFUSAL_COPY.reauth_required);
    expect(notice).toHaveAttribute('role', 'alert');
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(REAUTH_COPY.action);
    expect(notice.textContent).not.toMatch(/حاول مرة أخرى|try again|retry|reauth_required/i);

    await userEvent.setup().click(buttons[0] as HTMLElement);
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});

describe('RT-358 ReauthDialog', () => {
  it('focuses the identifier, shows the manager’s name read-only', () => {
    signInAs('Manager One');
    render(
      <ReauthDialog
        operator={bridge({ kind: 'reauthenticated' })}
        onReauthenticated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: REAUTH_COPY.title })).toBeInTheDocument();
    expect(screen.getByTestId('reauth-identifier')).toHaveFocus();
    expect(screen.getByTestId('reauth-manager-name')).toHaveTextContent('Manager One');
    expect(screen.queryByRole('textbox', { name: /Manager One/ })).not.toBeInTheDocument();
  });

  it('success: sends the trimmed identifier and the password, then reports success', async () => {
    signInAs('Manager One');
    const operator = bridge({ kind: 'reauthenticated' });
    const onReauthenticated = vi.fn();
    const user = userEvent.setup();
    render(
      <ReauthDialog operator={operator} onReauthenticated={onReauthenticated} onCancel={vi.fn()} />,
    );

    await user.type(screen.getByTestId('reauth-identifier'), '  mgr@example.test ');
    await user.type(screen.getByTestId('reauth-password'), 'pw');
    await user.click(screen.getByRole('button', { name: REAUTH_COPY.submit }));

    await waitFor(() => {
      expect(onReauthenticated).toHaveBeenCalledTimes(1);
    });
    expect(operator.reauthenticate).toHaveBeenCalledWith({
      identifier: 'mgr@example.test',
      password: 'pw',
    });
  });

  it.each(['invalid_input', 'rate_limited', 'no_connection', 'not_signed_in'] as const)(
    'a %s refusal shows the sign-in copy, clears the password and stays open',
    async (category) => {
      signInAs('Manager One');
      const onReauthenticated = vi.fn();
      const user = userEvent.setup();
      render(
        <ReauthDialog
          operator={bridge({ kind: 'refused', category })}
          onReauthenticated={onReauthenticated}
          onCancel={vi.fn()}
        />,
      );

      await user.type(screen.getByTestId('reauth-identifier'), 'mgr@example.test');
      await user.type(screen.getByTestId('reauth-password'), 'wrong');
      await user.click(screen.getByRole('button', { name: REAUTH_COPY.submit }));

      expect(await screen.findByTestId('reauth-refusal')).toHaveTextContent(
        SIGN_IN_REFUSAL_COPY[category],
      );
      expect(screen.getByTestId('reauth-password')).toHaveValue('');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(onReauthenticated).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain(category);
    },
  );

  it('empty fields → the empty-input message, nothing sent', async () => {
    signInAs('Manager One');
    const operator = bridge({ kind: 'reauthenticated' });
    render(<ReauthDialog operator={operator} onReauthenticated={vi.fn()} onCancel={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole('button', { name: REAUTH_COPY.submit }));
    expect(screen.getByTestId('reauth-empty')).toHaveTextContent(EMPTY_INPUT_MESSAGE);
    expect(operator.reauthenticate).not.toHaveBeenCalled();
  });

  it('a bridge without reauthenticate → the not-signed-in copy, nothing thrown', async () => {
    signInAs('Manager One');
    const user = userEvent.setup();
    render(<ReauthDialog operator={{}} onReauthenticated={vi.fn()} onCancel={vi.fn()} />);

    await user.type(screen.getByTestId('reauth-identifier'), 'x');
    await user.type(screen.getByTestId('reauth-password'), 'y');
    await user.click(screen.getByRole('button', { name: REAUTH_COPY.submit }));
    expect(await screen.findByTestId('reauth-refusal')).toHaveTextContent(
      SIGN_IN_REFUSAL_COPY.not_signed_in,
    );
  });

  it('Escape and «إلغاء» cancel', async () => {
    signInAs('Manager One');
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ReauthDialog
        operator={bridge({ kind: 'reauthenticated' })}
        onReauthenticated={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: REAUTH_COPY.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('Tab stays inside the dialog', async () => {
    signInAs('Manager One');
    const user = userEvent.setup();
    render(
      <>
        <button type="button">outside</button>
        <ReauthDialog
          operator={bridge({ kind: 'reauthenticated' })}
          onReauthenticated={vi.fn()}
          onCancel={vi.fn()}
        />
      </>,
    );
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('focus returns to the invoker on close', async () => {
    signInAs('Manager One');
    const user = userEvent.setup();
    function Host(): JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            open
          </button>
          {open && (
            <ReauthDialog
              operator={bridge({ kind: 'reauthenticated' })}
              onReauthenticated={vi.fn()}
              onCancel={() => {
                setOpen(false);
              }}
            />
          )}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'open' });
    await user.click(opener);
    expect(screen.getByTestId('reauth-identifier')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });

  it('renders inside its own subtree (so the lock’s inert, concealed wrapper covers it)', () => {
    signInAs('Manager One');
    render(
      <div data-testid="app-subtree">
        <ReauthDialog
          operator={bridge({ kind: 'reauthenticated' })}
          onReauthenticated={vi.fn()}
          onCancel={vi.fn()}
        />
      </div>,
    );
    expect(screen.getByTestId('app-subtree')).toContainElement(screen.getByRole('dialog'));
  });

  it('while a request is in flight, the fields and buttons are disabled and Esc does not cancel', async () => {
    signInAs('Manager One');
    let release: (v: ReauthenticateResponse) => void = () => undefined;
    const operator = {
      reauthenticate: vi.fn(
        () =>
          new Promise<ReauthenticateResponse>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<ReauthDialog operator={operator} onReauthenticated={vi.fn()} onCancel={onCancel} />);

    await user.type(screen.getByTestId('reauth-identifier'), 'x');
    await user.type(screen.getByTestId('reauth-password'), 'y');
    await user.click(screen.getByRole('button', { name: REAUTH_COPY.submit }));

    expect(screen.getByTestId('reauth-password')).toBeDisabled();
    expect(screen.getByRole('button', { name: REAUTH_COPY.cancel })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
    release({ kind: 'reauthenticated' });
  });
});
