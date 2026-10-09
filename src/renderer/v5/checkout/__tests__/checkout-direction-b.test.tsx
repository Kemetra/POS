/**
 * RT-243 W1-C — Checkout on Direction B: OrderSummary, PaymentLedger and the
 * focus contract around them (freeze 15 §3.2/§3.3, DESIGN.md Direction B).
 *
 * jsdom loads no CSS and does no layout, so the comfortable/compact switch (a
 * container query) and pinning are proven by the dev/packaged captures, not
 * here. These tests pin what is observable: the disclosure semantics, the Esc
 * layer order, the money column's content, and where focus goes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api';
import type {
  PaymentAttemptRendererView,
  TenderLineRendererView,
} from '../../../../shared/payments/types';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { usePaymentStore } from '../../../stores/payment-store';
import { expectNoAxeViolations } from '../../../ui/primitives/__tests__/axe-config';
import { PaymentSurface } from '../../../ui/payments/PaymentSurface';
import { OrderSummary } from '../OrderSummary';
import { PaymentLedger } from '../PaymentLedger';

const DUE = 5_000;

function envelope(lineCount = 3): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-001',
    operator_session_id: 'sess-001',
    owning_operator_id: 'op-001',
    tenant_id: 'tenant-001',
    branch_id: 'branch-001',
    terminal_id: 'terminal-001',
    lines: Array.from({ length: lineCount }, (_, i) => ({
      line_id: `line-${String(i)}`,
      item_ref: `item-${String(i)}`,
      display_name: `صنف ${String(i + 1)}`,
      quantity: i + 1,
      unit_price_minor: 1000,
      line_subtotal_minor: 1000 * (i + 1),
      note: null,
      version: 1,
      last_action_id: `act-${String(i)}`,
    })),
    discount_placeholders: [],
    subtotal_minor: DUE,
    created_at: '2026-10-09T09:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

function line(
  id: string,
  tender_type: TenderLineRendererView['tender_type'],
  amount: number,
  order: number,
  extra: Partial<TenderLineRendererView> = {},
): TenderLineRendererView {
  return {
    tender_line_id: id,
    tender_type,
    state: 'applied',
    amount_applied_minor: amount,
    applied_at: '2026-10-09T09:01:00.000Z',
    apply_order: order,
    ...extra,
  };
}

/** Main-like bridge: each apply records a line that `payments.read` projects back. */
function makeBridge(): { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI } {
  let lines: TenderLineRendererView[] = [];
  const snapshot = (): PaymentAttemptRendererView => ({
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: DUE,
    started_at: '2026-10-09T09:00:30.000Z',
    tender_lines: lines,
  });
  return {
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
      read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt: snapshot() })),
      confirm: vi.fn(),
      cancel: vi.fn(),
    } as unknown as PaymentsBridgeAPI,
    tender: {
      apply: vi.fn((req: { amount_applied_minor: number }) => {
        lines = [
          ...lines,
          line(
            `tl-${String(lines.length + 1)}`,
            'cash',
            req.amount_applied_minor,
            lines.length + 1,
          ),
        ];
        return Promise.resolve({
          kind: 'ok' as const,
          tender_line_id: `tl-${String(lines.length)}`,
          applied_at: '2026-10-09T09:01:00.000Z',
        });
      }),
    } as unknown as TenderBridgeAPI,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
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
        started_at: '2026-10-09T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(envelope());
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

describe('OrderSummary — frozen, read-only, a strip with a disclosure at 1024', () => {
  it('states the line and unit counts with Western digits, and the subtotal', () => {
    render(<OrderSummary envelope={envelope(3)} />);
    const summary = screen.getByTestId('payment-cart-summary');
    // 3 lines; 1 + 2 + 3 = 6 units.
    expect(summary).toHaveTextContent('الأصناف 3 · القطع 6');
    expect(screen.getByTestId('payment-summary-subtotal')).toHaveTextContent('50.00 EGP');
    expect(within(summary).getByText('مجمّدة')).toBeInTheDocument();
    // Read-only: the only control is the disclosure.
    expect(within(summary).getAllByRole('button')).toHaveLength(1);
  });

  it('the disclosure controls the line list and reports its state', () => {
    render(<OrderSummary envelope={envelope(3)} />);
    const toggle = screen.getByRole('button', { name: 'عرض الأصناف' });
    const list = screen.getByRole('list', { name: 'أصناف السلة' });
    expect(toggle).toHaveAttribute('aria-controls', list.id);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('payment-cart-summary')).toHaveAttribute('data-open', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('Esc inside the open list closes it and is consumed (never also Back)', () => {
    render(<OrderSummary envelope={envelope(3)} />);
    const toggle = screen.getByRole('button', { name: 'عرض الأصناف' });
    fireEvent.click(toggle);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      toggle.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('Esc with the list closed is left for the Checkout Esc handler', () => {
    render(<OrderSummary envelope={envelope(3)} />);
    const toggle = screen.getByRole('button', { name: 'عرض الأصناف' });
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      toggle.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it('closes when focus leaves the summary', () => {
    render(
      <>
        <OrderSummary envelope={envelope(3)} />
        <button type="button">خارج</button>
      </>,
    );
    const toggle = screen.getByRole('button', { name: 'عرض الأصناف' });
    fireEvent.click(toggle);
    fireEvent.blur(toggle, { relatedTarget: screen.getByRole('button', { name: 'خارج' }) });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('on Checkout, Esc in the open summary does not leave for the Sale', async () => {
    const onBackToSale = vi.fn(() => Promise.resolve(true));
    render(
      <PaymentSurface
        _testBridge={makeBridge()}
        onBackToSale={onBackToSale}
        backToSaleEligibility="returnable"
      />,
    );
    const toggle = screen.getByRole('button', { name: 'عرض الأصناف' });
    fireEvent.click(toggle);
    fireEvent.keyDown(toggle, { key: 'Escape' });
    await settle();
    expect(onBackToSale).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('PaymentLedger — the money column', () => {
  it('shows the amount due alone before any tender', () => {
    render(<PaymentLedger dueMinor={DUE} lines={[]} changeDueMinor={0} />);
    const column = screen.getByRole('region', { name: 'المبلغ المستحق' });
    expect(column).toHaveTextContent('50.00 EGP');
    expect(screen.queryByTestId('payment-ledger')).not.toBeInTheDocument();
  });

  it('lists recorded money per method in apply order, apart from what is still due', () => {
    render(
      <PaymentLedger
        dueMinor={0}
        lines={[
          line('tl-1', 'external_card_terminal', 1000, 1),
          line('tl-2', 'cash', 2000, 2),
          line('tl-3', 'cash', 2500, 3, { change_due_minor: 500 }),
        ]}
        changeDueMinor={500}
      />,
    );
    const rows = screen.getAllByTestId('payment-ledger-line').map((row) => row.textContent);
    expect(rows).toEqual(['بطاقة10.00 EGP', 'نقدي45.00 EGP']);
    expect(screen.getByTestId('payment-ledger-change')).toHaveTextContent('الباقي للعميل 5.00 EGP');
  });

  it('keeps the recorded change in the column whatever the entry does (RT-255 item 1)', () => {
    render(
      <PaymentLedger
        dueMinor={0}
        lines={[line('tl-1', 'cash', 6000, 1, { change_due_minor: 1000 })]}
        changeDueMinor={1000}
      />,
    );
    expect(screen.getByTestId('payment-ledger-change')).toHaveTextContent('10.00 EGP');
  });

  it('places the actions after the recorded money, outside the scrolling middle', () => {
    render(
      <PaymentLedger
        dueMinor={DUE}
        lines={[line('tl-1', 'cash', 1000, 1)]}
        changeDueMinor={0}
        actions={<button type="button">تأكيد الدفع</button>}
      />,
    );
    const column = screen.getByRole('region', { name: 'المبلغ المستحق' });
    const middle = column.querySelector('.v5-ledger__middle');
    const commit = screen.getByRole('button', { name: 'تأكيد الدفع' });
    expect(middle?.contains(commit)).toBe(false);
    expect(column.lastElementChild?.contains(commit)).toBe(true);
  });
});

describe('Checkout focus and accessibility on Direction B', () => {
  it('after a partial cash apply, focus returns to the first enabled tender tile (§3.2)', async () => {
    render(<PaymentSurface _testBridge={makeBridge()} />);
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await screen.findByTestId('cash-entry');
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: '20' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cash-entry-confirm'));
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByTestId('payment-surface-amount-due')).toHaveTextContent('30.00 EGP');
    expect(screen.getByTestId('tender-cash')).toHaveFocus();
  });

  it('is axe-clean with an open cash entry and recorded money', async () => {
    const { container } = render(<PaymentSurface _testBridge={makeBridge()} />);
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await screen.findByTestId('cash-entry');
    act(() => {
      usePaymentStore.getState().applyAttemptSnapshot({
        payment_attempt_id: 'pa-001',
        state: 'started',
        envelope_subtotal_minor: DUE,
        started_at: '2026-10-09T09:00:30.000Z',
        tender_lines: [line('tl-1', 'external_card_terminal', 1000, 1)],
      });
    });
    await settle();
    expect(screen.getByTestId('payment-ledger')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('Checkout action slots keep their place (A2, N-02) — CSS tripwire', () => {
  /**
   * A SOURCE TRIPWIRE, not a cascade check (jsdom does no layout). In the money
   * column the slots stack, commit above cancel. If an empty slot collapsed,
   * Esc after a full cash apply (cancel leaves) would drop «تأكيد الدفع» into the
   * exact place «إلغاء» held — the N-02 slip RT-238 exists to prevent. The
   * harness geometry probe (dev evidence in the PR) is the runtime proof.
   */
  const css = readFileSync(resolve(__dirname, '../checkout.css'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  /** Every declaration block whose selector list includes `selector`. */
  function blocks(selector: string): string[] {
    return css
      .split('}')
      .map((rule) => rule.split('{'))
      .filter(([sel]) => sel?.split(',').some((s) => s.trim() === selector))
      .map(([, body]) => body ?? '');
  }

  it.each([
    '.v5-ledger__actions .checkout-actions__slot--end',
    '.v5-ledger__actions .checkout-actions__slot--start',
  ])('%s reserves its height at both densities', (selector) => {
    const sized = blocks(selector).filter((body) => /min-block-size:/.test(body));
    expect(sized.length).toBeGreaterThanOrEqual(2);
  });

  it('no rule collapses an empty action slot or the action band', () => {
    expect(css).not.toMatch(/checkout-actions__slot[^{]*:empty/);
    expect(css).not.toMatch(/v5-ledger__actions[^{]*:not\(:has/);
  });
});
