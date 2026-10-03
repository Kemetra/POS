import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useState, type JSX } from 'react';

import { SessionLockGate } from '../SessionLockGate';
import type {
  LockStateView,
  SessionStateEvent,
  UnlockSessionResponse,
} from '../../../shared/bridge-api';

afterEach(cleanup);

/**
 * RT-117 (RT-116 §2, VN-R8) — the lock screen.
 *
 *   • appears immediately on main's `locked` push (and on mount if main is
 *     already locked);
 *   • keeps the sale mounted underneath (made inert), so the exact cashier
 *     state is preserved;
 *   • shows the preserved TOTALS only — no credentials, no ids;
 *   • unlocks the same session through `unlockSession`; Esc never closes it.
 */

const ACTIVE: LockStateView = {
  state: 'active',
  locked_at: null,
  role: 'cashier',
  display_name: 'Cashier One',
  summary: null,
};

const LOCKED_CASHIER: LockStateView = {
  state: 'locked',
  locked_at: '2026-10-01T10:10:00.000Z',
  role: 'cashier',
  display_name: 'Cashier One',
  summary: { line_count: 3, total_minor: 5275, tender_applied_minor: 1000, has_live_tender: true },
};

function fakeOperator(initial: LockStateView, unlock?: () => Promise<UnlockSessionResponse>) {
  let view = initial;
  let push: ((e: SessionStateEvent) => void) | null = null;
  const api = {
    getLockState: vi.fn(() => Promise.resolve(view)),
    unlockSession: vi.fn(
      unlock ?? (() => Promise.resolve<UnlockSessionResponse>({ kind: 'unlocked' })),
    ),
    onSessionStateChanged: vi.fn((cb: (e: SessionStateEvent) => void) => {
      push = cb;
      return () => {
        push = null;
      };
    }),
  };
  return {
    api,
    setView: (v: LockStateView) => {
      view = v;
    },
    push: (e: SessionStateEvent) => {
      act(() => push?.(e));
    },
  };
}

/** A child with local state, to prove the sale stays mounted while locked. */
function Counter(): JSX.Element {
  const [n, setN] = useState(0);
  return (
    <button
      type="button"
      onClick={() => {
        setN(n + 1);
      }}
    >
      count {n}
    </button>
  );
}

describe('RT-117 SessionLockGate', () => {
  it('renders the app and no lock screen while active', async () => {
    const op = fakeOperator(ACTIVE);
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    await waitFor(() => {
      expect(op.api.getLockState).toHaveBeenCalled();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'count 0' })).toBeInTheDocument();
  });

  it('shows the lock screen immediately on a locked push, keeping the sale mounted', async () => {
    const op = fakeOperator(ACTIVE);
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'count 0' }));

    op.setView(LOCKED_CASHIER);
    op.push({ state: 'locked' });

    expect(await screen.findByRole('dialog', { name: 'الجهاز مقفل' })).toBeInTheDocument();
    // The sale underneath keeps its state and is inert while locked.
    const app = screen.getByTestId('session-lock-app');
    expect(app).toHaveAttribute('inert');
    expect(app).toHaveTextContent('count 1');
    // RT-161: preserved, but not readable behind the lock.
    expect(app).toHaveClass('session-lock-app--concealed');
  });

  it('shows the lock screen on mount when main is already locked', async () => {
    const op = fakeOperator(LOCKED_CASHIER);
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    expect(await screen.findByRole('dialog', { name: 'الجهاز مقفل' })).toBeInTheDocument();
  });

  it('shows the preserved totals only', async () => {
    const op = fakeOperator(LOCKED_CASHIER);
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('لم يُفقد شيء');
    expect(dialog).toHaveTextContent('3');
    expect(dialog).toHaveTextContent('52.75');
    expect(dialog).toHaveTextContent('10.00');
    expect(dialog).toHaveTextContent('Cashier One');
  });

  it('unlocks a cashier with the PIN and resumes the same sale', async () => {
    const op = fakeOperator(LOCKED_CASHIER);
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    const pin = await screen.findByLabelText('رمز PIN');
    expect(pin).toHaveAttribute('type', 'password');
    await userEvent.type(pin, '1234');
    await userEvent.click(screen.getByRole('button', { name: 'فتح القفل' }));

    expect(op.api.unlockSession).toHaveBeenCalledWith({ method: 'pin', pin: '1234' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('session-lock-app')).not.toHaveAttribute('inert');
    expect(screen.getByTestId('session-lock-app')).not.toHaveClass('session-lock-app--concealed');
  });

  it('a wrong PIN shows a generic error, clears the field and stays locked', async () => {
    const op = fakeOperator(LOCKED_CASHIER, () =>
      Promise.resolve({ kind: 'refused', category: 'invalid_input' }),
    );
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    const pin = await screen.findByLabelText('رمز PIN');
    await userEvent.type(pin, '0000');
    await userEvent.click(screen.getByRole('button', { name: 'فتح القفل' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('تعذّر فتح القفل');
    expect(pin).toHaveValue('');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // RT-24 I-4: no scanner input into PIN fields. A barcode burst typed into
  // the focused PIN field must never reach main as a PIN attempt — each wrong
  // attempt counts toward the 004 lockout, which nobody can clear from a lock.
  it('rejects a scanner burst locally without calling unlockSession', async () => {
    const op = fakeOperator(LOCKED_CASHIER);
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    const pin = await screen.findByLabelText('رمز PIN');
    await userEvent.type(pin, '6223000123456{Enter}');

    expect(op.api.unlockSession).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('رمز PIN من 4 إلى 6 أرقام');
    expect(pin).toHaveValue('');
  });

  it.each(['123', 'abcd', '12 34'])('rejects a malformed PIN %j locally', async (entry) => {
    const op = fakeOperator(LOCKED_CASHIER);
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    await userEvent.type(await screen.findByLabelText('رمز PIN'), `${entry}{Enter}`);
    expect(op.api.unlockSession).not.toHaveBeenCalled();
  });

  it('offers the online credential form to a manager', async () => {
    const op = fakeOperator({ ...LOCKED_CASHIER, role: 'manager', display_name: 'Manager One' });
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    await userEvent.type(
      await screen.findByLabelText('البريد أو اسم المستخدم'),
      'mgr@example.test',
    );
    await userEvent.type(screen.getByLabelText('كلمة المرور'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'فتح القفل' }));

    expect(op.api.unlockSession).toHaveBeenCalledWith({
      method: 'online_credential',
      identifier: 'mgr@example.test',
      password: 'pw',
    });
  });

  // A lock is not dismissible: Escape cancels the ENTRY in progress (clears
  // the typed PIN) and leaves the lock in place (DESIGN.md "Esc cancels").
  it('Escape clears the entry in progress but does not close the lock screen', async () => {
    const op = fakeOperator(LOCKED_CASHIER);
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    const pin = await screen.findByLabelText('رمز PIN');
    await userEvent.type(pin, '12');
    await userEvent.keyboard('{Escape}');

    expect(pin).toHaveValue('');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(op.api.unlockSession).not.toHaveBeenCalled();
  });

  // `inert` does not silence document/window key listeners. Keys typed on the
  // lock (or anywhere while locked) must not reach the sale's listeners behind
  // it — e.g. an open confirm-add Dialog's Escape-to-close.
  it.each([
    [
      'typed on the lock screen',
      async (): Promise<void> => {
        await userEvent.type(await screen.findByLabelText('رمز PIN'), '12');
        await userEvent.keyboard('{Escape}');
      },
    ],
    [
      'aimed outside the lock',
      async (): Promise<void> => {
        await screen.findByRole('dialog');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      },
    ],
  ])('keys %s never reach document listeners behind it', async (_where, pressKeys) => {
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    try {
      const op = fakeOperator(LOCKED_CASHIER);
      render(
        <SessionLockGate operator={op.api}>
          <Counter />
        </SessionLockGate>,
      );
      await pressKeys();
      expect(behind).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });

  it('clears the lock screen on an active or ended push', async () => {
    const op = fakeOperator(LOCKED_CASHIER);
    render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    await screen.findByRole('dialog');
    op.push({ state: 'active' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    op.push({ state: 'locked' });
    await screen.findByRole('dialog');
    op.push({ state: 'ended' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('unsubscribes from the push on unmount', async () => {
    const op = fakeOperator(ACTIVE);
    const { unmount } = render(
      <SessionLockGate operator={op.api}>
        <Counter />
      </SessionLockGate>,
    );
    await waitFor(() => {
      expect(op.api.onSessionStateChanged).toHaveBeenCalled();
    });
    unmount();
    expect(() => {
      op.push({ state: 'locked' });
    }).not.toThrow();
  });
});
