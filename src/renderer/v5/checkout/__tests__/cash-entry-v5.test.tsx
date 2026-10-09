/**
 * RT-243 W1-C — the cash entry on V5 (freeze 15 §6 Checkout / cash; VN-B2;
 * S8/S9): `CashKeypad`, `QuickAmounts`, the ledger's cash preview (`cashDraft`)
 * and how they sit in `PaymentSurface`.
 *
 * The finding this slice closes is RT-255 item 1: after a cash apply the change
 * sat in the scrolling tender panel, below the fold. The change, the preview and
 * the shortfall now live in the pinned money column. jsdom does no layout, so
 * the pinning itself is the ledger's grid (proven by the dev captures); here we
 * prove WHERE in the tree each figure is and that it is the right figure.
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
import { CashKeypad } from '../CashKeypad';
import { QuickAmounts } from '../QuickAmounts';
import { cashDraft } from '../cash-draft';

const DUE = 6_230; // 62.30 EGP

function envelope(subtotal = DUE): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-001',
    operator_session_id: 'sess-001',
    owning_operator_id: 'op-001',
    tenant_id: 'tenant-001',
    branch_id: 'branch-001',
    terminal_id: 'terminal-001',
    lines: [
      {
        line_id: 'line-0',
        item_ref: 'item-0',
        display_name: 'صنف 1',
        quantity: 1,
        unit_price_minor: subtotal,
        line_subtotal_minor: subtotal,
        note: null,
        version: 1,
        last_action_id: 'act-0',
      },
    ],
    discount_placeholders: [],
    subtotal_minor: subtotal,
    created_at: '2026-10-09T09:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

/** Main-like bridge: each apply records a line, with main's change, that `read` projects back. */
function makeBridge(subtotal = DUE): { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI } {
  let lines: TenderLineRendererView[] = [];
  const snapshot = (): PaymentAttemptRendererView => ({
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: subtotal,
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
        const owed = subtotal - lines.reduce((sum, l) => sum + l.amount_applied_minor, 0);
        const change = Math.max(req.amount_applied_minor - owed, 0);
        lines = [
          ...lines,
          {
            tender_line_id: `tl-${String(lines.length + 1)}`,
            tender_type: 'cash',
            state: 'applied',
            amount_applied_minor: req.amount_applied_minor,
            applied_at: '2026-10-09T09:01:00.000Z',
            apply_order: lines.length + 1,
            ...(change > 0 ? { change_due_minor: change } : {}),
          },
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

async function openCash(subtotal = DUE): Promise<ReturnType<typeof makeBridge>> {
  usePaymentStore.getState().mount(envelope(subtotal));
  const bridge = makeBridge(subtotal);
  render(<PaymentSurface _testBridge={bridge} />);
  await act(async () => {
    screen.getByTestId('tender-cash').click();
    await Promise.resolve();
  });
  await screen.findByTestId('cash-entry');
  await settle();
  return bridge;
}

function type(value: string): void {
  fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value } });
}

async function apply(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('cash-entry-confirm'));
    await Promise.resolve();
  });
  await settle();
}

/** The money column (`PaymentLedger`), found by its region name. */
function ledger(): HTMLElement {
  return screen.getByRole('region', { name: 'المبلغ المستحق' });
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

describe('cashDraft — the preview of the cash typed, against what is owed', () => {
  it('is the change when the amount covers the due', () => {
    expect(cashDraft(10_000, DUE)).toEqual({ kind: 'change', changeMinor: 3_770 });
  });

  it('is the shortfall when it does not (M-P4)', () => {
    expect(cashDraft(5_000, DUE)).toEqual({ kind: 'shortfall', shortMinor: 1_230 });
  });

  it('is nothing for exact cash', () => {
    expect(cashDraft(DUE, DUE)).toBeNull();
  });

  it.each([
    ['an empty field', null, DUE],
    ['zero', 0, DUE],
    ['a negative amount', -100, DUE],
    ['a non-safe amount', Number.MAX_SAFE_INTEGER + 2, DUE],
    ['a covered due (the RT-237 trap: received − 0)', 10_000, 0],
    ['a non-safe due', 10_000, Number.NaN],
  ])('is nothing for %s', (_label, received, due) => {
    expect(cashDraft(received, due)).toBeNull();
  });
});

describe('CashKeypad — an LTR register keypad', () => {
  it('lays the keys out left to right: 1 2 3 · 4 5 6 · 7 8 9 · 00 0 ⌫', () => {
    render(<CashKeypad valueMinor={null} onChange={vi.fn()} />);
    const pad = screen.getByTestId('cash-keypad');
    expect(pad).toHaveAttribute('dir', 'ltr');
    const keys = within(pad)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫']);
    expect(screen.getByRole('button', { name: 'حذف آخر رقم' })).toBe(
      screen.getByTestId('cash-keypad-delete'),
    );
  });

  it('has no display of its own: the amount field is the one value', () => {
    render(<CashKeypad valueMinor={12_550} onChange={vi.fn()} />);
    expect(screen.getByTestId('cash-keypad')).not.toHaveTextContent('125.50');
  });

  it.each([
    ['a digit right-fills', 5, 'cash-keypad-key-7', 57],
    ['0 appends a zero', 5, 'cash-keypad-key-0', 50],
    ['00 appends two zeros', 5, 'cash-keypad-key-00', 500],
    ['delete drops the last digit', 57, 'cash-keypad-delete', 5],
    ['null edits as 0', null, 'cash-keypad-key-3', 3],
    ['a non-safe value edits as 0', Number.NaN, 'cash-keypad-key-3', 3],
    ['the 8-digit ceiling holds', 99_999_999, 'cash-keypad-key-9', 99_999_999],
  ])('%s', (_label, value, key, expected) => {
    const onChange = vi.fn();
    render(<CashKeypad valueMinor={value} onChange={onChange} />);
    fireEvent.click(screen.getByTestId(key));
    expect(onChange).toHaveBeenCalledWith(expected);
  });
});

describe('QuickAmounts — one group; each chip SETS the value', () => {
  it('offers «بالضبط» then the first three banknote roll-ups, as LTR grouped money', () => {
    render(<QuickAmounts dueMinor={DUE} valueMinor={null} onSet={vi.fn()} />);
    const group = screen.getByRole('group');
    const chips = within(group).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual([
      'بالضبط',
      '100.00 EGP',
      '200.00 EGP',
      '500.00 EGP',
    ]);
    for (const chip of chips.slice(1)) {
      expect(chip.querySelector('bdi')).toHaveAttribute('dir', 'ltr');
    }
  });

  it('sets the chip value and presses only the chip equal to the field', () => {
    const onSet = vi.fn();
    render(<QuickAmounts dueMinor={DUE} valueMinor={10_000} onSet={onSet} />);
    fireEvent.click(screen.getByRole('button', { name: '200.00 EGP' }));
    expect(onSet).toHaveBeenCalledWith(20_000);
    const pressed = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((b) => b.textContent)).toEqual(['100.00 EGP']);
  });

  it.each([0, -1, Number.NaN])('renders nothing for a due of %s', (due) => {
    render(<QuickAmounts dueMinor={due} valueMinor={null} onSet={vi.fn()} />);
    expect(screen.queryByRole('group')).toBeNull();
  });
});

describe('CashEntry in Checkout — the money stays in the pinned column (RT-255 item 1)', () => {
  it('puts focus in the amount field when the entry opens (freeze 15 §3.2)', async () => {
    await openCash();
    expect(screen.getByTestId('cash-entry-amount-input')).toHaveFocus();
  });

  it('previews the change in the ledger, not in the scrolling tender panel (S9)', async () => {
    await openCash();
    type('100');
    const preview = within(ledger()).getByTestId('payment-ledger-draft-change');
    expect(preview).toHaveTextContent('الباقي للعميل 37.70 EGP');
    expect(within(preview).getByText('37.70 EGP')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('cash-entry')).not.toHaveTextContent('الباقي للعميل');
    // The preview is not recorded money.
    expect(screen.queryByTestId('payment-ledger')).not.toBeInTheDocument();
  });

  it('shows a shortfall as M-P4, and a partial apply stays possible (split tender, T154)', async () => {
    await openCash();
    type('50');
    const notice = within(ledger()).getByTestId('payment-ledger-draft-shortfall');
    expect(notice).toHaveTextContent('المبلغ المستلم أقل من المستحق بـ 12.30 EGP.');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveAttribute('data-tone', 'warning');
    expect(screen.getByTestId('cash-entry-confirm')).toBeEnabled();
  });

  it('shows nothing extra for exact cash', async () => {
    await openCash();
    fireEvent.click(screen.getByTestId('quick-amount-exact'));
    expect(screen.queryByTestId('payment-ledger-draft')).not.toBeInTheDocument();
  });

  it('is never animated: the final value at once and on every change (UX-06)', async () => {
    await openCash();
    vi.useFakeTimers();
    try {
      type('100');
      expect(screen.getByTestId('payment-ledger-draft-change').textContent).toBe(
        'الباقي للعميل 37.70 EGP',
      );
      type('200');
      expect(screen.getByTestId('payment-ledger-draft-change').textContent).toBe(
        'الباقي للعميل 137.70 EGP',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('groups thousands', async () => {
    await openCash(100_000);
    type('2250');
    expect(screen.getByTestId('payment-ledger-draft-change')).toHaveTextContent('1,250.00 EGP');
  });

  it("after apply shows main's recorded change once, in the ledger, with the entry still open", async () => {
    await openCash();
    type('100');
    await apply();
    expect(screen.getByTestId('cash-entry')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-ledger-draft')).not.toBeInTheDocument();
    expect(within(ledger()).getByTestId('payment-ledger-change')).toHaveTextContent(
      'الباقي للعميل 37.70 EGP',
    );
    expect(screen.getAllByText('الباقي للعميل', { exact: false })).toHaveLength(1);
  });

  it('drops the preview when Esc closes the entry, and does not bring it back on reopen', async () => {
    await openCash();
    type('100');
    expect(screen.getByTestId('payment-ledger-draft')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.queryByTestId('cash-entry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-ledger-draft')).not.toBeInTheDocument();
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await screen.findByTestId('cash-entry');
    expect(screen.queryByTestId('payment-ledger-draft')).not.toBeInTheDocument();
  });

  it('previews against what is still owed after a partial apply', async () => {
    await openCash();
    type('50');
    await apply();
    // Back on the tiles; 12.30 still owed.
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await screen.findByTestId('cash-entry');
    type('20');
    expect(screen.getByTestId('payment-ledger-draft-change')).toHaveTextContent('7.70 EGP');
    expect(screen.getByTestId('payment-ledger')).toHaveTextContent('50.00 EGP');
  });

  it('is axe-clean with a change preview and with a shortfall', async () => {
    await openCash();
    type('100');
    await expectNoAxeViolations(document.body);
    type('50');
    await expectNoAxeViolations(document.body);
  });
});

describe('cash entry CSS — tripwires (jsdom loads no CSS)', () => {
  const css = readFileSync(resolve(__dirname, '../checkout.css'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const legacy = readFileSync(resolve(__dirname, '../../../styles/tailwind.css'), 'utf-8');

  it('the legacy chip and keypad rules are gone (one implementation)', () => {
    expect(legacy).not.toMatch(/\.quick-amount-btn|\.amount-pad|\.change-row__value--positive/);
  });

  it('pressing a chip never changes its size (no border-width change)', () => {
    const pressed = css.match(/\.v5-quick-amount\[aria-pressed='true'\]\s*\{[^}]*\}/g) ?? [];
    expect(pressed.length).toBeGreaterThanOrEqual(2);
    for (const rule of pressed) expect(rule).not.toMatch(/border(-width)?:\s*\d/);
  });

  it('a pressed chip keeps a system highlight under forced colours', () => {
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced).toMatch(/\.v5-quick-amount\[aria-pressed='true'\]\s*\{[^}]*Highlight/);
    expect(forced).toMatch(/\.v5-cash-keypad__key[^{]*\{[^}]*ButtonText/);
  });

  it('no cash control draws its own focus treatment over the frame ring', () => {
    expect(css).not.toMatch(/\.v5-(quick-amount|cash-keypad__key|cash__input)[^{]*:focus-visible/);
    expect(css).not.toMatch(/\.v5-cash__input:focus\s*\{[^}]*outline:\s*(none|0)/);
  });

  it('keys and chips keep the 44px floor at both densities', () => {
    const sized = css.match(/\.v5-cash-keypad__key\s*\{[^}]*min-block-size:\s*(\d+)px/g) ?? [];
    expect(sized.length).toBeGreaterThanOrEqual(2);
    for (const rule of sized) {
      expect(Number(/min-block-size:\s*(\d+)px/.exec(rule)?.[1])).toBeGreaterThanOrEqual(44);
    }
  });
});
