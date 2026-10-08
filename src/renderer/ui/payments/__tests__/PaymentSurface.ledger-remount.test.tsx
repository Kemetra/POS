/**
 * RT-243 W1-C — F1 (RT-241 packaged report 11249): recorded tender stays
 * visible when the Checkout entry is not open.
 *
 * Packaged R-pkg: a fully applied 13.00 EGP cash tender stayed in main/DB while
 * a resize below 1024 and back remounted Checkout. The surface came back in
 * tender selection with the entry closed, and the only place applied money was
 * ever shown was inside that entry. The cashier saw «المبلغ المستحق 0.00» and a
 * commit, but no method and no amount.
 *
 * The recorded lines come from the payment projection (`paymentSlice`), which
 * the store keeps across a remount. They are listed in the pinned amount band,
 * apart from what is still due, for every applied line: exact, partial,
 * with change, card, and mixed. Nothing here infers a settle or a print.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type {
  PaymentAttemptRendererView,
  TenderLineRendererView,
} from '../../../../shared/payments/types.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { expectNoAxeViolations } from '../../primitives/__tests__/axe-config.js';
import { PaymentSurface } from '../PaymentSurface.js';

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
  subtotal_minor: 1300,
  created_at: '2026-10-08T09:00:00.000Z',
  handoff_action_id: 'hid-001',
};

function line(
  id: string,
  tender_type: TenderLineRendererView['tender_type'],
  amount_applied_minor: number,
  apply_order: number,
  extra: Partial<TenderLineRendererView> = {},
): TenderLineRendererView {
  return {
    tender_line_id: id,
    tender_type,
    state: 'applied',
    amount_applied_minor,
    applied_at: '2026-10-08T09:01:00.000Z',
    apply_order,
    ...extra,
  };
}

function attempt(lines: readonly TenderLineRendererView[]): PaymentAttemptRendererView {
  return {
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: ENVELOPE.subtotal_minor,
    started_at: '2026-10-08T09:00:30.000Z',
    tender_lines: lines,
  };
}

function makeBridge(): { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI } {
  return {
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
      read: vi.fn(() => Promise.resolve({ kind: 'refused' as const, reason: 'internal_error' })),
      confirm: vi.fn(),
      cancel: vi.fn(),
    } as unknown as PaymentsBridgeAPI,
    tender: { apply: vi.fn() } as unknown as TenderBridgeAPI,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

function mountSurface(bridge: ReturnType<typeof makeBridge>): void {
  render(
    <PaymentSurface
      _testBridge={bridge}
      onBackToSale={() => Promise.resolve(true)}
      onNewSale={vi.fn()}
    />,
  );
}

/** Opens the cash entry on an attempt holding `lines` (the state before the resize). */
async function openWith(
  bridge: ReturnType<typeof makeBridge>,
  lines: readonly TenderLineRendererView[],
): Promise<void> {
  mountSurface(bridge);
  await act(async () => {
    screen.getByTestId('tender-cash').click();
    await Promise.resolve();
  });
  await settle();
  act(() => {
    usePaymentStore.getState().applyAttemptSnapshot(attempt(lines));
  });
  await settle();
}

/** The V5Frame unmounts Checkout below 1024 and mounts it again on return. */
async function remount(bridge: ReturnType<typeof makeBridge>): Promise<void> {
  cleanup();
  mountSurface(bridge);
  await settle();
}

function ledgerRows(): string[] {
  const ledger = screen.getByTestId('payment-ledger');
  return within(ledger)
    .getAllByTestId('payment-ledger-line')
    .map((row) => row.textContent);
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
        started_at: '2026-10-08T08:00:00.000Z',
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

const CASES: readonly {
  name: string;
  lines: readonly TenderLineRendererView[];
  rows: readonly string[];
  due: string;
  change: string | null;
}[] = [
  {
    name: 'cash exactly applied (the packaged case)',
    lines: [line('tl-1', 'cash', 1300, 1)],
    rows: ['نقدي13.00 EGP'],
    due: '0.00 EGP',
    change: null,
  },
  {
    name: 'partial cash with money still due',
    lines: [line('tl-1', 'cash', 500, 1)],
    rows: ['نقدي5.00 EGP'],
    due: '8.00 EGP',
    change: null,
  },
  {
    name: 'cash with change',
    lines: [line('tl-1', 'cash', 2000, 1, { change_due_minor: 700 })],
    rows: ['نقدي20.00 EGP'],
    due: '0.00 EGP',
    change: '7.00 EGP',
  },
  {
    name: 'an external-card line',
    lines: [line('tl-1', 'external_card_terminal', 1300, 1)],
    rows: ['بطاقة13.00 EGP'],
    due: '0.00 EGP',
    change: null,
  },
  {
    name: 'mixed tender (card, then cash with change), in apply order',
    lines: [
      line('tl-2', 'cash', 1000, 2, { change_due_minor: 200 }),
      line('tl-1', 'external_card_terminal', 500, 1),
    ],
    rows: ['بطاقة5.00 EGP', 'نقدي10.00 EGP'],
    due: '0.00 EGP',
    change: '2.00 EGP',
  },
];

describe('RT-243 F1 — recorded tender survives a Checkout remount', () => {
  it.each(CASES)(
    '$name: method and amount, still due and change stay visible',
    async ({ lines, rows, due, change }) => {
      const bridge = makeBridge();
      await openWith(bridge, lines);
      await remount(bridge);

      // The surface resumes in tender selection with the entry closed…
      expect(screen.queryByTestId('payment-surface-entry')).not.toBeInTheDocument();
      // …and still shows every recorded line, apart from what is still due.
      expect(ledgerRows()).toEqual(rows);
      expect(screen.getByTestId('payment-surface-amount-due')).toHaveTextContent(due);
      const changeRow = screen.queryByTestId('payment-ledger-change');
      if (change === null) {
        expect(changeRow).not.toBeInTheDocument();
      } else {
        expect(changeRow).toHaveTextContent(`الباقي للعميل ${change}`);
      }
      // No settle or print is inferred from the reconstruction.
      expect(screen.queryByTestId('payment-surface-settled')).not.toBeInTheDocument();
      expect(screen.queryByText(/طُبع|أُرسل الإيصال|اكتمل البيع|تم استلام المبلغ/)).toBeNull();
    },
  );

  it('many split lines stay bounded: one row per method with its total, in first-apply order (Codex P2, #583)', async () => {
    const bridge = makeBridge();
    await openWith(bridge, [
      line('tl-1', 'cash', 100, 1),
      line('tl-2', 'external_card_terminal', 200, 2),
      line('tl-3', 'cash', 150, 3),
      line('tl-4', 'cash', 50, 4),
      line('tl-5', 'external_card_terminal', 300, 5),
      line('tl-6', 'cash', 500, 6, { change_due_minor: 0 }),
    ]);
    await remount(bridge);
    // At most one row per tender method (three methods exist), so the pinned
    // band cannot grow with the number of splits.
    expect(ledgerRows()).toEqual(['نقدي8.00 EGP', 'بطاقة5.00 EGP']);
    expect(screen.getByTestId('payment-surface-amount-due')).toHaveTextContent('0.00 EGP');
  });

  it('the same holds when Esc closes the entry, with no remount', async () => {
    const bridge = makeBridge();
    await openWith(bridge, [line('tl-1', 'cash', 1300, 1)]);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await settle();
    expect(screen.queryByTestId('payment-surface-entry')).not.toBeInTheDocument();
    expect(ledgerRows()).toEqual(['نقدي13.00 EGP']);
  });

  it('the remounted surface with a mixed ledger and change has no axe violations', async () => {
    const bridge = makeBridge();
    await openWith(bridge, [
      line('tl-1', 'external_card_terminal', 500, 1),
      line('tl-2', 'cash', 1000, 2, { change_due_minor: 200 }),
    ]);
    await remount(bridge);
    await expectNoAxeViolations(screen.getByTestId('payment-surface'));
  });

  it('shows no ledger before any tender is recorded', async () => {
    const bridge = makeBridge();
    await openWith(bridge, []);
    await remount(bridge);
    expect(screen.queryByTestId('payment-ledger')).not.toBeInTheDocument();
  });

  it('lists only applied lines: a line still applying or reversed is not recorded money', async () => {
    const bridge = makeBridge();
    await openWith(bridge, [
      line('tl-1', 'cash', 500, 1),
      line('tl-2', 'external_card_terminal', 800, 2, { state: 'applying' }),
      line('tl-3', 'cash', 900, 3, { state: 'reversed' }),
    ]);
    await remount(bridge);
    expect(ledgerRows()).toEqual(['نقدي5.00 EGP']);
    expect(screen.getByTestId('payment-surface-amount-due')).toHaveTextContent('8.00 EGP');
  });

  it('shows change once while the cash entry is open (the entry already shows it)', async () => {
    const bridge = makeBridge();
    await openWith(bridge, [line('tl-1', 'cash', 2000, 1, { change_due_minor: 700 })]);
    expect(screen.getByTestId('payment-surface-entry')).toBeInTheDocument();
    expect(screen.getAllByText('الباقي للعميل')).toHaveLength(1);
    expect(screen.queryByTestId('payment-ledger-change')).not.toBeInTheDocument();
  });
});
