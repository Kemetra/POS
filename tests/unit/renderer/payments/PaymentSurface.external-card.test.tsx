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
 * Coverage regression — PaymentSurface external_card_terminal apply path.
 *
 * Closes a function-coverage gap on PaymentSurface.tsx: the two inline
 * lambdas passed to <ExternalCardTerminalEntry> (lines 354 + 355,
 * `tenderApply` callback + `onApplied` callback) were created by the
 * existing split-tender test but never invoked because no test submitted
 * the external-card entry at the PaymentSurface level.
 *
 * This test fills the external_card_terminal flow end-to-end:
 *   1. Render PaymentSurface with a signed-in operator session.
 *   2. Click tender-external-card → entry mounts.
 *   3. Default amount equals subtotal (exact) — submit the confirm button.
 *   4. Assert `bridge.tender.apply` was called (line 354 lambda invoked).
 *   5. Assert `payments.read` was called again post-apply (line 355 lambda
 *      → handleLineApplied → re-read).
 *
 * The split-tender invariant (sum of applied lines == envelope.subtotal_minor)
 * is exercised here at the simplest path: a single external-card line that
 * covers the full subtotal so the surface advances to the confirm-visible
 * state, matching the cash analogue in PaymentSurface.split-tender.test.tsx.
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
  subtotal_minor: 1000,
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
    envelope_subtotal_minor: 1000,
    started_at: '2026-05-23T12:00:01.000Z',
    tender_lines: lines,
  };
}

interface MakeBridgeOverrides {
  payments?: Partial<PaymentsBridgeAPI>;
  tender?: Partial<TenderBridgeAPI>;
}

function makeBridge(o: MakeBridgeOverrides = {}): {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
} {
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
      vi.fn<(req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>>(),
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

describe('PaymentSurface — external_card_terminal apply path (coverage)', () => {
  it('invokes bridge.tender.apply and re-reads the attempt when the external-card entry is submitted', async () => {
    const user = userEvent.setup();

    // Read sequence: initial (no lines) → post-apply (one external_card_terminal line at 1000).
    // The PaymentSurface re-reads after a successful apply (handleLineApplied), and we want
    // the running sum to equal the subtotal so the confirm button surfaces — mirroring the
    // cash analogue in PaymentSurface.split-tender.test.tsx ("running sum hits the subtotal").
    const readSequence = [
      makeAttemptView('started'),
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-1',
          tender_type: 'external_card_terminal',
          amount_applied_minor: 1000,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-05-23T12:00:02.000Z',
        },
      ]),
    ];
    let readCall = 0;
    const read = vi.fn<(req: PaymentsReadRequest) => Promise<PaymentsReadResponse>>(async () => {
      const snap = readSequence[Math.min(readCall, readSequence.length - 1)];
      readCall++;
      if (snap === undefined) {
        return await Promise.resolve({ kind: 'refused', reason: 'internal_error' });
      }
      return await Promise.resolve({ kind: 'ok', payment_attempt: snap });
    });

    const apply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      async () =>
        await Promise.resolve({
          kind: 'ok',
          tender_line_id: 'tl-1',
          applied_at: '2026-05-23T12:00:02.000Z',
        }),
    );

    const bridge = makeBridge({ payments: { read }, tender: { apply } });

    render(<PaymentSurface _testBridge={bridge} />);

    // 1. Select external_card_terminal — this is where PaymentSurface.tsx creates
    //    the inline `tenderApply` and `onApplied` lambdas (lines 354 + 355).
    await user.click(screen.getByTestId('tender-external-card'));

    // 2. The entry mounts. It records exactly remainingBalanceMinor (1000), so the
    //    confirm button is enabled without further input — reference is optional.
    await screen.findByTestId('external-card-terminal-entry');
    expect(screen.getByTestId('external-card-amount-value')).toHaveTextContent('10.00 EGP');

    // 3. Submit the entry. This invokes the line-354 lambda (tenderApply prop).
    await user.click(screen.getByTestId('external-card-confirm'));

    // 4. Assert bridge.tender.apply was called with the expected shape — proves the
    //    line-354 inline lambda `(req) => bridge.tender.apply(req)` executed.
    await waitFor(() => {
      expect(apply).toHaveBeenCalledTimes(1);
    });
    const applyCallArg = apply.mock.calls[0]?.[0];
    expect(applyCallArg).toBeDefined();
    expect(applyCallArg).toMatchObject({
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 1000,
    });
    expect(typeof applyCallArg?.idempotency_key).toBe('string');

    // 5. Assert payments.read was called again post-apply — proves the line-355 inline
    //    lambda `() => { void handleLineApplied(); }` executed. The initial mount triggers
    //    one read; the post-apply re-read brings the call count to at least 2.
    await waitFor(() => {
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    // 6. Sanity: with the running sum == subtotal, the confirm button surfaces (matches
    //    the cash analogue). This is the same observable side effect of handleLineApplied
    //    succeeding and refreshing the attempt view.
    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-confirm')).toBeInTheDocument();
    });
  });
});
