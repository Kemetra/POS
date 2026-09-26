import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import type { SignOutResponse } from '../../../shared/bridge-api';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { V5Frame } from '../frame/V5Frame';

/**
 * 023 — V5 sign-out. Neither shell had a sign-out control; the bridge method
 * `operator.signOut()` existed with no caller. Two-step: the first press asks
 * inline, the second signs out through main, and only then does the renderer
 * leave the signed-in state. Blocked while a payment attempt is open.
 */

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

function signIn(): void {
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: 'د. سارة',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-09-26T09:00:00Z',
  });
}

function stubBridge(signOut: () => Promise<SignOutResponse>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(signOut);
  (window as unknown as { api: unknown }).api = { operator: { signOut: fn } };
  return fn;
}

function renderFrame(): void {
  render(
    <MemoryRouter initialEntries={['/app/cart']}>
      <V5Frame>
        <section aria-labelledby="t">
          <h1 id="t">مساحة البيع</h1>
        </section>
      </V5Frame>
    </MemoryRouter>,
  );
}

const SIGN_OUT = 'تسجيل الخروج';
const CONFIRM = 'تأكيد تسجيل الخروج';
const CANCEL = 'البقاء مسجّلاً';

describe('V5 sign-out', () => {
  it('asks first: the first press calls nothing and offers confirm and cancel', async () => {
    signIn();
    const signOut = stubBridge(() => Promise.resolve({ kind: 'signed_out' }));
    renderFrame();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: SIGN_OUT }));

    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: CONFIRM })).toHaveFocus();
    expect(screen.getByRole('button', { name: CANCEL })).toBeInTheDocument();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
  });

  it('cancel returns to the single button and focus, without signing out', async () => {
    signIn();
    const signOut = stubBridge(() => Promise.resolve({ kind: 'signed_out' }));
    renderFrame();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: SIGN_OUT }));
    await user.click(screen.getByRole('button', { name: CANCEL }));

    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: SIGN_OUT })).toHaveFocus();
    expect(screen.queryByRole('button', { name: CONFIRM })).not.toBeInTheDocument();
  });

  it('Escape cancels the confirmation', async () => {
    signIn();
    stubBridge(() => Promise.resolve({ kind: 'signed_out' }));
    renderFrame();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: SIGN_OUT }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: CONFIRM })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: SIGN_OUT })).toHaveFocus();
  });

  it('confirm signs out through main, then leaves the signed-in state', async () => {
    signIn();
    const signOut = stubBridge(() => Promise.resolve({ kind: 'signed_out' }));
    renderFrame();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: SIGN_OUT }));
    await user.click(screen.getByRole('button', { name: CONFIRM }));

    await waitFor(() => {
      expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
    });
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('a failed sign-out keeps the session, shows a generic error, and can be retried', async () => {
    signIn();
    const signOut = stubBridge(() => Promise.reject(new Error('ipc down')));
    renderFrame();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: SIGN_OUT }));
    await user.click(screen.getByRole('button', { name: CONFIRM }));

    expect(await screen.findByRole('alert')).toHaveTextContent('تعذّر تسجيل الخروج');
    expect(screen.queryByText(/ipc down/)).not.toBeInTheDocument();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    signOut.mockResolvedValueOnce({ kind: 'signed_out' });
    await user.click(screen.getByRole('button', { name: CONFIRM }));
    await waitFor(() => {
      expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
    });
  });

  it('is disabled, with a visible reason, while a payment attempt is open', () => {
    signIn();
    const signOut = stubBridge(() => Promise.resolve({ kind: 'signed_out' }));
    usePaymentStore.getState().applyAttemptSnapshot({
      payment_attempt_id: 'a1',
      state: 'started',
      envelope_subtotal_minor: 1500,
      started_at: '2026-09-26T09:05:00Z',
      tender_lines: [],
    });
    renderFrame();

    const button = screen.getByRole('button', { name: SIGN_OUT });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('أكمل الدفع أو ألغِه أولاً');
    expect(signOut).not.toHaveBeenCalled();
  });

  it('is not offered when nobody is signed in', () => {
    renderFrame();
    expect(screen.queryByRole('button', { name: SIGN_OUT })).not.toBeInTheDocument();
  });

  it('meets the 44px target floor', () => {
    const css = readFileSync(resolve(__dirname, '../frame/frame.css'), 'utf8');
    const rule = /\.v5-frame__sign-out button\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'sign-out button rule').not.toBeNull();
    expect(rule?.[1] ?? '').toMatch(/min-block-size:\s*var\(--v5-target\)/);
  });
});
