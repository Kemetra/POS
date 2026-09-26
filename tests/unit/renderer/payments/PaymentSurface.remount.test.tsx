import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { PaymentSurface } from '../../../../src/renderer/ui/payments/PaymentSurface.js';
import { useOperatorSessionStore } from '../../../../src/renderer/stores/operator-session-store.js';
import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../src/shared/bridge-api.js';
import type { PaymentAttemptRendererView } from '../../../../src/shared/payments/types.js';

/**
 * Codex P1 on #476. Leaving checkout (the Sale nav entry) and coming back
 * remounts PaymentSurface. Its mount effect cleared the renderer's attempt
 * unconditionally, while main still held the `started` attempt: V5 sign-out
 * (blocked only while the renderer knows of a started attempt) re-enabled, and
 * picking a tender re-ran `payments.start`, which main refuses for a terminal
 * that already has a started attempt. The attempt must survive a remount for
 * the SAME handoff, and still clear for a different one.
 */

const ENVELOPE: PaymentIntentEnvelope = {
  envelope_version: 'v1',
  cart_id: 'cart-001',
  operator_session_id: 'sess-001',
  owning_operator_id: 'op-001',
  tenant_id: 'tenant-001',
  branch_id: 'branch-001',
  terminal_id: 'terminal-001',
  lines: [
    {
      line_id: 'line-1',
      item_ref: 'SKU-001',
      display_name: 'Paracetamol 500mg',
      quantity: 1,
      unit_price_minor: 1000,
      line_subtotal_minor: 1000,
      note: null,
      version: 1,
      last_action_id: 'action-1',
    },
  ],
  discount_placeholders: [],
  subtotal_minor: 1000,
  created_at: '2026-09-26T12:00:00.000Z',
  handoff_action_id: 'handoff-001',
};

const STARTED: PaymentAttemptRendererView = {
  payment_attempt_id: 'pa-1',
  state: 'started',
  envelope_subtotal_minor: 1000,
  started_at: '2026-09-26T12:00:01.000Z',
  tender_lines: [],
};

function bridge(start = vi.fn(() => Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-2' }))): {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
} {
  return {
    payments: {
      start,
      confirm: vi.fn(),
      cancel: vi.fn(),
      subscribe: vi.fn(),
      read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt: STARTED })),
    } as unknown as PaymentsBridgeAPI,
    tender: { apply: vi.fn(), reverse: vi.fn(), read: vi.fn() },
  };
}

beforeEach(() => {
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
        started_at: '2026-09-26T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().reset();
  usePaymentStore.getState().mount(ENVELOPE);
  usePaymentStore.getState().applyAttemptSnapshot(STARTED);
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
});

describe('PaymentSurface — remount keeps a started attempt for the same handoff', () => {
  it('a remount for the same handoff keeps the started attempt', () => {
    const first = render(<PaymentSurface _testBridge={bridge()} />);
    first.unmount();
    render(<PaymentSurface _testBridge={bridge()} />);
    expect(usePaymentStore.getState().paymentSlice).toEqual(STARTED);
  });

  it('after a remount, choosing a tender continues the attempt instead of starting another', async () => {
    const start = vi.fn(() => Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-2' }));
    const b = bridge(start);
    const first = render(<PaymentSurface _testBridge={b} />);
    first.unmount();
    render(<PaymentSurface _testBridge={b} />);
    await userEvent.setup().click(screen.getByTestId('tender-cash'));
    expect(await screen.findByTestId('cash-entry')).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
  });

  it('a different handoff still clears the attempt', () => {
    usePaymentStore.getState().mount({ ...ENVELOPE, handoff_action_id: 'handoff-002' });
    render(<PaymentSurface _testBridge={bridge()} />);
    expect(usePaymentStore.getState().paymentSlice).toBeNull();
  });

  it('a remount of a settled sale restores the settled screen, not tender selection', () => {
    usePaymentStore.getState().applyAttemptSnapshot({
      ...STARTED,
      state: 'settled',
      settled_at: '2026-09-26T12:00:05.000Z',
    });
    const first = render(<PaymentSurface _testBridge={bridge()} />);
    first.unmount();
    render(<PaymentSurface _testBridge={bridge()} />);
    expect(screen.getByTestId('payment-surface-settled')).toBeInTheDocument();
    expect(screen.queryByTestId('tender-cash')).not.toBeInTheDocument();
  });

  it.each(['cancelled', 'failed', 'force_failed'] as const)(
    'a remount clears a %s attempt (nothing to resume)',
    (state) => {
      usePaymentStore.getState().applyAttemptSnapshot({ ...STARTED, state });
      render(<PaymentSurface _testBridge={bridge()} />);
      expect(usePaymentStore.getState().paymentSlice).toBeNull();
    },
  );

  it('records the started attempt as soon as payments.start succeeds, before the read lands', async () => {
    usePaymentStore.getState().clearAttempt();
    const b = bridge();
    (b.payments as unknown as { read: unknown }).read = vi.fn(() =>
      Promise.reject(new Error('read failed')),
    );
    render(<PaymentSurface _testBridge={b} />);
    await userEvent.setup().click(screen.getByTestId('tender-cash'));
    await waitFor(() => {
      expect(usePaymentStore.getState().paymentSlice).toEqual(
        expect.objectContaining({ payment_attempt_id: 'pa-2', state: 'started' }),
      );
    });
  });
});
