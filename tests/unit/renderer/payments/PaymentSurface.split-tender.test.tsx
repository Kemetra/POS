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
 * T154 — PaymentSurface split-tender UX (RED → GREEN).
 *
 * Behaviour under test:
 *   1. First entry receives remainingBalanceMinor = envelope.subtotal_minor.
 *   2. After a tender.apply success where the running sum is still less than
 *      the subtotal, the surface returns to tender selection so the cashier
 *      may pick another tender for the remainder.
 *   3. The second entry receives remainingBalanceMinor = subtotal -
 *      sum(applied lines so far).
 *   4. When the running sum equals the subtotal, the surface stays in the
 *      entry view long enough for the cashier to click Confirm — the
 *      confirm button is visible because hasAppliedLine is true.
 *
 * The split-tender invariant (sum of applied lines == envelope.subtotal_minor
 * before confirm) is enforced in the main process; the renderer just keeps
 * the cashier on a valid path.
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

describe('PaymentSurface — split-tender UX (T154)', () => {
  it('first cash entry receives the full subtotal as remaining balance', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-cash'));

    const entry = await screen.findByTestId('cash-entry');
    expect(entry).toBeInTheDocument();
    /*
     * RETARGETED by 022 Phase C — the T154 invariant is unchanged.
     *
     * This asserted the remaining balance via CashEntry's own amount-due card.
     * `PaymentSurface` now owns the single amount-due presentation (FR-16), so
     * the same engine-supplied number is read from the surface panel instead.
     * What is being proven is identical: the FIRST cash entry is handed the
     * full subtotal as its remaining balance.
     *
     * The expected STRING changes because the surface formats money through
     * `shared/money.format` ("10.00 EGP") whereas the removed v3.5 card used a
     * local `¤` placeholder helper. Same value, correct presentation — the
     * surface's is the one the product actually ships.
     */
    const remaining = screen.getByTestId('payment-surface-amount-due');
    expect(remaining).toHaveTextContent('10.00');
  });

  it('returns to tender selection after a partial-sum apply (remaining > 0)', async () => {
    const user = userEvent.setup();
    // Sequence: payments.start ok → payments.read (initial, started, no lines)
    // → tender.apply ok → payments.read (started, one applied line of 400)
    const readSequence = [
      makeAttemptView('started'),
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
          amount_applied_minor: 400,
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
      return await Promise.resolve({
        kind: 'ok',
        payment_attempt: snap,
      });
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
    await user.click(screen.getByTestId('tender-cash'));
    await user.type(await screen.findByTestId('cash-entry-amount-input'), '400');
    await user.click(screen.getByTestId('cash-entry-confirm'));

    // Surface should drop back to tender selection because remaining (600) > 0.
    await waitFor(() => {
      expect(screen.queryByTestId('cash-entry')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('tender-selection')).toBeInTheDocument();
  });

  it('second tender entry shows the remaining balance (subtotal - sum applied)', async () => {
    const user = userEvent.setup();
    const readSequence = [
      makeAttemptView('started'),
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
          amount_applied_minor: 400,
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
    await user.click(screen.getByTestId('tender-cash'));
    await user.type(await screen.findByTestId('cash-entry-amount-input'), '400');
    await user.click(screen.getByTestId('cash-entry-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('cash-entry')).not.toBeInTheDocument();
    });

    // Cashier picks the external card terminal for the remainder.
    await user.click(screen.getByTestId('tender-external-card'));
    const entry = await screen.findByTestId('external-card-terminal-entry');
    expect(entry).toBeInTheDocument();
    const amountInput = screen.getByTestId('external-card-amount-input');
    // Default amount = remaining balance for external_card_terminal.
    expect((amountInput as HTMLInputElement).value).toBe('6.00');
  });

  it('stays in the entry view (and shows confirm) when the running sum hits the subtotal exactly', async () => {
    const user = userEvent.setup();
    const readSequence = [
      makeAttemptView('started'),
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
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
    await user.click(screen.getByTestId('tender-cash'));
    await user.type(await screen.findByTestId('cash-entry-amount-input'), '1000');
    await user.click(screen.getByTestId('cash-entry-confirm'));

    // Running sum = subtotal → no return to tender selection. Confirm button visible.
    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-confirm')).toBeInTheDocument();
    });
  });

  it('does not re-call payments.start when the second tender is picked', async () => {
    // Regression — main-process FSM refuses payments.start when an attempt is
    // already started on the terminal (R-10). The split-tender flow must skip
    // payments.start on the second tender selection.
    const user = userEvent.setup();
    const readSequence = [
      makeAttemptView('started'),
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
          amount_applied_minor: 400,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-05-23T12:00:02.000Z',
        },
      ]),
    ];
    let readCall = 0;
    const start = vi.fn<(req: PaymentsStartRequest) => Promise<PaymentsStartResponse>>(
      async () => await Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-1' }),
    );
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
    const bridge = makeBridge({ payments: { start, read }, tender: { apply } });

    render(<PaymentSurface _testBridge={bridge} />);

    // First tender selection: payments.start fires once.
    await user.click(screen.getByTestId('tender-cash'));
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    await user.type(await screen.findByTestId('cash-entry-amount-input'), '400');
    await user.click(screen.getByTestId('cash-entry-confirm'));

    // Split-tender returns to tender selection. Cashier picks the second tender.
    await waitFor(() => {
      expect(screen.queryByTestId('cash-entry')).not.toBeInTheDocument();
    });
    await user.click(screen.getByTestId('tender-external-card'));

    // Second tender entry mounts WITHOUT a second payments.start call.
    await screen.findByTestId('external-card-terminal-entry');
    expect(start).toHaveBeenCalledTimes(1);
  });
});
