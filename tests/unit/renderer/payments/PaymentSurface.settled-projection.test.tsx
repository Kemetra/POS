import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { PaymentSurface } from '../../../../src/renderer/ui/payments/PaymentSurface.js';
import { useOperatorSessionStore } from '../../../../src/renderer/stores/operator-session-store.js';
import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../../src/renderer/stores/feature-flags-store.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../src/shared/payments/types.js';

/**
 * 023 V5 sale lifecycle — after `payments.confirm` succeeds, the renderer
 * payment projection must carry the authoritative settled attempt (re-read
 * through the existing `payments.read`), so a surface reopened later can tell
 * the sale was paid. A failed re-read records nothing: no fabricated settle.
 */

const ENVELOPE: PaymentIntentEnvelope = {
  envelope_version: 'v1',
  cart_id: 'cart-001',
  operator_session_id: 'sess-001',
  owning_operator_id: 'op-001',
  tenant_id: 'tenant-001',
  branch_id: 'branch-001',
  terminal_id: 'terminal-001',
  lines: [],
  discount_placeholders: [],
  subtotal_minor: 2500,
  created_at: '2026-09-24T12:00:00.000Z',
  handoff_action_id: 'handoff-001',
};

function view(state: PaymentAttemptRendererView['state']): PaymentAttemptRendererView {
  return {
    payment_attempt_id: 'pa-1',
    state,
    envelope_subtotal_minor: 2500,
    started_at: '2026-09-24T12:00:01.000Z',
    ...(state === 'settled' ? { settled_at: '2026-09-24T12:00:09.000Z' } : {}),
    tender_lines: [
      {
        tender_line_id: 'tl-1',
        tender_type: 'cash',
        amount_applied_minor: 2500,
        state: 'applied',
        apply_order: 1,
        applied_at: '2026-09-24T12:00:02.000Z',
      },
    ],
  };
}

function bridge(read: ReturnType<typeof vi.fn>): Parameters<typeof PaymentSurface>[0] {
  return {
    _testBridge: {
      payments: {
        start: vi.fn(),
        confirm: vi.fn(() =>
          Promise.resolve({ kind: 'ok' as const, settled_at: '2026-09-24T12:00:09.000Z' }),
        ),
        cancel: vi.fn(),
        read,
        subscribe: vi.fn(),
      },
      tender: { apply: vi.fn(), reverse: vi.fn(), read: vi.fn() },
    } as unknown as NonNullable<Parameters<typeof PaymentSurface>[0]>['_testBridge'],
  };
}

beforeEach(() => {
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'session-uuid',
        operator_id: 'op-uuid',
        display_name: 'Test Operator',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-09-24T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(ENVELOPE);
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
});

async function confirmFullyTendered(read: ReturnType<typeof vi.fn>): Promise<void> {
  render(<PaymentSurface {...bridge(read)} />);
  // Seeded after render: the mount effect clears any earlier attempt.
  usePaymentStore.getState().applyAttemptSnapshot(view('started'));
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('payment-surface-confirm'));
  await screen.findByTestId('payment-surface-settled');
}

describe('PaymentSurface records the settled attempt in the payment projection', () => {
  it('re-reads the attempt after confirm and stores the authoritative settled view', async () => {
    const read = vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, payment_attempt: view('settled') }),
    );
    await confirmFullyTendered(read);
    await waitFor(() => {
      expect(usePaymentStore.getState().paymentSlice?.state).toBe('settled');
    });
    expect(read).toHaveBeenCalledWith({ payment_attempt_id: 'pa-1' });
    expect(usePaymentStore.getState().envelope?.cart_id).toBe('cart-001');
  });

  it('records nothing new when the re-read is refused, and stays on the settled surface', async () => {
    const read = vi.fn(() => Promise.resolve({ kind: 'refused' as const, reason: 'no_session' }));
    await confirmFullyTendered(read);
    await waitFor(() => {
      expect(read).toHaveBeenCalled();
    });
    expect(usePaymentStore.getState().paymentSlice?.state).toBe('started');
    expect(screen.getByTestId('payment-surface-settled')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('records nothing new when the re-read transport rejects, and stays settled', async () => {
    const read = vi.fn(() => Promise.reject(new Error('ipc down')));
    await confirmFullyTendered(read);
    await waitFor(() => {
      expect(read).toHaveBeenCalled();
    });
    expect(usePaymentStore.getState().paymentSlice?.state).toBe('started');
    expect(screen.getByTestId('payment-surface-settled')).toBeInTheDocument();
  });
});
