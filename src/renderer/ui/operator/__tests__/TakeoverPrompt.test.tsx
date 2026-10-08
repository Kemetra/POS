import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { TakeoverPrompt } from '../TakeoverPrompt.js';
import type {
  OperatorBridgeAPI,
  OperatorSessionBridgeView,
  SignInResponse,
} from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';

/**
 * 004-operator-session T076 + T077 — TakeoverPrompt tests.
 *
 * Verifies:
 *   - Renders the dialog with FR-013-compliant copy.
 *   - FR-013 forbidden-string assertions (no terminal id, operator id,
 *     role, timestamp, "View details", "ago", etc.).
 *   - Initial focus is on Cancel (safety default).
 *   - "Continue here" → confirmTakeover → signed_in → store signedIn.
 *   - "Continue here" → confirmTakeover → refused/invalid_input → store signedOut.
 *   - "Continue here" → confirmTakeover → refused/no_connection → inline
 *     retry error shown; store stays in takeoverPrompt (proto retained).
 *   - Spinner shown while confirming; error/spinner mutual exclusion (Note 1).
 *   - "Cancel" → cancelTakeover → store signedOut.
 *   - Bridge throw fallback → generic refusal, no message echo.
 */

const PENDING_ID = 'test-pending-0001';

const SAMPLE_SESSION: OperatorSessionBridgeView = {
  id: 'sess-99',
  operator_id: 'op-99',
  display_name: 'Alice Manager',
  role: 'manager',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-09T10:00:00.000Z',
};

function makeBridge(overrides?: Partial<OperatorBridgeAPI>): OperatorBridgeAPI {
  return {
    signIn: vi.fn(() =>
      Promise.resolve({ kind: 'refused', category: 'invalid_input' } as SignInResponse),
    ),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    getCurrentSession: vi.fn(() => Promise.resolve(null)),
    _reportActivity: vi.fn(),
    emitAuditEvent: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    _emitAuditEventSmoke: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    listBranchRoster: vi.fn(() => Promise.resolve({ kind: 'roster' as const, cashiers: [] })),
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
    unlockSession: vi.fn(() => Promise.resolve({ kind: 'unlocked' as const })),
    getLockState: vi.fn(() =>
      Promise.resolve({
        state: 'active' as const,
        locked_at: null,
        role: null,
        display_name: null,
        summary: null,
      }),
    ),
    onSessionStateChanged: vi.fn(() => () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  // Seed store in takeoverPrompt state (as sign-in route would do).
  useOperatorSessionStore.getState().reset();
  useOperatorSessionStore.setState({
    state: { kind: 'takeoverPrompt', pending_takeover_id: PENDING_ID },
  });
});

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('TakeoverPrompt — rendering', () => {
  it('renders the dialog container', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt')).toBeInTheDocument();
  });

  it('renders title and body text', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-title')).toBeInTheDocument();
    expect(screen.getByTestId('takeover-prompt-body')).toBeInTheDocument();
  });

  it('renders Cancel and Continue here buttons', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('takeover-prompt-confirm')).toBeInTheDocument();
  });

  it('title text matches visual-direction spec verbatim', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-title').textContent).toBe(
      'You are already signed in on another POS terminal in this branch.',
    );
  });

  it('body text matches visual-direction spec verbatim', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-body').textContent).toBe(
      'Continue here and sign out there?',
    );
  });

  it('primary button label is "Continue here"', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-confirm').textContent).toBe('Continue here');
  });

  it('secondary button label is "Cancel"', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-cancel').textContent).toBe('Cancel');
  });
});

describe('TakeoverPrompt — FR-013 minimum-disclosure', () => {
  it('does NOT show any POS- terminal identifier', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/POS-/);
  });

  it('does NOT show the word "Cashier" as a role label', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/Cashier /);
  });

  it('does NOT show the word "Manager" as a role label', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/Manager/);
  });

  it('does NOT show the word "Admin" as a role label', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/Admin/);
  });

  it('does NOT show a time-ago string', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/ago/);
  });

  it('does NOT show HH:MM style timestamps', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/\d{2}:\d{2}/);
  });

  it('does NOT show a "View details" link', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/View details/i);
  });

  it('does NOT expose the pending_takeover_id in the DOM', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toContain(PENDING_ID);
  });
});

describe('TakeoverPrompt — focus management', () => {
  it('Cancel button receives initial focus on mount', () => {
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-cancel')).toHaveFocus();
  });
});

describe('TakeoverPrompt — T077 confirm flow', () => {
  it('on signed_in response, transitions store to signedIn', async () => {
    const user = userEvent.setup();
    const confirmTakeover = vi.fn(() =>
      Promise.resolve({ kind: 'signed_in' as const, session: SAMPLE_SESSION }),
    );
    const bridge = makeBridge({ confirmTakeover });
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    await user.click(screen.getByTestId('takeover-prompt-confirm'));
    await waitFor(() => {
      expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    });
    expect(confirmTakeover).toHaveBeenCalledWith({ pending_takeover_id: PENDING_ID });
  });

  it('on refused/invalid_input, transitions store to signedOut with category', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({
      confirmTakeover: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
      ),
    });
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    await user.click(screen.getByTestId('takeover-prompt-confirm'));
    await waitFor(() => {
      const state = useOperatorSessionStore.getState().state;
      expect(state.kind).toBe('signedOut');
    });
    const state = useOperatorSessionStore.getState().state;
    if (state.kind === 'signedOut') {
      expect(state.lastRefusal).toBe('invalid_input');
    }
  });

  it('on refused/no_connection, stays in takeoverPrompt and shows inline error', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({
      confirmTakeover: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, category: 'no_connection' as const }),
      ),
    });
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    await user.click(screen.getByTestId('takeover-prompt-confirm'));
    const errorEl = await screen.findByTestId('takeover-prompt-error');
    expect(errorEl).toHaveAttribute('data-category', 'no_connection');
    // Store stays in takeoverPrompt.
    expect(useOperatorSessionStore.getState().state.kind).toBe('takeoverPrompt');
  });

  it('spinner shown during confirm; error NOT shown simultaneously', async () => {
    const user = userEvent.setup();
    let resolveConfirm!: (v: { kind: 'refused'; category: 'no_connection' }) => void;
    const bridge = makeBridge({
      confirmTakeover: vi.fn(
        () =>
          new Promise<{ kind: 'refused'; category: 'no_connection' }>((res) => {
            resolveConfirm = res;
          }),
      ),
    });
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    await user.click(screen.getByTestId('takeover-prompt-confirm'));
    // Spinner is shown; error is absent.
    await screen.findByTestId('takeover-prompt-spinner');
    expect(screen.queryByTestId('takeover-prompt-error')).not.toBeInTheDocument();
    // Resolve with no_connection to trigger the error state.
    resolveConfirm({ kind: 'refused', category: 'no_connection' });
    await waitFor(() => {
      expect(screen.queryByTestId('takeover-prompt-spinner')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('takeover-prompt-error')).toBeInTheDocument();
  });

  it('bridge throw on confirm falls back to generic refusal (no message echo)', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge({
      confirmTakeover: vi.fn(() => Promise.reject(new Error('INTERNAL-ERROR-MUST-NOT-SHOW'))),
    });
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    await user.click(screen.getByTestId('takeover-prompt-confirm'));
    await waitFor(() => {
      const state = useOperatorSessionStore.getState().state;
      expect(state.kind).toBe('signedOut');
    });
    // The thrown message must NOT appear in the DOM.
    expect(document.body.textContent).not.toContain('INTERNAL-ERROR-MUST-NOT-SHOW');
  });

  it('second click while confirming is a no-op (does not call bridge twice)', async () => {
    const user = userEvent.setup();
    let resolveConfirm!: (v: { kind: 'signed_in'; session: OperatorSessionBridgeView }) => void;
    const confirmTakeover = vi.fn(
      () =>
        new Promise<{ kind: 'signed_in'; session: OperatorSessionBridgeView }>((res) => {
          resolveConfirm = res;
        }),
    );
    const bridge = makeBridge({ confirmTakeover });
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    await user.click(screen.getByTestId('takeover-prompt-confirm'));
    await screen.findByTestId('takeover-prompt-spinner');
    // Second click while spinner is shown — button is disabled, but dispatch event directly.
    const confirmBtn = screen.getByTestId('takeover-prompt-confirm');
    confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(confirmTakeover).toHaveBeenCalledTimes(1);
    resolveConfirm({ kind: 'signed_in', session: SAMPLE_SESSION });
    await waitFor(() => {
      expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    });
  });
});

describe('TakeoverPrompt — T077 cancel flow', () => {
  it('Cancel calls cancelTakeover bridge method', async () => {
    const user = userEvent.setup();
    const cancelTakeover = vi.fn(() => Promise.resolve({ kind: 'cancelled' as const }));
    const bridge = makeBridge({ cancelTakeover });
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    await user.click(screen.getByTestId('takeover-prompt-cancel'));
    await waitFor(() => {
      expect(cancelTakeover).toHaveBeenCalledWith({ pending_takeover_id: PENDING_ID });
    });
  });

  it('Cancel transitions store to signedOut', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);
    await user.click(screen.getByTestId('takeover-prompt-cancel'));
    await waitFor(() => {
      expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
    });
  });
});

describe('TakeoverPrompt — Escape-to-cancel (WCAG 2.1.1)', () => {
  it('Escape cancels the takeover (calls cancelTakeover, drops to signedOut)', async () => {
    const cancelTakeover = vi.fn(() => Promise.resolve({ kind: 'cancelled' as const }));
    const bridge = makeBridge({ cancelTakeover });
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    await waitFor(() => {
      expect(cancelTakeover).toHaveBeenCalledWith({ pending_takeover_id: PENDING_ID });
    });
    await waitFor(() => {
      expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
    });
  });

  it('a non-Escape key does NOT cancel the takeover', () => {
    const cancelTakeover = vi.fn(() => Promise.resolve({ kind: 'cancelled' as const }));
    const bridge = makeBridge({ cancelTakeover });
    render(<TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(cancelTakeover).not.toHaveBeenCalled();
    expect(useOperatorSessionStore.getState().state.kind).toBe('takeoverPrompt');
  });

  it('removes the keydown listener on unmount (no cancel after unmount)', () => {
    const cancelTakeover = vi.fn(() => Promise.resolve({ kind: 'cancelled' as const }));
    const bridge = makeBridge({ cancelTakeover });
    const { unmount } = render(
      <TakeoverPrompt operator={bridge} pending_takeover_id={PENDING_ID} />,
    );

    unmount();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cancelTakeover).not.toHaveBeenCalled();
  });
});
