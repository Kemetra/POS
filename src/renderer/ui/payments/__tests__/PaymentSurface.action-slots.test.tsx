/**
 * RT-238 (VNext A3) — the pinned action bar and its fixed slots.
 *
 * 15 §4 A2: inline-end = primary/commit, inline-start = cancel, and a slot that
 * is empty in one state stays empty rather than being reused by an action of the
 * opposite consequence (RT-159 N-02: «تأكيد الدفع» took the exact place «إلغاء»
 * held a moment earlier, and a click aimed at Cancel settled a payment).
 *
 * jsdom has no layout, so what is pinned here is the STRUCTURE the stylesheet
 * pins (the bar is outside the panes; each action lives in a named slot) and the
 * behaviour around it. The on-screen positions are measured in the real app.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../shared/payments/types.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { expectNoAxeViolations } from '../../primitives/__tests__/axe-config.js';
import { PaymentSurface } from '../PaymentSurface.js';

const DUE = 5_000;

function makeEnvelope(): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-001',
    operator_session_id: 'sess-001',
    owning_operator_id: 'op-001',
    tenant_id: 'tenant-001',
    branch_id: 'branch-001',
    terminal_id: 'terminal-001',
    lines: [],
    discount_placeholders: [],
    subtotal_minor: DUE,
    created_at: '2026-10-07T09:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

function signIn(): void {
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
}

/** Main-like bridge: each apply records a tender line that `payments.read` projects back. */
function makeBridge(): {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  confirm: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
} {
  let lines: PaymentAttemptRendererView['tender_lines'] = [];
  const snapshot = (): PaymentAttemptRendererView => ({
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: DUE,
    started_at: '2026-10-07T09:00:30.000Z',
    tender_lines: lines,
  });
  const confirm = vi.fn(() =>
    Promise.resolve({ kind: 'ok' as const, settled_at: '2026-10-07T09:02:00.000Z' }),
  );
  const read = vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt: snapshot() }));
  const payments = {
    start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
    read,
    confirm,
    cancel: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
  } as unknown as PaymentsBridgeAPI;
  const apply = vi.fn(
    (req: { tender_type: 'cash' | 'external_card_terminal'; amount_applied_minor: number }) => {
      lines = [
        ...lines,
        {
          tender_line_id: `tl-${String(lines.length + 1)}`,
          tender_type: req.tender_type,
          state: 'applied',
          amount_applied_minor: req.amount_applied_minor,
          applied_at: '2026-10-07T09:01:00.000Z',
          apply_order: lines.length + 1,
        },
      ];
      return Promise.resolve({
        kind: 'ok' as const,
        tender_line_id: `tl-${String(lines.length)}`,
        applied_at: '2026-10-07T09:01:00.000Z',
      });
    },
  );
  const tender = { apply } as unknown as TenderBridgeAPI;
  return { payments, tender, confirm, read, apply };
}

beforeEach(() => {
  signIn();
  usePaymentStore.getState().mount(makeEnvelope());
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

async function openCash(): Promise<ReturnType<typeof makeBridge>> {
  const bridge = makeBridge();
  render(<PaymentSurface _testBridge={bridge} />);
  await act(async () => {
    screen.getByTestId('tender-cash').click();
    await Promise.resolve();
  });
  await screen.findByTestId('cash-entry');
  return bridge;
}

function slot(name: 'start' | 'end'): HTMLElement {
  const el = screen
    .getByTestId('payment-surface-actions')
    .querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (el === null) throw new Error(`no ${name} slot`);
  return el;
}

async function typeAndApply(amount: string): Promise<void> {
  fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: amount } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('cash-entry-confirm'));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('RT-238 — the action bar is outside the scrolling panes', () => {
  it('renders the bar as a sibling after the body, never inside it', async () => {
    await openCash();
    const surface = screen.getByTestId('payment-surface');
    const body = screen.getByTestId('payment-surface-body');
    const bar = screen.getByTestId('payment-surface-actions');
    expect(body.contains(bar)).toBe(false);
    expect(bar.parentElement).toBe(surface);
    expect(body.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has both slots from the start, even before any action exists', () => {
    render(<PaymentSurface _testBridge={makeBridge()} />);
    expect(slot('start')).toBeEmptyDOMElement();
    expect(slot('end')).toBeEmptyDOMElement();
  });
});

describe('RT-238 — fixed slots: cancel at inline-start, commit at inline-end (A2, N-02)', () => {
  it('cash entry: the apply-commit is in the end slot and cancel in the start slot', async () => {
    await openCash();
    expect(within(slot('end')).getByTestId('cash-entry-confirm')).toBeInTheDocument();
    expect(within(slot('start')).getByTestId('payment-surface-cancel')).toBeInTheDocument();
    // The settle commit does not exist yet: nothing is applied.
    expect(screen.queryByTestId('payment-surface-confirm')).not.toBeInTheDocument();
  });

  it('after a full apply the settle commit takes the END slot and cancel stays where it was', async () => {
    await openCash();
    const cancelBefore = screen.getByTestId('payment-surface-cancel');
    await typeAndApply('50.00');

    const commit = await screen.findByTestId('payment-surface-confirm');
    expect(commit.closest('[data-slot]')).toHaveAttribute('data-slot', 'end');
    // The inline-start slot still holds the same cancel: the commit never took its place.
    const cancelAfter = screen.getByTestId('payment-surface-cancel');
    expect(cancelAfter).toBe(cancelBefore);
    expect(cancelAfter.closest('[data-slot]')).toHaveAttribute('data-slot', 'start');
    // The entry's apply has nothing left to do: it is not rendered at all, so the
    // bar never shows a dead, disabled second commit beside «تأكيد الدفع».
    expect(screen.queryByTestId('cash-entry-confirm')).not.toBeInTheDocument();
    expect(commit).toBeEnabled();
    expect(commit).not.toHaveAttribute('aria-disabled');
  });

  it('moves focus to the settle commit when the apply completes the payment', async () => {
    await openCash();
    await typeAndApply('50.00');
    const commit = await screen.findByTestId('payment-surface-confirm');
    expect(commit).toHaveFocus();
  });

  it('a commit with money still owed is sunken, says why, and does not settle', async () => {
    const bridge = await openCash();
    await typeAndApply('20.00'); // partial: 30.00 still owed, back to the method tiles

    const commit = await screen.findByTestId('payment-surface-confirm');
    expect(commit.closest('[data-slot]')).toHaveAttribute('data-slot', 'end');
    expect(commit).toHaveAttribute('aria-disabled', 'true');
    expect(commit).toHaveAccessibleDescription('المبلغ أقل من المستحق');
    expect(screen.getByTestId('payment-surface-commit-reason')).toHaveTextContent(
      'المبلغ أقل من المستحق',
    );
    fireEvent.click(commit);
    expect(bridge.confirm).not.toHaveBeenCalled();
    // Cancel was in the start slot for the entry; with no entry open that slot is empty,
    // and the commit did not move into it.
    expect(slot('start')).toBeEmptyDOMElement();
  });

  it('the card entry apply-commit is pinned in the end slot too', async () => {
    const bridge = makeBridge();
    render(<PaymentSurface _testBridge={bridge} />);
    await act(async () => {
      screen.getByTestId('tender-external-card').click();
      await Promise.resolve();
    });
    await screen.findByTestId('external-card-confirm');
    expect(within(slot('end')).getByTestId('external-card-confirm')).toBeInTheDocument();
    expect(within(slot('start')).getByTestId('payment-surface-cancel')).toBeInTheDocument();
  });

  it('refusals stay with the commit, inside the bar', async () => {
    const bridge = await openCash();
    await typeAndApply('50.00');
    bridge.confirm.mockResolvedValueOnce({ kind: 'refused' });
    await act(async () => {
      // A pointer click (detail 1): the held-Enter guard only filters keyboard activations.
      fireEvent.click(await screen.findByTestId('payment-surface-confirm'), { detail: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    const refusal = await screen.findByTestId('payment-surface-bridge-refusal');
    expect(screen.getByTestId('payment-surface-actions').contains(refusal)).toBe(true);
  });
});

describe('RT-238 — one quick-amount group (I-9: chips SET the value)', () => {
  it('the keypad no longer repeats the quick amounts', async () => {
    await openCash();
    expect(document.querySelectorAll('.quick-amounts')).toHaveLength(1);
    expect(document.querySelector('.amount-pad__quick')).toBeNull();
    expect(screen.queryByTestId(/amount-pad-quick-/)).not.toBeInTheDocument();
  });

  it('a chip sets (does not add to) the received amount', async () => {
    await openCash();
    const input = screen.getByTestId<HTMLInputElement>('cash-entry-amount-input');
    fireEvent.click(screen.getByRole('button', { name: /^100\.00/ }));
    expect(input.value).toBe('100.00');
    fireEvent.click(screen.getByRole('button', { name: /^200\.00/ }));
    expect(input.value).toBe('200.00');
  });
});

describe('RT-238 — keyboard-only and axe on the touched surfaces', () => {
  it('walks apply → settle with the keyboard: Tab reaches the pinned apply, focus lands on the commit', async () => {
    const bridge = await openCash();
    const user = userEvent.setup();
    screen.getByTestId('cash-entry-amount-input').focus();
    await user.keyboard('50.00');
    // Tab forward until the pinned apply has focus: it must be reachable by keyboard.
    const apply = screen.getByTestId('cash-entry-confirm');
    for (let i = 0; i < 40 && document.activeElement !== apply; i += 1) await user.tab();
    expect(apply).toHaveFocus();
    await user.keyboard('{Enter}');
    const commit = await screen.findByTestId('payment-surface-confirm');
    expect(commit).toHaveFocus();
    // A deliberate Enter, after the guard window, settles.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    await user.keyboard('{Enter}');
    expect(bridge.confirm).toHaveBeenCalledTimes(1);
  });

  it('a held or doubled Enter right after focus moves to the commit does not settle (I-9)', async () => {
    const bridge = await openCash();
    const user = userEvent.setup();
    await typeAndApply('50.00');
    expect(await screen.findByTestId('payment-surface-confirm')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(bridge.confirm).not.toHaveBeenCalled();
  });

  it('closing the entry with Esc keeps focus on the settle commit when fully tendered', async () => {
    await openCash();
    const user = userEvent.setup();
    await typeAndApply('50.00');
    const commit = await screen.findByTestId('payment-surface-confirm');
    expect(commit).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('payment-surface-confirm')).toHaveFocus();
  });

  it('after an apply succeeds, a failed read never re-offers the apply; it offers a retry (Codex P1, I-9)', async () => {
    const bridge = await openCash();
    // Every read after the apply fails (the automatic retries too).
    bridge.read.mockRejectedValue(new Error('ipc'));
    await typeAndApply('50.00');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The apply already happened in main: pressing it again would record the
    // whole amount a second time, as change. It must not be on screen.
    expect(screen.queryByTestId('cash-entry-confirm')).not.toBeInTheDocument();
    const retry = await screen.findByTestId('payment-surface-reread');
    expect(retry.closest('[data-slot]')).toHaveAttribute('data-slot', 'end');
    expect(screen.getByTestId('payment-surface-reread-notice')).toHaveTextContent('لا تكرر الدفع');
    expect(bridge.apply).toHaveBeenCalledTimes(1);

    // Main is reachable again: the retry reads the real state and the settle commit takes over.
    bridge.read.mockReset();
    bridge.read.mockResolvedValue({
      kind: 'ok',
      payment_attempt: {
        payment_attempt_id: 'pa-001',
        state: 'started',
        envelope_subtotal_minor: DUE,
        started_at: '2026-10-07T09:00:30.000Z',
        tender_lines: [
          {
            tender_line_id: 'tl-1',
            tender_type: 'cash',
            state: 'applied',
            amount_applied_minor: DUE,
            applied_at: '2026-10-07T09:01:00.000Z',
            apply_order: 1,
          },
        ],
      },
    });
    await act(async () => {
      fireEvent.click(retry, { detail: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    const commit = await screen.findByTestId('payment-surface-confirm');
    expect(commit).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByTestId('payment-surface-reread')).not.toBeInTheDocument();
  });

  it('a single failed read after an apply is retried on its own', async () => {
    const bridge = await openCash();
    bridge.read.mockRejectedValueOnce(new Error('ipc'));
    await typeAndApply('50.00');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('payment-surface-confirm')).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(screen.queryByTestId('payment-surface-reread')).not.toBeInTheDocument();
  });

  it('cash entry state: no axe violations', async () => {
    await openCash();
    await expectNoAxeViolations(screen.getByTestId('payment-surface'));
  });

  it('commit sunken with its reason: no axe violations', async () => {
    await openCash();
    await typeAndApply('20.00');
    await screen.findByTestId('payment-surface-commit-reason');
    await expectNoAxeViolations(screen.getByTestId('payment-surface'));
  });
});
