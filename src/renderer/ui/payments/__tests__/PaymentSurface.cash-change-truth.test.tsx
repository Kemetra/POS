/**
 * RT-237 (VNext A1) — cash change truth after apply and on completion.
 *
 * Bug (RT-159 F-03): once a cash line is applied, the remaining balance is 0,
 * so `CashEntry` re-derived the change as `received − 0` and showed the AMOUNT
 * RECEIVED under «الباقي للعميل». The cashier could hand back the wrong money.
 * The completion screen showed no change at all.
 *
 * The contract pinned here: the change shown after apply, and on completion,
 * is the main-process `change_due_minor` of the applied tender line — read from
 * the payment projection, never recomputed in the renderer once the line is
 * applied. Money stays integer minor units (RT-24 I-9, unchanged).
 */

import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../shared/payments/types.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';

function makeEnvelope(subtotalMinor: number): PaymentIntentEnvelope {
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
    subtotal_minor: subtotalMinor,
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

/**
 * A bridge shaped like main: `tender.apply` records an applied line whose
 * `change_due_minor` is the authoritative overpayment (received − due), and
 * `payments.read` projects exactly that line back. The renderer is never told
 * the change any other way.
 */
function makeBridge(
  subtotalMinor: number,
  initialLines: PaymentAttemptRendererView['tender_lines'] = [],
): { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI } {
  let lines = initialLines;
  const snapshot = (): PaymentAttemptRendererView => ({
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: subtotalMinor,
    started_at: '2026-10-07T09:00:30.000Z',
    tender_lines: lines,
  });
  const payments = {
    start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
    read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt: snapshot() })),
    confirm: vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, settled_at: '2026-10-07T09:02:00.000Z' }),
    ),
    cancel: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
  } as unknown as PaymentsBridgeAPI;
  const tender = {
    apply: vi.fn((req: { amount_applied_minor: number }) => {
      const change = Math.max(req.amount_applied_minor - subtotalMinor, 0);
      lines = [
        {
          tender_line_id: 'tl-001',
          tender_type: 'cash',
          state: 'applied',
          amount_applied_minor: req.amount_applied_minor,
          ...(change > 0 ? { change_due_minor: change } : {}),
          applied_at: '2026-10-07T09:01:00.000Z',
          apply_order: 1,
        },
      ];
      return Promise.resolve({
        kind: 'ok' as const,
        tender_line_id: 'tl-001',
        applied_at: '2026-10-07T09:01:00.000Z',
        ...(change > 0 ? { change_due_minor: change } : {}),
      });
    }),
  } as unknown as TenderBridgeAPI;
  return { payments, tender };
}

async function openCash(subtotalMinor: number): Promise<ReturnType<typeof makeBridge>> {
  usePaymentStore.getState().mount(makeEnvelope(subtotalMinor));
  const bridge = makeBridge(subtotalMinor);
  render(<PaymentSurface _testBridge={bridge} />);
  await act(async () => {
    screen.getByTestId('tender-cash').click();
    await Promise.resolve();
  });
  await screen.findByTestId('cash-entry');
  return bridge;
}

async function applyCash(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('cash-entry-confirm'));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function confirmPayment(): Promise<void> {
  await act(async () => {
    fireEvent.click(await screen.findByTestId('payment-surface-confirm'));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  signIn();
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

// RT-159 packaged evidence amounts + a quick-amount chip case. One object per
// case keeps the `it.each` callback to a single argument.
interface ChangeCase {
  label: string;
  due: number;
  /** Typed received amount, or null when a quick-amount chip sets it. */
  typed: string | null;
  /** Chip received amount in minor units (used when `typed` is null). */
  chip: number | null;
  expectedChange: number;
}

const CASES: readonly ChangeCase[] = [
  {
    label: 'sale 1: typed 1000.00 against 992.25',
    due: 99_225,
    typed: '1000.00',
    chip: null,
    expectedChange: 775,
  },
  {
    label: 'offline sale: typed 100.00 against 89.50',
    due: 8_950,
    typed: '100.00',
    chip: null,
    expectedChange: 1_050,
  },
  {
    label: 'quick-amount chip: 100.00 chip against 62.30',
    due: 6_230,
    typed: null,
    chip: 10_000,
    expectedChange: 3_770,
  },
];

describe('RT-237 — change after apply equals the main-process change_due_minor', () => {
  it.each(CASES)('$label', async ({ due, typed, chip, expectedChange }) => {
    await openCash(due);

    if (typed !== null) {
      fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: typed } });
    } else {
      // Quick-amount chips SET the received amount (I-9) — click the one whose
      // value matches, found by its LTR money text.
      const chipText = `${String(Math.trunc((chip ?? 0) / 100))}.00 EGP`;
      const chipButton = within(screen.getByTestId('cash-entry'))
        .getAllByRole('button')
        .find((b) => b.textContent === chipText);
      expect(chipButton).toBeDefined();
      fireEvent.click(chipButton as HTMLElement);
    }

    // BEFORE apply: the pinned ledger previews received − due (RT-243 W1-C
    // moved it there from the scrolling entry, RT-255 item 1).
    const expectedText = `${String(Math.trunc(expectedChange / 100))}.${String(expectedChange % 100).padStart(2, '0')} EGP`;
    expect(screen.getByTestId('payment-ledger-draft-change')).toHaveTextContent(expectedText);

    await applyCash();

    // AFTER apply: the ledger must STILL show the change — main's recorded
    // `change_due_minor`, not the amount received, which is what the pre-fix
    // code showed (received − 0). The preview is gone; exactly one change row.
    expect(screen.queryByTestId('payment-ledger-draft')).not.toBeInTheDocument();
    const row = screen.getByTestId('payment-ledger-change');
    expect(row).toHaveTextContent(expectedText);
    expect(screen.getAllByText('الباقي للعميل', { exact: false })).toHaveLength(1);
    if (typed !== null) {
      expect(row).not.toHaveTextContent(`${typed} EGP`);
    }
  });
});

describe('RT-237 — completion shows the same change', () => {
  it('shows «الباقي للعميل» with the applied-line change on the settled screen', async () => {
    await openCash(99_225);
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), {
      target: { value: '1000.00' },
    });
    await applyCash();
    await confirmPayment();

    const settled = await screen.findByTestId('payment-surface-settled');
    expect(settled).toBeInTheDocument();
    const change = screen.getByTestId('payment-surface-settled-change');
    expect(change).toHaveTextContent('الباقي للعميل');
    expect(change).toHaveTextContent('7.75 EGP');
    // The change value is an LTR-isolated run inside the RTL copy.
    expect(within(change).getByText('7.75 EGP')).toHaveAttribute('dir', 'ltr');
    // The settled amount is still the amount due, not the amount received.
    expect(screen.getByTestId('payment-surface-settled-amount')).toHaveTextContent('992.25 EGP');
  });

  it('exact cash shows no change line on completion and no change row after apply', async () => {
    await openCash(5_000);
    fireEvent.click(screen.getByText('بالضبط'));
    await applyCash();
    expect(screen.queryByTestId('payment-ledger-change')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-ledger-draft')).not.toBeInTheDocument();

    await confirmPayment();
    expect(await screen.findByTestId('payment-surface-settled')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-settled-change')).not.toBeInTheDocument();
  });

  it('sums change across applied lines and ignores non-applied ones', async () => {
    usePaymentStore.getState().mount(makeEnvelope(5_000));
    const lines: PaymentAttemptRendererView['tender_lines'] = [
      {
        tender_line_id: 'tl-1',
        tender_type: 'cash',
        state: 'applied',
        amount_applied_minor: 5_500,
        change_due_minor: 500,
        applied_at: '2026-10-07T09:01:00.000Z',
        apply_order: 1,
      },
      {
        tender_line_id: 'tl-2',
        tender_type: 'cash',
        state: 'refused',
        amount_applied_minor: 9_000,
        change_due_minor: 4_000,
        apply_order: 2,
      },
    ];
    const bridge = makeBridge(5_000, lines);
    render(<PaymentSurface _testBridge={bridge} />);
    act(() => {
      usePaymentStore.getState().applyAttemptSnapshot({
        payment_attempt_id: 'pa-001',
        state: 'started',
        envelope_subtotal_minor: 5_000,
        started_at: '2026-10-07T09:00:30.000Z',
        tender_lines: lines,
      });
    });
    await confirmPayment();
    expect(await screen.findByTestId('payment-surface-settled-change')).toHaveTextContent(
      '5.00 EGP',
    );
  });
});
