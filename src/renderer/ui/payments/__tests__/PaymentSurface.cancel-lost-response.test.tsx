/**
 * RT-298 — `payments.cancel` lost-response recovery.
 *
 * Main commits the cancel before it emits the audits, so the renderer can lose
 * the answer to a cancel that did happen. A retry must replay the SAME
 * idempotency key (main then rebuilds the original result), and after an
 * ambiguous cancel the surface reads the attempt before any payment action is
 * offered again, classifying a card reversal from main's durable lines (M-P13).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type {
  PaymentAttemptRendererView,
  TenderLineRendererView,
} from '../../../../shared/payments/types.js';
import type {
  PaymentsBridgeAPI,
  PaymentsCancelRequest,
  PaymentsCancelResponse,
  PaymentsReadResponse,
  TenderBridgeAPI,
} from '../../../../shared/bridge-api.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { PaymentSurface } from '../PaymentSurface.js';

const CARD_VOID = 'أُلغي الدفع هنا فقط. ألغِ العملية على جهاز البطاقات قبل أي خصم جديد.';
const CASH_REVERSED = 'أُلغي المبلغ المسجَّل. اختر طريقة دفع أخرى أو ألغِ البيع.';
const CANCEL_FAILED = 'تعذّر إلغاء عملية الدفع. اضغط «إلغاء» للمحاولة مرة أخرى.';
const CANCEL_UNKNOWN =
  'تعذّر التأكد من إلغاء عملية الدفع. لا تسجّل أي مبلغ. اضغط «إلغاء» مرة أخرى للتحقق.';
const CANCEL_NOT_OPEN = 'لم تعد عملية الدفع هذه مفتوحة، فلا يمكن إلغاؤها.';
const CANCEL_LIVE_TENDER =
  'أوقف المدير عملية الدفع هذه وفيها مبالغ مسجّلة، فلا يمكن الدفع لهذا البيع الآن. اطلب من المدير مراجعتها.';
const GENERIC_RETRY = 'يرجى المحاولة مرة أخرى';

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
  subtotal_minor: 5000,
  created_at: '2026-10-07T09:00:00.000Z',
  handoff_action_id: 'hid-001',
};

type LineState = TenderLineRendererView['state'];
type TenderType = TenderLineRendererView['tender_type'];

function line(
  id: string,
  type: TenderType,
  state: LineState,
  order: number,
): TenderLineRendererView {
  return {
    tender_line_id: id,
    tender_type: type,
    state,
    amount_applied_minor: 2500,
    applied_at: '2026-10-07T09:59:30.000Z',
    apply_order: order,
  };
}

function attempt(
  state: PaymentAttemptRendererView['state'],
  lines: readonly TenderLineRendererView[],
): PaymentAttemptRendererView {
  return {
    payment_attempt_id: 'pa-001',
    state,
    envelope_subtotal_minor: 5000,
    started_at: '2026-10-07T09:59:00.000Z',
    tender_lines: lines,
  };
}

const CANCEL_OK: PaymentsCancelResponse = {
  kind: 'ok',
  cancelled_at: '2026-10-07T10:00:00.000Z',
  reversed_tender_line_ids: ['tl-card'],
  reversal_pending_tender_line_ids: [],
};

const LOST = (): Promise<never> => Promise.reject(new Error('response lost'));
const READ_ERROR: PaymentsReadResponse = { kind: 'refused', reason: 'internal_error' };

interface Script {
  readonly cancel: readonly (() => Promise<PaymentsCancelResponse>)[];
  readonly read: (() => Promise<PaymentsReadResponse>) | undefined;
}

function makeBridge(): {
  bridge: { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI };
  cancel: ReturnType<typeof vi.fn<(req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>>>;
  script: (s: Script) => void;
} {
  let current: Script = { cancel: [], read: undefined };
  let cancelCalls = 0;
  const cancel = vi.fn<(req: PaymentsCancelRequest) => Promise<PaymentsCancelResponse>>(() => {
    const step = current.cancel[Math.min(cancelCalls, current.cancel.length - 1)];
    cancelCalls += 1;
    return step === undefined ? LOST() : step();
  });
  const read = vi.fn(() =>
    current.read === undefined ? Promise.resolve(READ_ERROR) : current.read(),
  );
  const bridge = {
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
      read,
      confirm: vi.fn(),
      cancel,
    } as unknown as PaymentsBridgeAPI,
    tender: { apply: vi.fn() } as unknown as TenderBridgeAPI,
  };
  return {
    bridge,
    cancel,
    script: (s) => {
      current = s;
      cancelCalls = 0;
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** Opens the cash entry (where Cancel lives) on an attempt holding `lines`. */
async function openWith(
  bridge: ReturnType<typeof makeBridge>['bridge'],
  lines: readonly TenderLineRendererView[],
): Promise<void> {
  render(
    <PaymentSurface
      _testBridge={bridge}
      onBackToSale={() => Promise.resolve(true)}
      onNewSale={vi.fn()}
    />,
  );
  await act(async () => {
    screen.getByTestId('tender-cash').click();
    await Promise.resolve();
  });
  await settle();
  act(() => {
    usePaymentStore.getState().applyAttemptSnapshot(attempt('started', lines));
  });
}

/** Leaves Checkout and comes back to the same sale (the store keeps its state). */
async function remount(bridge: ReturnType<typeof makeBridge>['bridge']): Promise<void> {
  cleanup();
  render(
    <PaymentSurface
      _testBridge={bridge}
      onBackToSale={() => Promise.resolve(true)}
      onNewSale={vi.fn()}
    />,
  );
  await settle();
}

async function clickCancel(): Promise<void> {
  fireEvent.click(screen.getByTestId('payment-surface-cancel'), { detail: 1 });
  await settle();
}

const CARD_APPLIED = [line('tl-card', 'external_card_terminal', 'applied', 1)];
const CASH_APPLIED = [line('tl-cash', 'cash', 'applied', 1)];

function keys(cancel: ReturnType<typeof makeBridge>['cancel']): string[] {
  return cancel.mock.calls.map(([req]) => req.idempotency_key);
}

beforeEach(() => {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'sess-001',
        operator_id: 'op-001',
        display_name: 'أحمد',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-10-07T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(ENVELOPE);
  useFeatureFlagsStore.getState().hydrate({
    cart: true,
    payments: true,
    saleFinalization: true,
    productSearch: true,
  });
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
});

describe('RT-298 — cancel retry replays the same idempotency key', () => {
  it('cancel commits, the response and the read are lost, the retry replays the key and M-P13 appears', async () => {
    const { bridge, cancel, script } = makeBridge();
    await openWith(bridge, CARD_APPLIED);
    script({ cancel: [LOST, () => Promise.resolve(CANCEL_OK)], read: undefined });

    await clickCancel();
    // Outcome unknown: no new amount and no settle until Cancel again resolves it.
    expect(screen.getByTestId('payment-surface-bridge-refusal')).toHaveTextContent(CANCEL_UNKNOWN);
    expect(screen.queryByTestId('payment-surface-entry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-confirm')).not.toBeInTheDocument();

    await clickCancel();
    const [first, second] = keys(cancel);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);
    expect(screen.queryByTestId('payment-surface-bridge-refusal')).not.toBeInTheDocument();
    expect(usePaymentStore.getState().paymentSlice).toBeNull();
  });

  it('Escape cannot close the panel away from the Cancel the unknown-outcome line names (Codex P2)', async () => {
    const { bridge, script } = makeBridge();
    await openWith(bridge, CARD_APPLIED);
    script({ cancel: [LOST], read: undefined });

    await clickCancel();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await settle();
    expect(screen.getByTestId('payment-surface-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('payment-surface-bridge-refusal')).toHaveTextContent(CANCEL_UNKNOWN);
  });

  it('a tender click while the outcome is unknown keeps the Cancel instruction (Codex P2)', async () => {
    const { bridge, script } = makeBridge();
    await openWith(bridge, CARD_APPLIED);
    script({ cancel: [LOST], read: undefined });

    await clickCancel();
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByTestId('payment-surface-bridge-refusal')).toHaveTextContent(CANCEL_UNKNOWN);
    expect(screen.getByTestId('payment-surface-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-entry')).not.toBeInTheDocument();
  });

  it('a refused cancel on a still-open attempt names the retry, and the retry reuses the key', async () => {
    const { bridge, cancel, script } = makeBridge();
    await openWith(bridge, CASH_APPLIED);
    script({
      cancel: [() => Promise.resolve({ kind: 'refused', reason: 'internal_error' })],
      read: () =>
        Promise.resolve({ kind: 'ok', payment_attempt: attempt('started', CASH_APPLIED) }),
    });

    await clickCancel();
    const refusal = screen.getByTestId('payment-surface-bridge-refusal');
    expect(refusal).toHaveTextContent(CANCEL_FAILED);
    expect(refusal).not.toHaveTextContent(GENERIC_RETRY);
    // The attempt is open in main: payment actions come back.
    expect(screen.getByTestId('payment-surface-entry')).toBeInTheDocument();

    await clickCancel();
    expect(new Set(keys(cancel)).size).toBe(1);
  });

  it('a new attempt gets a new key', async () => {
    const { bridge, cancel, script } = makeBridge();
    await openWith(bridge, CASH_APPLIED);
    script({ cancel: [LOST], read: undefined });
    await clickCancel();
    const firstKey = keys(cancel)[0];

    act(() => {
      usePaymentStore.getState().applyAttemptSnapshot({
        ...attempt('started', CASH_APPLIED),
        payment_attempt_id: 'pa-002',
      });
    });
    await clickCancel();
    expect(keys(cancel)[1]).not.toBe(firstKey);
  });
});

describe('RT-298 — an ambiguous cancel is reconciled from payments.read', () => {
  it('cancel throws, the read shows the attempt cancelled: the UI reflects it without a second cancel', async () => {
    const { bridge, cancel, script } = makeBridge();
    await openWith(bridge, CARD_APPLIED);
    script({
      cancel: [LOST],
      read: () =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: attempt('cancelled', [
            line('tl-card', 'external_card_terminal', 'reversed', 1),
          ]),
        }),
    });

    await clickCancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);
    expect(screen.queryByTestId('payment-surface-cancel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-bridge-refusal')).not.toBeInTheDocument();
    expect(usePaymentStore.getState().paymentSlice).toBeNull();
  });

  it('a card line main reversed is classified from the read even when the projection never saw it', async () => {
    const { bridge, script } = makeBridge();
    await openWith(bridge, []);
    script({
      cancel: [() => Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' })],
      read: () =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: attempt('cancelled', [
            line('tl-cash', 'cash', 'reversed', 1),
            line('tl-card', 'external_card_terminal', 'reversed', 2),
          ]),
        }),
    });

    await clickCancel();
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);
  });

  it('cash path: a read-back cancel proves the reversal (M-P2), no card line', async () => {
    const { bridge, cancel, script } = makeBridge();
    await openWith(bridge, CASH_APPLIED);
    script({
      cancel: [LOST],
      read: () =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: attempt('cancelled', [line('tl-cash', 'cash', 'reversed', 1)]),
        }),
    });

    await clickCancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    const reason = await screen.findByTestId('payment-surface-back-blocked');
    expect(reason).toHaveTextContent(CASH_REVERSED);
    expect(reason).not.toHaveTextContent(CARD_VOID);
  });

  it('a pending reversal read back keeps the pending hint', async () => {
    const { bridge, script } = makeBridge();
    await openWith(bridge, CASH_APPLIED);
    script({
      cancel: [LOST],
      read: () =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: attempt('cancelled', [
            line('tl-cash', 'cash', 'reversed', 1),
            line('tl-v', 'internal_voucher', 'reversal_pending', 2),
          ]),
        }),
    });

    await clickCancel();
    expect(screen.getByTestId('payment-surface-reversal-pending-hint')).toBeInTheDocument();
  });

  it('a settled attempt read back shows the settled screen and no retry', async () => {
    const { bridge, script } = makeBridge();
    await openWith(bridge, CASH_APPLIED);
    script({
      cancel: [() => Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' })],
      read: () =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: {
            ...attempt('settled', CASH_APPLIED),
            settled_at: '2026-10-07T10:00:00.000Z',
          },
        }),
    });

    await clickCancel();
    expect(await screen.findByTestId('payment-surface-settled')).toBeInTheDocument();
    expect(usePaymentStore.getState().paymentSlice?.state).toBe('settled');
  });

  it('a force-failed attempt after a card apply is dropped, says it is no longer open, and warns to void', async () => {
    const { bridge, script } = makeBridge();
    await openWith(bridge, []);
    act(() => {
      usePaymentStore.getState().recordCardApplyAttempted();
    });
    script({
      cancel: [() => Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' })],
      read: () =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: {
            ...attempt('force_failed', []),
            force_failed_at: '2026-10-07T10:00:00.000Z',
          },
        }),
    });

    await clickCancel();
    const refusal = screen.getByTestId('payment-surface-bridge-refusal');
    expect(refusal).toHaveTextContent(CANCEL_NOT_OPEN);
    expect(refusal).not.toHaveTextContent(GENERIC_RETRY);
    expect(usePaymentStore.getState().paymentSlice).toBeNull();
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);
  });

  it('a force-failed attempt that still holds live tender stays visible, closes payment, and asks for a manager (Codex P1)', async () => {
    const { bridge, script } = makeBridge();
    const live = [line('tl-card', 'external_card_terminal', 'applied', 1)];
    await openWith(bridge, live);
    script({
      cancel: [() => Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' })],
      read: () =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: {
            ...attempt('force_failed', live),
            force_failed_at: '2026-10-07T10:00:00.000Z',
          },
        }),
    });

    await clickCancel();
    // Main refuses any new payments.start for this cart: never offer one.
    expect(usePaymentStore.getState().paymentSlice?.state).toBe('force_failed');
    expect(screen.getByTestId('payment-surface-bridge-refusal')).toHaveTextContent(
      CANCEL_LIVE_TENDER,
    );
    expect(screen.queryByTestId('payment-surface-entry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-confirm')).not.toBeInTheDocument();
    // The card may still stand on the terminal.
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);

    // Choosing a tender does not reopen an entry on the ended attempt.
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await settle();
    expect(screen.queryByTestId('payment-surface-entry')).not.toBeInTheDocument();
    const start = (bridge.payments as unknown as { start: { mock: { calls: unknown[] } } }).start;
    expect(start.mock.calls).toHaveLength(1);
  });

  it('a failed attempt with no card is dropped without the void warning', async () => {
    const { bridge, script } = makeBridge();
    await openWith(bridge, CASH_APPLIED);
    script({
      cancel: [LOST],
      read: () =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: {
            ...attempt('failed', CASH_APPLIED),
            failed_at: '2026-10-07T10:00:00.000Z',
          },
        }),
    });

    await clickCancel();
    expect(usePaymentStore.getState().paymentSlice).toBeNull();
    expect(usePaymentStore.getState().cardSafety?.voidRequired ?? false).toBe(false);
    expect(screen.queryByTestId('payment-surface-cancel')).not.toBeInTheDocument();
  });

  it('a read that lands after the sale moved on is not applied', async () => {
    const { bridge, script } = makeBridge();
    await openWith(bridge, CARD_APPLIED);
    let answer: (r: PaymentsReadResponse) => void = () => undefined;
    script({
      cancel: [LOST],
      read: () =>
        new Promise<PaymentsReadResponse>((resolve) => {
          answer = resolve;
        }),
    });

    await clickCancel();
    act(() => {
      usePaymentStore.getState().mount({ ...ENVELOPE, handoff_action_id: 'hid-002' });
    });
    await act(async () => {
      answer({
        kind: 'ok',
        payment_attempt: attempt('cancelled', [
          line('tl-card', 'external_card_terminal', 'reversed', 1),
        ]),
      });
      await Promise.resolve();
    });
    await settle();
    expect(usePaymentStore.getState().cardSafety?.voidRequired ?? false).toBe(false);
  });
});

describe('RT-298 — cancel recovery survives leaving Checkout (Codex P2, #576)', () => {
  it('an unconfirmed cancel comes back held, and the retry still replays the original key', async () => {
    const { bridge, cancel, script } = makeBridge();
    await openWith(bridge, CARD_APPLIED);
    script({ cancel: [LOST, () => Promise.resolve(CANCEL_OK)], read: undefined });
    await clickCancel();

    await remount(bridge);
    expect(screen.getByTestId('payment-surface-bridge-refusal')).toHaveTextContent(CANCEL_UNKNOWN);
    expect(screen.queryByTestId('payment-surface-entry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-confirm')).not.toBeInTheDocument();

    await clickCancel();
    const [first, second] = keys(cancel);
    expect(second).toBe(first);
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);
    expect(usePaymentStore.getState().cancelRecovery).toBeNull();
  });

  it('a force-failed attempt with live tender stays held after a remount', async () => {
    const { bridge, script } = makeBridge();
    const live = [line('tl-cash', 'cash', 'applied', 1)];
    await openWith(bridge, live);
    script({
      cancel: [() => Promise.resolve({ kind: 'refused', reason: 'attempt_terminal' })],
      read: () =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: {
            ...attempt('force_failed', live),
            force_failed_at: '2026-10-07T10:00:00.000Z',
          },
        }),
    });
    await clickCancel();

    await remount(bridge);
    expect(usePaymentStore.getState().paymentSlice?.state).toBe('force_failed');
    expect(screen.getByTestId('payment-surface-bridge-refusal')).toHaveTextContent(
      CANCEL_LIVE_TENDER,
    );
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await settle();
    const start = (bridge.payments as unknown as { start: { mock: { calls: unknown[] } } }).start;
    expect(start.mock.calls).toHaveLength(1);
    expect(screen.queryByTestId('payment-surface-entry')).not.toBeInTheDocument();
  });

  it('a recovery recorded for another attempt does not hold this one', async () => {
    const { bridge, script } = makeBridge();
    await openWith(bridge, CASH_APPLIED);
    script({ cancel: [LOST], read: undefined });
    await clickCancel();
    act(() => {
      usePaymentStore.getState().applyAttemptSnapshot({
        ...attempt('started', CASH_APPLIED),
        payment_attempt_id: 'pa-002',
      });
    });

    await remount(bridge);
    expect(screen.queryByTestId('payment-surface-bridge-refusal')).not.toBeInTheDocument();
  });
});
