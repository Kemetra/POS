import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ManagerAdminSignInForm } from '../ManagerAdminSignInForm.js';
import type {
  OperatorBridgeAPI,
  OperatorSessionBridgeView,
  SignInResponse,
} from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { SIGN_IN_REFUSAL_COPY } from '../messages.js';

/**
 * 004-operator-session T019 + T021 + T023 — Manager / admin sign-in
 * form tests.
 *
 * T019: renders, validates non-empty, submits via bridge.
 * T021 (Slice 0 reviewer Note 1): error-then-resubmit transition.
 *      The inline alert dismisses on the first new keystroke; the
 *      next submit's spinner replaces the alert space, NOT alongside
 *      it.
 * T023: successful sign-in transitions the store to signedIn and
 *      surfaces the operator session.
 */

const SAMPLE_SESSION: OperatorSessionBridgeView = {
  id: 'sess-1',
  operator_id: 'op-1',
  display_name: 'Manager One',
  role: 'manager',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-06T00:00:00.000Z',
};

interface BridgeWithMocks {
  bridge: OperatorBridgeAPI;
  signInMock: ReturnType<typeof vi.fn<(req: unknown) => Promise<SignInResponse>>>;
}

function bridgeWith(impl: (req: unknown) => Promise<SignInResponse>): BridgeWithMocks {
  const signInMock = vi.fn(impl);
  const bridge: OperatorBridgeAPI = {
    signIn: signInMock,
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
  };
  return { bridge, signInMock };
}

function happyResponse(): Promise<SignInResponse> {
  return Promise.resolve({ kind: 'signed_in' as const, session: SAMPLE_SESSION });
}

function refusedResponse(): Promise<SignInResponse> {
  return Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const });
}

function takeoverResponse(): Promise<SignInResponse> {
  return Promise.resolve({
    kind: 'takeover_required' as const,
    pending_takeover_id: 'test-pending-id-0000',
  });
}

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
});

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('ManagerAdminSignInForm — T019 / T023 happy path', () => {
  it('renders the identifier and password fields and a Sign in button', () => {
    const { bridge } = bridgeWith(happyResponse);
    render(<ManagerAdminSignInForm operator={bridge} />);
    expect(screen.getByLabelText(/email or username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByTestId('sign-in-submit')).toHaveTextContent(/sign in/i);
  });

  it('refuses to submit when either field is empty (validation, no bridge call)', async () => {
    const user = userEvent.setup();
    const { bridge, signInMock } = bridgeWith(happyResponse);
    render(<ManagerAdminSignInForm operator={bridge} />);
    await user.click(screen.getByTestId('sign-in-submit'));
    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('sign-in-empty-input')).toBeInTheDocument();
  });

  it('typing after the empty-input alert dismisses it (T021 pairing — no overlap)', async () => {
    const user = userEvent.setup();
    const { bridge } = bridgeWith(happyResponse);
    render(<ManagerAdminSignInForm operator={bridge} />);
    // Trigger the empty-input alert by submitting with no values.
    await user.click(screen.getByTestId('sign-in-submit'));
    expect(screen.getByTestId('sign-in-empty-input')).toBeInTheDocument();
    // The first new keystroke clears the alert.
    await user.type(screen.getByLabelText(/email or username/i), 'i');
    expect(screen.queryByTestId('sign-in-empty-input')).not.toBeInTheDocument();
  });

  it('submits the typed identifier and password to the bridge once', async () => {
    const user = userEvent.setup();
    const { bridge, signInMock } = bridgeWith(happyResponse);
    render(<ManagerAdminSignInForm operator={bridge} />);
    await user.type(screen.getByLabelText(/email or username/i), 'manager@x.test');
    await user.type(screen.getByLabelText(/^password$/i), 'p455');
    await user.click(screen.getByTestId('sign-in-submit'));
    await waitFor(() => {
      expect(signInMock).toHaveBeenCalledTimes(1);
    });
    expect(signInMock).toHaveBeenCalledWith({
      kind: 'manager_admin',
      identifier: 'manager@x.test',
      password: 'p455',
    });
  });

  it('on signed_in, transitions store to signedIn with the bridge session', async () => {
    const user = userEvent.setup();
    const { bridge } = bridgeWith(happyResponse);
    render(<ManagerAdminSignInForm operator={bridge} />);
    await user.type(screen.getByLabelText(/email or username/i), 'm@x.test');
    await user.type(screen.getByLabelText(/^password$/i), 'p');
    await user.click(screen.getByTestId('sign-in-submit'));
    await waitFor(() => {
      const state = useOperatorSessionStore.getState().state;
      expect(state.kind).toBe('signedIn');
      if (state.kind === 'signedIn') {
        expect(state.session.operator_id).toBe('op-1');
      }
    });
  });

  it('on takeover_required, transitions store to takeoverPrompt', async () => {
    const user = userEvent.setup();
    const { bridge } = bridgeWith(takeoverResponse);
    render(<ManagerAdminSignInForm operator={bridge} />);
    await user.type(screen.getByLabelText(/email or username/i), 'm@x.test');
    await user.type(screen.getByLabelText(/^password$/i), 'p');
    await user.click(screen.getByTestId('sign-in-submit'));
    await waitFor(() => {
      expect(useOperatorSessionStore.getState().state.kind).toBe('takeoverPrompt');
    });
  });

  it('clears the password input value as soon as the bridge resolves', async () => {
    const user = userEvent.setup();
    const { bridge } = bridgeWith(happyResponse);
    render(<ManagerAdminSignInForm operator={bridge} />);
    await user.type(screen.getByLabelText(/email or username/i), 'm@x.test');
    const password = screen.getByLabelText(/^password$/i);
    await user.type(password, 'super-secret');
    expect((password as HTMLInputElement).value).toBe('super-secret');
    await user.click(screen.getByTestId('sign-in-submit'));
    await waitFor(() => {
      expect((password as HTMLInputElement).value).toBe('');
    });
  });
});

describe('ManagerAdminSignInForm — T021 (Slice 0 Note 1) error-then-resubmit', () => {
  it('on refusal renders the inline alert with the generic copy', async () => {
    const user = userEvent.setup();
    render(<ManagerAdminSignInForm operator={bridgeWith(refusedResponse).bridge} />);
    await user.type(screen.getByLabelText(/email or username/i), 'm@x.test');
    await user.type(screen.getByLabelText(/^password$/i), 'wrong');
    await user.click(screen.getByTestId('sign-in-submit'));
    const alert = await screen.findByTestId('sign-in-refusal');
    expect(alert).toHaveAttribute('data-category', 'invalid_input');
    // Assert against the canonical copy SYMBOL, not a hardcoded English
    // literal: the intent is "the generic message for this category is
    // shown", which must survive the 022 Arabic-first copy change and any
    // future wording change. The security property (one generic message per
    // category, no factor-distinguishing detail) is what data-category above
    // actually pins.
    expect(alert).toHaveTextContent(SIGN_IN_REFUSAL_COPY.invalid_input);
    // Spinner MUST NOT be visible while the alert is.
    expect(screen.queryByTestId('sign-in-spinner')).not.toBeInTheDocument();
  });

  it('typing a new keystroke dismisses the inline alert', async () => {
    const user = userEvent.setup();
    render(<ManagerAdminSignInForm operator={bridgeWith(refusedResponse).bridge} />);
    await user.type(screen.getByLabelText(/email or username/i), 'i');
    await user.type(screen.getByLabelText(/^password$/i), 'p');
    await user.click(screen.getByTestId('sign-in-submit'));
    await screen.findByTestId('sign-in-refusal');
    // First new keystroke dismisses the alert.
    await user.type(screen.getByLabelText(/^password$/i), 'q');
    expect(screen.queryByTestId('sign-in-refusal')).not.toBeInTheDocument();
  });

  it('next submit replaces the alert space with the spinner (never alongside)', async () => {
    const user = userEvent.setup();
    const resolver: { resolve: ((res: SignInResponse) => void) | null } = { resolve: null };
    const slow: OperatorBridgeAPI = {
      signIn: vi.fn(
        () =>
          new Promise<SignInResponse>((resolve) => {
            resolver.resolve = resolve;
          }),
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
    };
    render(<ManagerAdminSignInForm operator={slow} />);
    await user.type(screen.getByLabelText(/email or username/i), 'i');
    await user.type(screen.getByLabelText(/^password$/i), 'p');
    await user.click(screen.getByTestId('sign-in-submit'));
    // Spinner is shown; alert is absent.
    await screen.findByTestId('sign-in-spinner');
    expect(screen.queryByTestId('sign-in-refusal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sign-in-empty-input')).not.toBeInTheDocument();
    // Resolve as refusal and verify the spinner unmounts before the
    // alert appears (they never co-exist).
    expect(resolver.resolve).not.toBeNull();
    resolver.resolve?.({ kind: 'refused', category: 'invalid_input' });
    await waitFor(() => {
      expect(screen.queryByTestId('sign-in-spinner')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('sign-in-refusal')).toBeInTheDocument();
  });
});

describe('ManagerAdminSignInForm — re-entry guard', () => {
  it('a second submit while signingIn is a no-op (does not call the bridge twice)', async () => {
    const user = userEvent.setup();
    const resolver: { resolve: ((res: SignInResponse) => void) | null } = { resolve: null };
    const signInMock = vi.fn(
      () =>
        new Promise<SignInResponse>((resolve) => {
          resolver.resolve = resolve;
        }),
    );
    const slow: OperatorBridgeAPI = {
      signIn: signInMock,
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
    };
    render(<ManagerAdminSignInForm operator={slow} />);
    await user.type(screen.getByLabelText(/email or username/i), 'i');
    await user.type(screen.getByLabelText(/^password$/i), 'p');
    // First submit — kicks off the slow signIn.
    await user.click(screen.getByTestId('sign-in-submit'));
    await screen.findByTestId('sign-in-spinner');
    // Submit button is disabled while signingIn; firing the form's submit
    // event directly (re-entry path) MUST be a no-op.
    const form = screen.getByTestId('manager-admin-sign-in-form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(signInMock).toHaveBeenCalledTimes(1);
    // Resolve the slow promise so React unmounts cleanly.
    resolver.resolve?.({ kind: 'refused', category: 'invalid_input' });
    await waitFor(() => {
      expect(screen.queryByTestId('sign-in-spinner')).not.toBeInTheDocument();
    });
  });
});

describe('ManagerAdminSignInForm — bridge throw fallback', () => {
  it('on bridge rejection, falls back to a generic refusal (no message echo)', async () => {
    const user = userEvent.setup();
    const bridge: OperatorBridgeAPI = {
      signIn: vi.fn(() => Promise.reject(new Error('SOMETHING-INTERNAL-WE-MUST-NEVER-SHOW'))),
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
    };
    render(<ManagerAdminSignInForm operator={bridge} />);
    await user.type(screen.getByLabelText(/email or username/i), 'i');
    await user.type(screen.getByLabelText(/^password$/i), 'p');
    await user.click(screen.getByTestId('sign-in-submit'));
    const alert = await screen.findByTestId('sign-in-refusal');
    expect(alert).toHaveAttribute('data-category', 'invalid_input');
    // The thrown message is NOT surfaced.
    expect(alert).not.toHaveTextContent('SOMETHING-INTERNAL-WE-MUST-NEVER-SHOW');
  });
});
