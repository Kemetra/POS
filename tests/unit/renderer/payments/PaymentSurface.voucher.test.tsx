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
 * Wave 5c — PaymentSurface internal_voucher coverage regression.
 *
 * Closes the branch-coverage gap PR #226 opened: Wave 5c added a new
 * `selectedTender === 'internal_voucher'` branch to PaymentSurface
 * (Slice-1 status banner + bridged-mode dispatch to <VoucherEntry>).
 * Existing PaymentSurface tests only exercise cash + external-card
 * paths, leaving the voucher branches uncovered.
 *
 * Coverage targets (PaymentSurface.tsx):
 *   • Line ~336 — Slice-1 status-banner ternary: "Voucher selected".
 *   • Lines ~360-369 — bridged-mode VoucherEntry mount path
 *     (inline tenderApply + onApplied lambdas analogous to the
 *     external-card-terminal lambdas covered in
 *     PaymentSurface.external-card.test.tsx).
 *
 * Mirrors PaymentSurface.external-card.test.tsx structure to keep
 * the precedent consistent.
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

describe('PaymentSurface — internal_voucher (Wave 5c coverage)', () => {
  it('Slice-1 mode: renders the voucher tender-selected status banner on voucher tender pick', async () => {
    // No bridge → Slice-1 status-banner mode. Covers line ~336 ternary
    // third branch ('تم اختيار القسيمة').
    const user = userEvent.setup();
    render(<PaymentSurface />);
    await user.click(screen.getByTestId('tender-voucher'));
    const banner = await screen.findByTestId('payment-surface-tender-selected');
    expect(banner).toHaveTextContent('تم اختيار القسيمة');
  });

  it('bridged mode: clicking the voucher tender mounts <VoucherEntry>', async () => {
    // With a bridge, the entry phase mounts the per-tender entry
    // component. Covers the new `selectedTender === 'internal_voucher'`
    // dispatch branch added by Wave 5c.
    const user = userEvent.setup();
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-voucher'));
    await screen.findByTestId('voucher-entry');
    expect(screen.getByTestId('voucher-entry-remaining')).toBeInTheDocument();
    expect(screen.getByTestId('voucher-entry-code-input')).toBeInTheDocument();
    expect(screen.getByTestId('voucher-entry-amount-input')).toBeInTheDocument();
  });

  it('bridged mode: VoucherEntry submit invokes bridge.tender.apply with internal_voucher shape + re-reads', async () => {
    // Closes the inline-lambda branches at the voucher dispatch site
    // (analogous to PaymentSurface.external-card.test.tsx — cash and
    // external-card already covered; voucher gets the same treatment).
    const user = userEvent.setup();
    const readSequence = [
      makeAttemptView('started'),
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-voucher-1',
          tender_type: 'internal_voucher',
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
          tender_line_id: 'tl-voucher-1',
          applied_at: '2026-05-23T12:00:02.000Z',
        }),
    );
    const bridge = makeBridge({ payments: { read }, tender: { apply } });
    render(<PaymentSurface _testBridge={bridge} />);

    await user.click(screen.getByTestId('tender-voucher'));
    await screen.findByTestId('voucher-entry');
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '10.00');
    await user.click(screen.getByTestId('voucher-entry-confirm'));

    // 1. bridge.tender.apply was called with voucher shape — proves the
    //    PaymentSurface inline `tenderApply` lambda for the voucher
    //    branch executed.
    await waitFor(() => {
      expect(apply).toHaveBeenCalledTimes(1);
    });
    const applyCallArg = apply.mock.calls[0]?.[0];
    expect(applyCallArg).toMatchObject({
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1000,
      voucher_code: 'VOUCHER10',
    });

    // 2. payments.read was called again post-apply — proves the
    //    `onApplied` → handleLineApplied lambda executed.
    await waitFor(() => {
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
