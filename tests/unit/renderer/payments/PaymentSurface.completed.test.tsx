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
  PaymentsConfirmRequest,
  PaymentsConfirmResponse,
  PaymentsReadRequest,
  PaymentsReadResponse,
  PaymentsStartRequest,
  PaymentsStartResponse,
  SalesBridgeAPI,
  SalesSubscribeRequest,
  SalesSubscribeResponse,
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
 * P0 cashier-flow blocker — settled-phase dead-end fix.
 *
 * Before this fix the settled phase rendered a static "Payment settled."
 * banner with NO downstream affordance: the cashier could not start the next
 * sale (invariant 14: never stuck after payment succeeds) and never saw the
 * finalized sale's number (invariant 13: completed/receipt-ready state shown).
 *
 * The sale finalizes automatically in the main process (~200ms after confirm
 * via the AD-2 polling worker); `payments.confirm` itself returns only
 * `settled_at`, no sale id/number. The renderer therefore POLLS
 * `sales.subscribe({ topic: 'recent' })` (a snapshot poll, live when the
 * banner-state projector is wired) for the terminal's most-recently-finalized
 * sale to surface the sale number, and offers a "New sale" action that resets
 * the stores and navigates back to the cart (delegated to the route owner so
 * PaymentSurface stays Router-agnostic, mirroring onPaymentContinue).
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
      unit_price_minor: 1250,
      line_subtotal_minor: 2500,
      note: null,
      version: 1,
      last_action_id: 'action-1',
    },
  ],
  discount_placeholders: [],
  subtotal_minor: 2500,
  created_at: '2026-06-11T12:00:00.000Z',
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
        started_at: '2026-06-11T08:00:00.000Z',
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
    envelope_subtotal_minor: 2500,
    started_at: '2026-06-11T12:00:01.000Z',
    tender_lines: lines,
    ...(state === 'settled' ? { settled_at: '2026-06-11T12:00:09.000Z' } : {}),
  };
}

const APPLIED_EXACT = makeAttemptView('started', [
  {
    tender_line_id: 'tl-1',
    tender_type: 'cash' as const,
    amount_applied_minor: 2500,
    state: 'applied' as const,
    apply_order: 1,
    applied_at: '2026-06-11T12:00:02.000Z',
  },
]);

interface MakeBridgeOverrides {
  payments?: Partial<PaymentsBridgeAPI>;
  tender?: Partial<TenderBridgeAPI>;
  sales?: Partial<SalesBridgeAPI>;
}

function makeBridge(o: MakeBridgeOverrides = {}): {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  sales: SalesBridgeAPI;
} {
  const payments: PaymentsBridgeAPI = {
    start:
      o.payments?.start ??
      vi.fn<(req: PaymentsStartRequest) => Promise<PaymentsStartResponse>>(
        async () => await Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-1' }),
      ),
    confirm:
      o.payments?.confirm ??
      vi.fn<(req: PaymentsConfirmRequest) => Promise<PaymentsConfirmResponse>>(
        async () => await Promise.resolve({ kind: 'ok', settled_at: '2026-06-11T12:00:09.000Z' }),
      ),
    cancel: o.payments?.cancel ?? vi.fn(),
    subscribe: o.payments?.subscribe ?? vi.fn(),
    read:
      o.payments?.read ??
      vi.fn<(req: PaymentsReadRequest) => Promise<PaymentsReadResponse>>(
        async () =>
          await Promise.resolve({ kind: 'ok', payment_attempt: makeAttemptView('started') }),
      ),
  } as PaymentsBridgeAPI;
  const tender: TenderBridgeAPI = {
    apply: o.tender?.apply ?? vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(),
    reverse:
      o.tender?.reverse ?? vi.fn<(req: TenderReverseRequest) => Promise<TenderReverseResponse>>(),
    read: o.tender?.read ?? vi.fn<(req: TenderReadRequest) => Promise<TenderReadResponse>>(),
  };
  const sales: SalesBridgeAPI = {
    read: o.sales?.read ?? vi.fn(),
    findByNumber: o.sales?.findByNumber ?? vi.fn(),
    subscribe:
      o.sales?.subscribe ??
      vi.fn<(req: SalesSubscribeRequest) => Promise<SalesSubscribeResponse>>(
        async () =>
          await Promise.resolve({
            kind: 'ok',
            subscription_token: 'sub-1',
            recent: {
              sale_id: 'sale-uuid-1',
              sale_number: 'C1-20260611-0007',
              finalized_at: '2026-06-11T12:00:09.500Z',
            },
          }),
      ),
    unsubscribe: o.sales?.unsubscribe ?? vi.fn(async () => await Promise.resolve({ kind: 'ok' })),
  } as SalesBridgeAPI;
  return { payments, tender, sales };
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

describe('PaymentSurface — settled completion (P0 dead-end fix)', () => {
  it('shows a "New sale" button after confirm settles (invariant 14: never stuck)', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();

    render(<PaymentSurface _testBridge={bridge} />);
    usePaymentStore.getState().applyAttemptSnapshot(APPLIED_EXACT);

    await user.click(await screen.findByTestId('payment-surface-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-settled')).toBeInTheDocument();
    });
    expect(screen.getByTestId('payment-surface-new-sale')).toBeInTheDocument();
  });

  it('invokes onNewSale when the cashier clicks "New sale"', async () => {
    const user = userEvent.setup();
    const onNewSale = vi.fn();
    const bridge = makeBridge();

    render(<PaymentSurface _testBridge={bridge} onNewSale={onNewSale} />);
    usePaymentStore.getState().applyAttemptSnapshot(APPLIED_EXACT);

    await user.click(await screen.findByTestId('payment-surface-confirm'));
    await user.click(await screen.findByTestId('payment-surface-new-sale'));

    expect(onNewSale).toHaveBeenCalledTimes(1);
  });

  /**
   * 022 SUPERSEDES 006 INVARIANT 13 — recorded here rather than deleted, so
   * the removal of a shipped behaviour stays auditable.
   *
   * Invariant 13 asserted the completion surface shows the finalized sale
   * number, polled from `sales.subscribe({topic:'recent'})`. External review
   * (rounds 1-3) established that this terminal-wide row cannot be tied to
   * THIS payment: `RecentSaleSummary` carries no attempt/handoff identifier
   * and `payments.confirm` returns only `settled_at`, so `finalized_at >=
   * settled_at` is the only available test — and a PRIOR sale finalizing late
   * satisfies it, surfacing another customer's reference.
   *
   * A wrong cashier-quotable number is worse than none, so the poll and the
   * number are both removed. This is a DELIBERATE REDUCTION below `main`,
   * accepted on safety grounds. It reverts when the projection carries a
   * correlating identifier (011 derives one from `envelope_handoff_action_id`),
   * at which point invariant 13, T013a and T017 all unblock together.
   */
  it('022: does NOT show a sale number, and does not poll for one (supersedes invariant 13)', async () => {
    const user = userEvent.setup();
    const subscribe = vi.fn<(req: SalesSubscribeRequest) => Promise<SalesSubscribeResponse>>(
      async () =>
        await Promise.resolve({
          kind: 'ok',
          subscription_token: 'sub-1',
          recent: {
            sale_id: 'sale-uuid-1',
            sale_number: 'C1-20260611-0007',
            finalized_at: '2026-06-11T12:00:09.500Z',
          },
        }),
    );
    const bridge = makeBridge({ sales: { subscribe } });

    render(<PaymentSurface _testBridge={bridge} />);
    usePaymentStore.getState().applyAttemptSnapshot(APPLIED_EXACT);

    await user.click(await screen.findByTestId('payment-surface-confirm'));

    // Settled surface renders, but the uncorrelatable number never appears...
    await screen.findByTestId('payment-surface-settled');
    expect(screen.queryByTestId('payment-surface-sale-number')).not.toBeInTheDocument();
    // ...and nothing polls for it: no unbounded window for a late prior sale.
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('022: a stale prior-sale recent snapshot cannot reach the surface at all', async () => {
    // Timing reality: the AD-2 worker finalizes THIS sale ~200ms AFTER confirm,
    // so the first `recent` poll can return the PREVIOUS sale (finalized_at
    // before this attempt's settled_at). Showing that number would be wrong.
    // The surface must reject any recent whose finalized_at predates settled_at
    // and keep polling until THIS sale lands.
    const user = userEvent.setup();
    const STALE = {
      kind: 'ok' as const,
      subscription_token: 'sub-1',
      recent: {
        sale_id: 'sale-prev',
        sale_number: 'C1-20260611-0006', // the PRIOR sale
        finalized_at: '2026-06-11T12:00:08.000Z', // BEFORE settled_at 12:00:09.000
      },
    };
    const FRESH = {
      kind: 'ok' as const,
      subscription_token: 'sub-1',
      recent: {
        sale_id: 'sale-this',
        sale_number: 'C1-20260611-0007', // THIS sale
        finalized_at: '2026-06-11T12:00:09.500Z', // AFTER settled_at
      },
    };
    const subscribe = vi
      .fn<(req: SalesSubscribeRequest) => Promise<SalesSubscribeResponse>>()
      .mockResolvedValueOnce(STALE)
      .mockResolvedValue(FRESH);
    const bridge = makeBridge({ sales: { subscribe } });

    render(<PaymentSurface _testBridge={bridge} />);
    usePaymentStore.getState().applyAttemptSnapshot(APPLIED_EXACT);

    await user.click(await screen.findByTestId('payment-surface-confirm'));

    // 022: neither number reaches the surface. The original test proved the
    // STALE one was filtered by timestamp — but that filter is exactly what
    // review showed to be insufficient (a prior sale finalizing late passes
    // it). With the poll removed, no `recent` row can surface at all, which
    // is strictly stronger than filtering.
    await screen.findByTestId('payment-surface-settled');
    expect(screen.queryByTestId('payment-surface-sale-number')).not.toBeInTheDocument();
    const surface = screen.getByTestId('payment-surface');
    expect(surface).not.toHaveTextContent('C1-20260611-0007');
    expect(surface).not.toHaveTextContent('C1-20260611-0006');
  });

  it('still shows the completed state + New sale when sales.subscribe refuses (graceful)', async () => {
    const user = userEvent.setup();
    const subscribe = vi.fn<(req: SalesSubscribeRequest) => Promise<SalesSubscribeResponse>>(
      async () => await Promise.resolve({ kind: 'refused', reason: 'no_session' }),
    );
    const bridge = makeBridge({ sales: { subscribe } });

    render(<PaymentSurface _testBridge={bridge} />);
    usePaymentStore.getState().applyAttemptSnapshot(APPLIED_EXACT);

    await user.click(await screen.findByTestId('payment-surface-confirm'));

    // Dead-end is still gone even when the sale-number poll yields nothing.
    expect(await screen.findByTestId('payment-surface-settled')).toBeInTheDocument();
    expect(screen.getByTestId('payment-surface-new-sale')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-sale-number')).not.toBeInTheDocument();
  });
});
