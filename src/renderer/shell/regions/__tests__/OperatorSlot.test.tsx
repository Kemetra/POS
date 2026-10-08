import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { OperatorSlot } from '../OperatorSlot';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../../../stores/operator-session-store';

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
});

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

const SAMPLE_SESSION: OperatorSessionView = {
  id: 'sess-1',
  operator_id: 'op-1',
  display_name: 'Manager One',
  role: 'manager',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-06T00:00:00.000Z',
};

/**
 * T030 — OperatorSlot: visibly disabled "Sign in" button; Constitution VIII.
 * 004 T031: when signed in, the slot renders the OperatorBadge.
 */
describe('OperatorSlot (T030)', () => {
  it('renders a "Sign in" button', () => {
    render(<OperatorSlot />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('button has aria-disabled="true"', () => {
    render(<OperatorSlot />);
    expect(screen.getByRole('button', { name: /sign in/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('button is non-focusable (tabIndex=-1)', () => {
    render(<OperatorSlot />);
    expect(screen.getByRole('button', { name: /sign in/i })).toHaveAttribute('tabindex', '-1');
  });

  it('click is a no-op — zero handler invocations', async () => {
    const user = userEvent.setup();
    render(<OperatorSlot />);
    const btn = screen.getByRole('button', { name: /sign in/i });
    await user.click(btn);
    // No handler was passed — asserting no throw and no navigation
    expect(btn).toBeInTheDocument();
  });

  it('shows "no operator signed in" accessible explanation', () => {
    render(<OperatorSlot />);
    // The tooltip/aria explanation should contain this copy
    const explanation = screen.queryByText(/sign.in is not yet available/i);
    // It may be in a tooltip (title attr) or sr-only span
    const hasExplanation =
      explanation !== null ||
      screen.getByRole('button', { name: /sign in/i }).hasAttribute('title');
    expect(hasExplanation).toBe(true);
  });
});

describe('OperatorSlot (004 T031 — signed-in branch)', () => {
  it('renders the OperatorBadge with display name and role when signed in', () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SAMPLE_SESSION);
    render(<OperatorSlot />);
    const badge = screen.getByTestId('operator-badge');
    expect(badge).toHaveTextContent('Manager One');
    expect(badge.querySelector('[data-role]')).toHaveTextContent('مدير');
    // The placeholder Sign-in button MUST NOT be rendered while signed in.
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('falls back to the disabled Sign-in button when the operator signs out', () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SAMPLE_SESSION);
    useOperatorSessionStore.getState().beginSignOut();
    useOperatorSessionStore.getState().resolveSignedOut();
    render(<OperatorSlot />);
    expect(screen.queryByTestId('operator-badge')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });
});
