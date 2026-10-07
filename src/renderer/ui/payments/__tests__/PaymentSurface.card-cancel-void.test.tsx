/**
 * RT-256 — after a cancel that reversed an external-card line, the cashier is
 * told to void on the card terminal before any new charge (catalog M-P13).
 *
 * `payments.cancel` reverses the card line locally only; it cannot void the
 * charge on the standalone terminal (`manual_void_required`, FR-008). The old
 * neutral line «… أكمل الدفع أو ألغِه.» invited a second charge while the first
 * one may still stand (VNext Constitution Rebaseline, M-P1 amendment).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../shared/payments/types.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { PaymentSurface } from '../PaymentSurface.js';

const CARD_VOID = 'أُلغي الدفع هنا فقط. ألغِ العملية على جهاز البطاقات قبل أي خصم جديد.';
const COMPLETE_OR_CANCEL = 'أكمل الدفع أو ألغِه';
const CASH_REVERSED = 'أُلغي المبلغ المسجَّل. اختر طريقة دفع أخرى أو ألغِ البيع.';

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

type TenderType = PaymentAttemptRendererView['tender_lines'][number]['tender_type'];

function attemptWith(lines: readonly { id: string; type: TenderType; amount: number }[]) {
  const view: PaymentAttemptRendererView = {
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: 5000,
    started_at: '2026-10-07T09:59:00.000Z',
    tender_lines: lines.map((l, i) => ({
      tender_line_id: l.id,
      tender_type: l.type,
      state: 'applied',
      amount_applied_minor: l.amount,
      applied_at: '2026-10-07T09:59:30.000Z',
      apply_order: i + 1,
    })),
  };
  return view;
}

function makeBridge(cancel: { reversed: readonly string[]; pending?: readonly string[] }): {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
} {
  return {
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
      read: vi.fn(() => Promise.resolve({ kind: 'error' as const })),
      confirm: vi.fn(),
      cancel: vi.fn(() =>
        Promise.resolve({
          kind: 'ok' as const,
          cancelled_at: '2026-10-07T10:00:00.000Z',
          reversed_tender_line_ids: cancel.reversed,
          reversal_pending_tender_line_ids: cancel.pending ?? [],
        }),
      ),
    } as unknown as PaymentsBridgeAPI,
    tender: { apply: vi.fn() } as unknown as TenderBridgeAPI,
  };
}

/** Opens the cash entry (phase `entry`, where Cancel lives), seeds the lines, then cancels. */
async function cancelWithLines(
  lines: readonly { id: string; type: TenderType; amount: number }[],
  reversed: readonly string[],
): Promise<void> {
  render(
    <PaymentSurface
      _testBridge={makeBridge({ reversed })}
      onBackToSale={() => Promise.resolve(true)}
      onNewSale={vi.fn()}
    />,
  );
  await act(async () => {
    screen.getByTestId('tender-cash').click();
    await Promise.resolve();
  });
  act(() => {
    usePaymentStore.getState().applyAttemptSnapshot(attemptWith(lines));
  });
  await act(async () => {
    screen.getByTestId('payment-surface-cancel').click();
    await Promise.resolve();
    await Promise.resolve();
  });
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

describe('RT-256 — card cancel requires a terminal void before another charge (M-P13)', () => {
  it('after a card line is reversed, says to void on the terminal and never «أكمل الدفع أو ألغِه»', async () => {
    await cancelWithLines(
      [{ id: 'tl-card', type: 'external_card_terminal', amount: 5000 }],
      ['tl-card'],
    );
    const reason = await screen.findByTestId('payment-surface-back-blocked');
    expect(reason).toHaveTextContent(CARD_VOID);
    expect(screen.getByTestId('payment-surface')).not.toHaveTextContent(COMPLETE_OR_CANCEL);
    // Catalog tone `danger` (Codex P2): not the muted Back explanation style.
    expect(reason).toHaveClass('payment-surface__back-blocked--danger');
    expect(reason).toHaveAttribute('data-tone', 'danger');
  });

  it('a mixed cash + card cancel still gets the terminal-void line (the card may stand)', async () => {
    await cancelWithLines(
      [
        { id: 'tl-cash', type: 'cash', amount: 2000 },
        { id: 'tl-card', type: 'external_card_terminal', amount: 3000 },
      ],
      ['tl-card', 'tl-cash'],
    );
    const reason = await screen.findByTestId('payment-surface-back-blocked');
    expect(reason).toHaveTextContent(CARD_VOID);
    expect(reason).not.toHaveTextContent(CASH_REVERSED);
  });

  it('stays on a later cash-only cancel in the same Checkout (the card may still stand)', async () => {
    const cancel = vi.fn();
    cancel
      .mockResolvedValueOnce({
        kind: 'ok',
        cancelled_at: '2026-10-07T10:00:00.000Z',
        reversed_tender_line_ids: ['tl-card'],
        reversal_pending_tender_line_ids: [],
      })
      .mockResolvedValueOnce({
        kind: 'ok',
        cancelled_at: '2026-10-07T10:01:00.000Z',
        reversed_tender_line_ids: ['tl-cash'],
        reversal_pending_tender_line_ids: [],
      });
    const bridge = makeBridge({ reversed: [] });
    (bridge.payments as unknown as { cancel: typeof cancel }).cancel = cancel;
    render(
      <PaymentSurface
        _testBridge={bridge}
        onBackToSale={() => Promise.resolve(true)}
        onNewSale={vi.fn()}
      />,
    );
    const cancelOnce = async (
      lines: readonly { id: string; type: TenderType; amount: number }[],
    ): Promise<void> => {
      await act(async () => {
        screen.getByTestId('tender-cash').click();
        await Promise.resolve();
      });
      act(() => {
        usePaymentStore.getState().applyAttemptSnapshot(attemptWith(lines));
      });
      await act(async () => {
        screen.getByTestId('payment-surface-cancel').click();
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    await cancelOnce([{ id: 'tl-card', type: 'external_card_terminal', amount: 5000 }]);
    await cancelOnce([{ id: 'tl-cash', type: 'cash', amount: 5000 }]);
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);
  });

  it('wins over M-P1 when a new tender is recorded after the card cancel (Codex P1)', async () => {
    await cancelWithLines(
      [{ id: 'tl-card', type: 'external_card_terminal', amount: 5000 }],
      ['tl-card'],
    );
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    act(() => {
      usePaymentStore
        .getState()
        .applyAttemptSnapshot(attemptWith([{ id: 'tl-cash', type: 'cash', amount: 1000 }]));
    });
    const reason = await screen.findByTestId('payment-surface-back-blocked');
    expect(reason).toHaveTextContent(CARD_VOID);
    expect(reason).not.toHaveTextContent(COMPLETE_OR_CANCEL);
  });

  it('a card applied in this Checkout is recognised even when the read after apply failed (Codex P1)', async () => {
    const bridge = makeBridge({ reversed: ['tl-card-1'] });
    (bridge.payments as unknown as { read: ReturnType<typeof vi.fn> }).read = vi.fn(() =>
      Promise.reject(new Error('ipc')),
    );
    (bridge.tender as unknown as { apply: ReturnType<typeof vi.fn> }).apply = vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        tender_line_id: 'tl-card-1',
        applied_at: '2026-10-07T09:59:30.000Z',
      }),
    );
    render(
      <PaymentSurface
        _testBridge={bridge}
        onBackToSale={() => Promise.resolve(true)}
        onNewSale={vi.fn()}
      />,
    );
    await act(async () => {
      screen.getByTestId('tender-external-card').click();
      await Promise.resolve();
    });
    fireEvent.change(await screen.findByTestId('external-card-amount-input'), {
      target: { value: '50.00' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('external-card-confirm'));
      await Promise.resolve();
      await Promise.resolve();
    });
    // The read failed: the projection still has no card line.
    await screen.findByTestId('payment-surface-reread');
    expect(usePaymentStore.getState().paymentSlice?.tender_lines ?? []).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('payment-surface-cancel'), { detail: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);
  });

  it('survives leaving Checkout and coming back to the same sale (Codex P1)', async () => {
    await cancelWithLines(
      [{ id: 'tl-card', type: 'external_card_terminal', amount: 5000 }],
      ['tl-card'],
    );
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);
    cleanup();
    render(
      <PaymentSurface
        _testBridge={makeBridge({ reversed: [] })}
        onBackToSale={() => Promise.resolve(true)}
        backToSaleEligibility="blocked"
        onNewSale={vi.fn()}
      />,
    );
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);
  });

  it('a different sale does not inherit the warning', async () => {
    await cancelWithLines(
      [{ id: 'tl-card', type: 'external_card_terminal', amount: 5000 }],
      ['tl-card'],
    );
    cleanup();
    usePaymentStore.getState().mount({ ...ENVELOPE, handoff_action_id: 'hid-002' });
    render(
      <PaymentSurface
        _testBridge={makeBridge({ reversed: [] })}
        onBackToSale={() => Promise.resolve(true)}
        backToSaleEligibility="blocked"
        onNewSale={vi.fn()}
      />,
    );
    const reason = await screen.findByTestId('payment-surface-back-blocked');
    expect(reason).not.toHaveTextContent(CARD_VOID);
  });

  it('warns after a card apply whose response was lost, then a cancel (Codex P1)', async () => {
    const bridge = makeBridge({ reversed: ['tl-lost'] });
    (bridge.tender as unknown as { apply: ReturnType<typeof vi.fn> }).apply = vi.fn(() =>
      Promise.reject(new Error('response lost after commit')),
    );
    render(
      <PaymentSurface
        _testBridge={bridge}
        onBackToSale={() => Promise.resolve(true)}
        onNewSale={vi.fn()}
      />,
    );
    await act(async () => {
      screen.getByTestId('tender-external-card').click();
      await Promise.resolve();
    });
    fireEvent.change(await screen.findByTestId('external-card-amount-input'), {
      target: { value: '50.00' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('external-card-confirm'));
      await Promise.resolve();
      await Promise.resolve();
    });
    // The renderer never learned the line id; main reverses a line it does not know.
    await act(async () => {
      fireEvent.click(screen.getByTestId('payment-surface-cancel'), { detail: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('payment-surface-back-blocked')).toHaveTextContent(CARD_VOID);
  });

  it('no card attempted: a cancel of a line the renderer does not know is not a card warning', async () => {
    await cancelWithLines([], ['tl-unknown']);
    const reason = await screen.findByTestId('payment-surface-back-blocked');
    expect(reason).not.toHaveTextContent(CARD_VOID);
  });

  it('stays on Completion after another tender settles the sale (Codex P1)', async () => {
    const bridge = makeBridge({ reversed: ['tl-card'] });
    (bridge.payments as unknown as { confirm: ReturnType<typeof vi.fn> }).confirm = vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, settled_at: '2026-10-07T10:02:00.000Z' }),
    );
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
    act(() => {
      usePaymentStore
        .getState()
        .applyAttemptSnapshot(
          attemptWith([{ id: 'tl-card', type: 'external_card_terminal', amount: 5000 }]),
        );
    });
    await act(async () => {
      screen.getByTestId('payment-surface-cancel').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // A new cash attempt settles the sale.
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    act(() => {
      usePaymentStore
        .getState()
        .applyAttemptSnapshot(attemptWith([{ id: 'tl-cash', type: 'cash', amount: 5000 }]));
    });
    const confirm = await screen.findByTestId('payment-surface-confirm');
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('payment-surface-settled')).toBeInTheDocument();
    const warning = screen.getByTestId('payment-surface-settled-card-void');
    expect(warning).toHaveTextContent(CARD_VOID);
    expect(warning).toHaveAttribute('data-tone', 'danger');
  });

  it('Completion shows no card warning when no card was cancelled', async () => {
    const bridge = makeBridge({ reversed: [] });
    (bridge.payments as unknown as { confirm: ReturnType<typeof vi.fn> }).confirm = vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, settled_at: '2026-10-07T10:02:00.000Z' }),
    );
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
    act(() => {
      usePaymentStore
        .getState()
        .applyAttemptSnapshot(attemptWith([{ id: 'tl-cash', type: 'cash', amount: 5000 }]));
    });
    const confirm = await screen.findByTestId('payment-surface-confirm');
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('payment-surface-settled')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-settled-card-void')).not.toBeInTheDocument();
  });

  it('a cash-only cancel keeps the proven-reversal line (M-P2), not the card line', async () => {
    await cancelWithLines([{ id: 'tl-cash', type: 'cash', amount: 5000 }], ['tl-cash']);
    const reason = await screen.findByTestId('payment-surface-back-blocked');
    expect(reason).toHaveTextContent(CASH_REVERSED);
    expect(reason).not.toHaveTextContent(CARD_VOID);
    expect(reason).not.toHaveClass('payment-surface__back-blocked--danger');
    expect(reason).toHaveAttribute('data-tone', 'info');
  });
});
