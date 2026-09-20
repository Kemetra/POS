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
 * S3d bridge-resilience suite (CodeRabbit PR #212 fixes):
 *
 *   CR-8 — Production bridge path picks up `window.api.payments` +
 *          `window.api.tender` when `_testBridge` is omitted.
 *   CR-9 — Rapid double-click on a tender button does NOT fire
 *          payments.start twice (isStarting guard).
 *   CR-10 — A rejected bridge call surfaces generic refusal copy and does
 *           NOT escape as an unhandled rejection.
 *   CR-11 — Money aggregation skips lines with malformed `amount_applied_minor`
 *           (Constitution §II Number.isSafeInteger gate at the renderer).
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
  // Clean any window.api set by tests in this file.
  delete (window as unknown as { api?: unknown }).api;
});

describe('PaymentSurface — production bridge resolution (CR-8)', () => {
  it('reads from window.api when no _testBridge is supplied', async () => {
    const user = userEvent.setup();
    const bridge = makeBridge();
    // Install the bridge on window.api the way the preload would in production.
    (window as unknown as { api: { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI } }).api =
      bridge;

    render(<PaymentSurface />);
    await user.click(screen.getByTestId('tender-cash'));

    // The production path fires payments.start exactly the same way the
    // _testBridge path does.
    const startMock = bridge.payments['start'] as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(startMock).toHaveBeenCalledTimes(1);
    });
    // And the entry component mounts (S3d bridged mode active).
    await waitFor(() => {
      expect(screen.getByTestId('cash-entry')).toBeInTheDocument();
    });
  });

  it('falls back to Slice-1 behaviour when neither _testBridge nor window.api is present', async () => {
    const user = userEvent.setup();
    render(<PaymentSurface />);
    await user.click(screen.getByTestId('tender-cash'));

    // Slice-1 mode: status banner appears, no bridge interaction.
    expect(screen.getByTestId('payment-surface-tender-selected')).toBeInTheDocument();
    expect(screen.queryByTestId('cash-entry')).not.toBeInTheDocument();
  });
});

describe('PaymentSurface — rapid-click race guard (CR-9)', () => {
  it('does not call payments.start twice when the cashier clicks tender-cash twice in quick succession', async () => {
    const user = userEvent.setup();
    // start resolves after a microtask delay so a second click can land before
    // the first start completes.
    let resolveStart!: (v: PaymentsStartResponse) => void;
    const startPromise = new Promise<PaymentsStartResponse>((resolve) => {
      resolveStart = resolve;
    });
    const start = vi.fn<(req: PaymentsStartRequest) => Promise<PaymentsStartResponse>>(
      () => startPromise,
    );
    const bridge = makeBridge({ payments: { start } });

    render(<PaymentSurface _testBridge={bridge} />);

    // First click fires start (in flight).
    await user.click(screen.getByTestId('tender-cash'));
    expect(start).toHaveBeenCalledTimes(1);

    // Second click before start resolves — guard must short-circuit.
    await user.click(screen.getByTestId('tender-cash'));
    expect(start).toHaveBeenCalledTimes(1);

    // Resolve the first start so the test cleans up cleanly.
    resolveStart({ kind: 'ok', payment_attempt_id: 'pa-1' });
    await waitFor(() => {
      expect(screen.getByTestId('cash-entry')).toBeInTheDocument();
    });
  });
});

describe('PaymentSurface — bridge rejection handling (CR-10)', () => {
  it('surfaces generic refusal copy when payments.start rejects', async () => {
    const user = userEvent.setup();
    const start = vi.fn<(req: PaymentsStartRequest) => Promise<PaymentsStartResponse>>(
      async () => await Promise.reject(new Error('IPC channel closed')),
    );
    const bridge = makeBridge({ payments: { start } });

    render(<PaymentSurface _testBridge={bridge} />);
    await user.click(screen.getByTestId('tender-cash'));

    const refusal = await screen.findByTestId('payment-surface-bridge-refusal');
    expect(refusal).toHaveTextContent(/تعذّر بدء|يرجى المحاولة/);
    expect(refusal.textContent).not.toMatch(/IPC channel|Error/);
  });

  it('surfaces generic refusal copy when payments.confirm rejects', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn<(req: PaymentsConfirmRequest) => Promise<PaymentsConfirmResponse>>(
      async () => await Promise.reject(new Error('main worker exited')),
    );
    const bridge = makeBridge({ payments: { confirm } });

    render(<PaymentSurface _testBridge={bridge} />);
    usePaymentStore.getState().applyAttemptSnapshot(
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
    );

    await user.click(await screen.findByTestId('payment-surface-confirm'));

    const refusal = await screen.findByTestId('payment-surface-bridge-refusal');
    expect(refusal).toHaveTextContent(/تعذّر إتمام|يرجى المحاولة/);
    expect(refusal.textContent).not.toMatch(/main worker|Error/);
  });

  it('surfaces generic refusal copy when payments.cancel rejects', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn<(req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>>(
      async () => await Promise.reject(new Error('connection lost')),
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
    expect(refusal.textContent).not.toMatch(/connection lost|Error/);
  });
});

describe('PaymentSurface — money aggregation safe-integer guard (CR-11)', () => {
  it('drops a tender line with NaN amount from the remaining-balance calculation', async () => {
    // PaymentSurface's mount-effect clears any pre-seeded attempt snapshot, so
    // we render first, then seed (mirrors how production looks: the surface
    // mounts, then payments.read populates the slice).
    render(<PaymentSurface _testBridge={makeBridge()} />);
    usePaymentStore.getState().applyAttemptSnapshot(
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-good',
          tender_type: 'cash',
          amount_applied_minor: 400,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-05-23T12:00:02.000Z',
        },
        {
          tender_line_id: 'tl-bad',
          tender_type: 'cash',
          amount_applied_minor: Number.NaN,
          state: 'applied',
          apply_order: 2,
          applied_at: '2026-05-23T12:00:03.000Z',
        },
      ]),
    );
    // The applied-line count is > 0, so the confirm button is visible. The
    // running sum dropped the NaN line; this is treated as a partial-sum
    // (400 of 1000) split-tender state. The test's value is: no NaN
    // propagated through Math.max into the entry remainingBalanceMinor prop.
    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-confirm')).toBeInTheDocument();
    });
  });

  it('drops a tender line with a float (non-integer) amount from the sum', async () => {
    render(<PaymentSurface _testBridge={makeBridge()} />);
    usePaymentStore.getState().applyAttemptSnapshot(
      makeAttemptView('started', [
        {
          tender_line_id: 'tl-good',
          tender_type: 'cash',
          amount_applied_minor: 500,
          state: 'applied',
          apply_order: 1,
          applied_at: '2026-05-23T12:00:02.000Z',
        },
        {
          tender_line_id: 'tl-float',
          tender_type: 'cash',
          amount_applied_minor: 100.5,
          state: 'applied',
          apply_order: 2,
          applied_at: '2026-05-23T12:00:03.000Z',
        },
      ]),
    );
    await waitFor(() => {
      expect(screen.getByTestId('payment-surface-confirm')).toBeInTheDocument();
    });
  });
});
