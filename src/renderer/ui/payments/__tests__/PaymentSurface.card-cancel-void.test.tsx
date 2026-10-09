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

type Line = { id: string; type: TenderType; amount: number };
type Bridge = ReturnType<typeof makeBridge>;

const CARD_LINE: Line = { id: 'tl-card', type: 'external_card_terminal', amount: 5000 };
const CASH_LINE: Line = { id: 'tl-cash', type: 'cash', amount: 5000 };

function stub(
  bridge: Bridge,
  api: 'payments' | 'tender',
  method: string,
  impl: () => unknown,
): void {
  (bridge[api] as unknown as Record<string, unknown>)[method] = vi.fn(impl);
}

function renderSurface(bridge: Bridge, extra: { backToSaleEligibility?: 'blocked' } = {}): void {
  render(
    <PaymentSurface
      _testBridge={bridge}
      onBackToSale={() => Promise.resolve(true)}
      onNewSale={vi.fn()}
      {...extra}
    />,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Opens the cash entry (phase `entry`, where Cancel lives). */
async function openCash(): Promise<void> {
  await act(async () => {
    screen.getByTestId('tender-cash').click();
    await Promise.resolve();
  });
}

function seed(lines: readonly Line[]): void {
  act(() => {
    usePaymentStore.getState().applyAttemptSnapshot(attemptWith(lines));
  });
}

async function clickCancel(): Promise<void> {
  fireEvent.click(screen.getByTestId('payment-surface-cancel'), { detail: 1 });
  await settle();
}

/** Records a card amount through the real card entry (the apply outcome is the bridge's). */
async function applyCardViaUi(): Promise<void> {
  await act(async () => {
    screen.getByTestId('tender-external-card').click();
    await Promise.resolve();
  });
  // The card records exactly what is owed (RT-243 W1-C: no amount field).
  await screen.findByTestId('external-card-terminal-entry');
  fireEvent.click(screen.getByTestId('external-card-confirm'));
  await settle();
}

async function confirmSettle(): Promise<void> {
  const confirm = await screen.findByTestId('payment-surface-confirm');
  await act(async () => {
    confirm.click();
    await Promise.resolve();
  });
  expect(await screen.findByTestId('payment-surface-settled')).toBeInTheDocument();
}

/** Seeds the lines on an open cash entry, then cancels with `reversed`. */
async function cancelWithLines(lines: readonly Line[], reversed: readonly string[]): Promise<void> {
  renderSurface(makeBridge({ reversed }));
  await openCash();
  seed(lines);
  await clickCancel();
}

async function backReasonLine(): Promise<HTMLElement> {
  return screen.findByTestId('payment-surface-back-blocked');
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
    await cancelWithLines([CARD_LINE], ['tl-card']);
    const reason = await backReasonLine();
    expect(reason).toHaveTextContent(CARD_VOID);
    expect(screen.getByTestId('payment-surface')).not.toHaveTextContent(COMPLETE_OR_CANCEL);
    // Catalog tone `danger` (Codex P2): not the muted Back explanation style.
    // RT-243 W1-C: the tone is the styling hook (`[data-tone='danger']`).
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
    const reason = await backReasonLine();
    expect(reason).toHaveTextContent(CARD_VOID);
    expect(reason).not.toHaveTextContent(CASH_REVERSED);
  });

  it('stays on a later cash-only cancel in the same Checkout (the card may still stand)', async () => {
    const bridge = makeBridge({ reversed: ['tl-card'] });
    renderSurface(bridge);
    await openCash();
    seed([CARD_LINE]);
    await clickCancel();
    (
      bridge.payments as unknown as { cancel: ReturnType<typeof vi.fn> }
    ).cancel.mockResolvedValueOnce({
      kind: 'ok',
      cancelled_at: '2026-10-07T10:01:00.000Z',
      reversed_tender_line_ids: ['tl-cash'],
      reversal_pending_tender_line_ids: [],
    });
    await openCash();
    seed([CASH_LINE]);
    await clickCancel();
    expect(await backReasonLine()).toHaveTextContent(CARD_VOID);
  });

  it('wins over M-P1 when a new tender is recorded after the card cancel (Codex P1)', async () => {
    await cancelWithLines([CARD_LINE], ['tl-card']);
    await openCash();
    seed([{ id: 'tl-cash', type: 'cash', amount: 1000 }]);
    const reason = await backReasonLine();
    expect(reason).toHaveTextContent(CARD_VOID);
    expect(reason).not.toHaveTextContent(COMPLETE_OR_CANCEL);
  });

  it('a card applied in this Checkout is recognised even when the read after apply failed (Codex P1)', async () => {
    const bridge = makeBridge({ reversed: ['tl-card-1'] });
    stub(bridge, 'payments', 'read', () => Promise.reject(new Error('ipc')));
    stub(bridge, 'tender', 'apply', () =>
      Promise.resolve({
        kind: 'ok',
        tender_line_id: 'tl-card-1',
        applied_at: '2026-10-07T09:59:30.000Z',
      }),
    );
    renderSurface(bridge);
    await applyCardViaUi();
    // The read failed: the projection still has no card line.
    await screen.findByTestId('payment-surface-reread');
    expect(usePaymentStore.getState().paymentSlice?.tender_lines ?? []).toEqual([]);
    await clickCancel();
    expect(await backReasonLine()).toHaveTextContent(CARD_VOID);
  });

  it('survives leaving Checkout and coming back to the same sale (Codex P1)', async () => {
    await cancelWithLines([CARD_LINE], ['tl-card']);
    expect(await backReasonLine()).toHaveTextContent(CARD_VOID);
    cleanup();
    renderSurface(makeBridge({ reversed: [] }), { backToSaleEligibility: 'blocked' });
    expect(await backReasonLine()).toHaveTextContent(CARD_VOID);
  });

  it('a different sale does not inherit the warning', async () => {
    await cancelWithLines([CARD_LINE], ['tl-card']);
    cleanup();
    usePaymentStore.getState().mount({ ...ENVELOPE, handoff_action_id: 'hid-002' });
    renderSurface(makeBridge({ reversed: [] }), { backToSaleEligibility: 'blocked' });
    expect(await backReasonLine()).not.toHaveTextContent(CARD_VOID);
  });

  it.each([
    ['whose response was lost, then a cancel of a line it never learned', ['tl-lost']],
    ['rejected before any line was saved, then a zero-line cancel', []],
  ] as const)('warns after a card apply %s (Codex P1)', async (_, reversed) => {
    const bridge = makeBridge({ reversed });
    stub(bridge, 'tender', 'apply', () => Promise.reject(new Error('outcome unknown')));
    renderSurface(bridge);
    await applyCardViaUi();
    await clickCancel();
    expect(await backReasonLine()).toHaveTextContent(CARD_VOID);
  });

  it('no card attempted: a cancel of a line the renderer does not know is not a card warning', async () => {
    await cancelWithLines([], ['tl-unknown']);
    expect(await backReasonLine()).not.toHaveTextContent(CARD_VOID);
  });

  it.each([
    ['stays on Completion after another tender settles the sale (Codex P1)', true],
    ['Completion shows no card warning when no card was cancelled', false],
  ] as const)('%s', async (_, cardCancelled) => {
    const bridge = makeBridge({ reversed: cardCancelled ? ['tl-card'] : [] });
    stub(bridge, 'payments', 'confirm', () =>
      Promise.resolve({ kind: 'ok', settled_at: '2026-10-07T10:02:00.000Z' }),
    );
    renderSurface(bridge);
    if (cardCancelled) {
      await openCash();
      seed([CARD_LINE]);
      await clickCancel();
    }
    await openCash();
    seed([CASH_LINE]);
    await confirmSettle();
    const warning = screen.queryByTestId('payment-surface-settled-card-void');
    if (cardCancelled) {
      expect(warning).toHaveTextContent(CARD_VOID);
      expect(warning).toHaveAttribute('data-tone', 'danger');
    } else {
      expect(warning).not.toBeInTheDocument();
    }
  });

  it('a cash-only cancel keeps the proven-reversal line (M-P2), not the card line', async () => {
    await cancelWithLines([CASH_LINE], ['tl-cash']);
    const reason = await backReasonLine();
    expect(reason).toHaveTextContent(CASH_REVERSED);
    expect(reason).not.toHaveTextContent(CARD_VOID);
    expect(reason).toHaveAttribute('data-tone', 'info');
  });
});
