import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { PaymentSurface } from '../../../../src/renderer/ui/payments/PaymentSurface.js';
import { useOperatorSessionStore } from '../../../../src/renderer/stores/operator-session-store.js';
import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';
import type {
  PaymentsBridgeAPI,
  PaymentsCancelRequest,
  PaymentsCancelResponse,
  PaymentsConfirmRequest,
  PaymentsConfirmResponse,
  PaymentsReadRequest,
  PaymentsReadResponse,
  PaymentsStartRequest,
  PaymentsStartResponse,
  TenderApplyRequest,
  TenderApplyResponse,
  TenderBridgeAPI,
  TenderReadRequest,
  TenderReadResponse,
  TenderReverseRequest,
  TenderReverseResponse,
} from '../../../../src/shared/bridge-api.js';
import type { PaymentAttemptRendererView } from '../../../../src/shared/payments/types.js';

/**
 * T153 — PaymentSurface payments.cancel wiring (RED → GREEN).
 *
 * Behaviour under test:
 *   1. Cancel button visible during the entry phase (after payments.start).
 *   2. Click → payments.cancel({payment_attempt_id, idempotency_key}).
 *   3. On { kind: 'ok', reversed_tender_line_ids, reversal_pending_tender_line_ids }:
 *      • Surface returns to tender selection (AD-4).
 *      • If reversal_pending_tender_line_ids is non-empty, render a
 *        "Some reversals are pending" hint. Renderer copy ready now per
 *        tasks.md row 338; Slice 4's voucher path will produce non-empty
 *        arrays at runtime.
 *   4. On refusal, render generic copy.
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
      quantity: 2,
      unit_price_minor: 150,
      line_subtotal_minor: 300,
      note: null,
      version: 1,
      last_action_id: 'action-1',
    },
  ],
  discount_placeholders: [],
  subtotal_minor: 300,
  created_at: '2026-05-23T12:00:00.000Z',
  handoff_action_id: 'handoff-001',
};

function setSignedIn(): void {
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
        started_at: '2026-05-23T08:00:00.000Z',
      },
    },
  });
}

function makeAttemptView(
  state: PaymentAttemptRendererView['state'],
  lines: PaymentAttemptRendererView['tender_lines'] = [],
): PaymentAttemptRendererView {
  return {
    payment_attempt_id: 'pa-1',
    state,
    envelope_subtotal_minor: 300,
    started_at: '2026-05-23T12:00:01.000Z',
    tender_lines: lines,
  };
}

function makeBridge(
  o: {
    payments?: Partial<PaymentsBridgeAPI>;
    tender?: Partial<TenderBridgeAPI>;
  } = {},
): { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI } {
  const payments: PaymentsBridgeAPI = {
    start:
      o.payments?.start ??
      vi.fn<(req: PaymentsStartRequest) => Promise<PaymentsStartResponse>>(
        async () => await Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-1' }),
      ),
    confirm:
      o.payments?.confirm ??
      vi.fn<(req: PaymentsConfirmRequest) => Promise<PaymentsConfirmResponse>>(),
    cancel:
      o.payments?.cancel ??
      vi.fn<(req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>>(
        async () =>
          await Promise.resolve({
            kind: 'ok',
            cancelled_at: '2026-05-23T12:00:09.000Z',
            reversed_tender_line_ids: [],
            reversal_pending_tender_line_ids: [],
          }),
      ),
    subscribe:
      o.payments?.subscribe ?? vi.fn<(req: PaymentsReadRequest) => Promise<PaymentsReadResponse>>(),
    read:
      o.payments?.read ??
      vi.fn<(req: PaymentsReadRequest) => Promise<PaymentsReadResponse>>(
        async () =>
          await Promise.resolve({
            kind: 'ok',
            payment_attempt: makeAttemptView('started'),
          }),
      ),
  };
  const tender: TenderBridgeAPI = {
    apply: o.tender?.apply ?? vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(),
    reverse:
      o.tender?.reverse ?? vi.fn<(req: TenderReverseRequest) => Promise<TenderReverseResponse>>(),
    read: o.tender?.read ?? vi.fn<(req: TenderReadRequest) => Promise<TenderReadResponse>>(),
  };
  return { payments, tender };
}

beforeEach(() => {
  setSignedIn();
  usePaymentStore.getState().reset();
  usePaymentStore.getState().mount(ENVELOPE);
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
});

describe('PaymentSurface — payments.cancel wiring (T153)', () => {
  it('cancel button is visible during the entry phase', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);

    await user.click(screen.getByTestId('tender-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-cancel')).toBeInTheDocument();
    });
  });

  it('cancel button is NOT visible before tender selection (no attempt started)', () => {
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    expect(screen.queryByTestId('payment-surface-cancel')).not.toBeInTheDocument();
  });

  it('calls payments.cancel with the attempt id + fresh idempotency_key on click', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn<(req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>>(
      async () =>
        await Promise.resolve({
          kind: 'ok',
          cancelled_at: '2026-05-23T12:00:09.000Z',
          reversed_tender_line_ids: [],
          reversal_pending_tender_line_ids: [],
        }),
    );
    const bridge = makeBridge({ payments: { cancel } });

    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-cancel')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('payment-surface-cancel'));

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledTimes(1);
    });
    const req = cancel.mock.calls[0]?.[0];
    expect(req?.payment_attempt_id).toBe('pa-1');
    expect(typeof req?.idempotency_key).toBe('string');
    expect((req?.idempotency_key ?? '').length).toBeGreaterThan(10);
  });

  it('returns to tender selection after cancel ok (AD-4)', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('cash-entry')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('payment-surface-cancel'));

    await waitFor(() => {
      // Entry component unmounted; tender selection visible.
      expect(screen.queryByTestId('cash-entry')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('tender-selection')).toBeInTheDocument();
  });

  it('renders "Some reversals are pending" hint when the response includes pending ids', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn<(req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>>(
      async () =>
        await Promise.resolve({
          kind: 'ok',
          cancelled_at: '2026-05-23T12:00:09.000Z',
          reversed_tender_line_ids: ['tl-1'],
          reversal_pending_tender_line_ids: ['tl-2'],
        }),
    );
    const bridge = makeBridge({ payments: { cancel } });

    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-cancel')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('payment-surface-cancel'));

    const hint = await screen.findByTestId('payment-surface-reversal-pending-hint');
    expect(hint).toHaveTextContent(/some reversals are pending/i);
    // Token-minimisation: the actual ids (tl-1, tl-2) NEVER appear in the DOM.
    expect(hint.textContent).not.toMatch(/tl-1|tl-2/);
  });

  it('does NOT render the reversal-pending hint when the response has no pending ids', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn<(req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>>(
      async () =>
        await Promise.resolve({
          kind: 'ok',
          cancelled_at: '2026-05-23T12:00:09.000Z',
          reversed_tender_line_ids: ['tl-1'],
          reversal_pending_tender_line_ids: [],
        }),
    );
    const bridge = makeBridge({ payments: { cancel } });

    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-cancel')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('payment-surface-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('cash-entry')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('payment-surface-reversal-pending-hint')).not.toBeInTheDocument();
  });

  it('renders generic refusal copy on cancel refused', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn<(req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>>(
      async () => await Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' }),
    );
    const bridge = makeBridge({ payments: { cancel } });

    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-cancel')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('payment-surface-cancel'));

    const refusal = await screen.findByTestId('payment-surface-bridge-refusal');
    expect(refusal).toHaveTextContent(/تعذّر إلغاء|يرجى المحاولة/);
    expect(refusal.textContent).not.toMatch(/attempt_terminal/);
  });
});
