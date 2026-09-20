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
 * T152 — PaymentSurface payments.confirm wiring (RED → GREEN).
 *
 * Flow under test:
 *   1. Cashier selects a tender (e.g. cash).
 *   2. Surface calls payments.start with the envelope; receives
 *      payment_attempt_id.
 *   3. Entry component mounts with the bridge wiring (T151 props).
 *   4. Cashier confirms a tender line; surface calls payments.read to
 *      refresh the snapshot.
 *   5. When the snapshot has at least one applied line, a "Confirm
 *      payment" button is shown.
 *   6. Click → calls payments.confirm; on { kind: 'ok' } surface
 *      transitions to a "Payment settled" placeholder (FR-031). On
 *      refusal, renders generic copy.
 *
 * The bridge is injected via the `_testBridge` prop (same pattern as
 * CartPane / cart-pane-live-lines.test.tsx).
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
    ...(state === 'settled' ? { settled_at: '2026-05-23T12:00:09.000Z' } : {}),
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

describe('PaymentSurface — payments.start on tender selection (T152)', () => {
  it('calls payments.start with envelope fields when cashier picks cash', async () => {
    const user = userEvent.setup();
    const start = vi.fn<(req: PaymentsStartRequest) => Promise<PaymentsStartResponse>>(
      async () => await Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-1' }),
    );
    const bridge = makeBridge({ payments: { start } });

    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-cash'));

    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    const req = start.mock.calls[0]?.[0];
    expect(req?.envelope_cart_id).toBe('cart-001');
    expect(req?.envelope_handoff_action_id).toBe('handoff-001');
    expect(req?.envelope_subtotal_minor).toBe(300);
    expect(req?.envelope_version).toBe('v1');
    expect(typeof req?.idempotency_key).toBe('string');
    expect((req?.idempotency_key ?? '').length).toBeGreaterThan(10);
  });

  it('mounts CashEntry after payments.start returns ok', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-cash'));

    await waitFor(() => {
      expect(screen.getByTestId('cash-entry')).toBeInTheDocument();
    });
  });

  it('renders generic refusal copy when payments.start refuses', async () => {
    const user = userEvent.setup();
    const start = vi.fn<(req: PaymentsStartRequest) => Promise<PaymentsStartResponse>>(
      async () => await Promise.resolve({ kind: 'refused', reason: 'cart_lost' }),
    );
    const bridge = makeBridge({ payments: { start } });

    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-cash'));

    const refusal = await screen.findByTestId('payment-surface-bridge-refusal');
    expect(refusal).toHaveTextContent(/تعذّر بدء|يرجى المحاولة/);
    expect(refusal.textContent).not.toMatch(/cart_lost/);
  });
});

describe('PaymentSurface — payments.confirm button (T152)', () => {
  it('shows the confirm button once paymentSlice has an applied line', async () => {
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);

    // Directly seed the store with a started attempt + one applied line.
    usePaymentStore.getState().applyAttemptSnapshot(
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
          amount_applied_minor: 300,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-05-23T12:00:02.000Z',
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-confirm')).toBeInTheDocument();
    });
  });

  it('does NOT show the confirm button when no lines are applied', () => {
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    usePaymentStore.getState().applyAttemptSnapshot(makeAttemptView('started', []));
    expect(screen.queryByTestId('payment-surface-confirm')).not.toBeInTheDocument();
  });

  it('calls payments.confirm with the attempt id + fresh idempotency_key on click', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn<(req: PaymentsConfirmRequest) => Promise<PaymentsConfirmResponse>>(
      async () => await Promise.resolve({ kind: 'ok', settled_at: '2026-05-23T12:00:09.000Z' }),
    );
    const bridge = makeBridge({ payments: { confirm } });

    render(<PaymentSurface _testBridge={bridge} />);
    usePaymentStore.getState().applyAttemptSnapshot(
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
          amount_applied_minor: 300,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-05-23T12:00:02.000Z',
        },
      ]),
    );

    await user.click(await screen.findByTestId('payment-surface-confirm'));

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
    });
    const req = confirm.mock.calls[0]?.[0];
    expect(req?.payment_attempt_id).toBe('pa-1');
    expect(typeof req?.idempotency_key).toBe('string');
    expect((req?.idempotency_key ?? '').length).toBeGreaterThan(10);
  });

  it('transitions to a settled placeholder after confirm ok (FR-031)', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn<(req: PaymentsConfirmRequest) => Promise<PaymentsConfirmResponse>>(
      async () => await Promise.resolve({ kind: 'ok', settled_at: '2026-05-23T12:00:09.000Z' }),
    );
    const bridge = makeBridge({ payments: { confirm } });

    render(<PaymentSurface _testBridge={bridge} />);
    usePaymentStore.getState().applyAttemptSnapshot(
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
          amount_applied_minor: 300,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-05-23T12:00:02.000Z',
        },
      ]),
    );

    await user.click(await screen.findByTestId('payment-surface-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-settled')).toBeInTheDocument();
    });
  });

  it('renders generic refusal copy on confirm refused', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn<(req: PaymentsConfirmRequest) => Promise<PaymentsConfirmResponse>>(
      async () => await Promise.resolve({ kind: 'refused', reason: 'tender_underpaid' }),
    );
    const bridge = makeBridge({ payments: { confirm } });

    render(<PaymentSurface _testBridge={bridge} />);
    usePaymentStore.getState().applyAttemptSnapshot(
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
          amount_applied_minor: 200,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-05-23T12:00:02.000Z',
        },
      ]),
    );

    await user.click(await screen.findByTestId('payment-surface-confirm'));

    const refusal = await screen.findByTestId('payment-surface-bridge-refusal');
    expect(refusal).toHaveTextContent(/تعذّر إتمام|يرجى المحاولة/);
    expect(refusal.textContent).not.toMatch(/tender_underpaid/);
  });

  // Regression / behaviour-lock (2026-06-19): during a live smoke a settle click
  // was mislabelled an "onClick no-op". Root cause was NOT a wiring bug — the
  // click DID fire payments.confirm; the GUI carried a STALE attempt id from a
  // prior session (after a roster-401 re-sign-in), and the main process correctly
  // refused it with `wrong_owner` (the ownership guard doing its job). This test
  // locks in that the click reaches the bridge AND the correct-guard refusal is
  // surfaced as generic copy — so the behaviour is never "fixed" away as a bug,
  // and the wiring (click → payments.confirm) stays proven on this path too.
  it('fires payments.confirm on click and shows generic copy when the attempt is wrong_owner (stale-session guard, NOT a no-op)', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn<(req: PaymentsConfirmRequest) => Promise<PaymentsConfirmResponse>>(
      async () => await Promise.resolve({ kind: 'refused', reason: 'wrong_owner' }),
    );
    const bridge = makeBridge({ payments: { confirm } });

    render(<PaymentSurface _testBridge={bridge} />);
    usePaymentStore.getState().applyAttemptSnapshot(
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-1',
          tender_type: 'cash',
          amount_applied_minor: 300,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-05-23T12:00:02.000Z',
        },
      ]),
    );

    await user.click(await screen.findByTestId('payment-surface-confirm'));

    // The click DID fire the bridge (the disproof of "onClick no-op").
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
    });
    expect(confirm.mock.calls[0]?.[0]?.payment_attempt_id).toBe('pa-1');

    // The correct-guard refusal surfaces as generic copy; the structured reason
    // never enters the DOM (FR-005). Surface stays on the payment phase (NOT
    // settled) so the cashier can start a fresh sale.
    const refusal = await screen.findByTestId('payment-surface-bridge-refusal');
    expect(refusal).toHaveTextContent(/تعذّر إتمام|يرجى المحاولة/);
    expect(refusal.textContent).not.toMatch(/wrong_owner/);
    expect(screen.queryByTestId('payment-surface-settled')).not.toBeInTheDocument();
  });
});

describe('PaymentSurface — backwards compatibility (no _testBridge)', () => {
  it('renders tender selection without any bridge calls (Slice-1 mode)', () => {
    render(<PaymentSurface />);
    expect(screen.getByTestId('tender-selection')).toBeInTheDocument();
  });

  it('cashier may click tender buttons without any bridge call', async () => {
    const user = userEvent.setup();
    render(<PaymentSurface />);
    await user.click(screen.getByTestId('tender-cash'));
    // Slice-1 behaviour: status banner appears, no bridge wiring.
    expect(screen.getByTestId('payment-surface-tender-selected')).toBeInTheDocument();
  });
});
