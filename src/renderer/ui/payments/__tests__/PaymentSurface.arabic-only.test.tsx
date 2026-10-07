/**
 * RT-240 (VNext A4) — the Checkout surface itself is Arabic only, in the states
 * a cashier reaches: choosing a method, money applied, and Completion. The
 * entry and banner sweeps in `cashier-copy-arabic-only.test.tsx` do not render
 * the action bar, the commit reasons or the settled view; this file does.
 *
 * It also pins M-C2's negative half: no cashier receipt surface ever says
 * «طُبع» ("printed"). Completion does not show M-C2 at all, because it cannot
 * tie itself to this payment's print outcome (I-7).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../shared/payments/types.js';
import type {
  PaymentsBridgeAPI,
  ReceiptsBridgeAPI,
  SalesBridgeAPI,
  TenderBridgeAPI,
} from '../../../../shared/bridge-api.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { DrawerFailureBanner } from '../../receipts/DrawerFailureBanner.js';
import { PrinterFailureBanner } from '../../receipts/PrinterFailureBanner.js';
import { ReprintAffordance } from '../../receipts/ReprintAffordance.js';
import { PaymentSurface } from '../PaymentSurface.js';
import { latinLeaks } from './latin-leaks.js';

const PRINTED = 'طُبع';

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

const APPLIED: PaymentAttemptRendererView = {
  payment_attempt_id: 'pa-001',
  state: 'started',
  envelope_subtotal_minor: 5000,
  started_at: '2026-10-07T09:59:00.000Z',
  tender_lines: [
    {
      tender_line_id: 'tl-001',
      tender_type: 'cash',
      state: 'applied',
      amount_applied_minor: 5000,
      applied_at: '2026-10-07T09:59:30.000Z',
      apply_order: 1,
    },
  ],
};

function makeBridge(): {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  sales: SalesBridgeAPI;
} {
  return {
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
      confirm: vi.fn(() =>
        Promise.resolve({ kind: 'ok' as const, settled_at: '2026-10-07T10:00:00.000Z' }),
      ),
      cancel: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    } as unknown as PaymentsBridgeAPI,
    tender: {
      apply: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    } as unknown as TenderBridgeAPI,
    sales: {
      subscribe: vi.fn(() => Promise.resolve({ kind: 'ok' as const, recent: null })),
    } as unknown as SalesBridgeAPI,
  };
}

function renderSurface(): void {
  render(
    <PaymentSurface
      _testBridge={makeBridge()}
      onBackToSale={() => Promise.resolve(true)}
      onNewSale={vi.fn()}
    />,
  );
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

describe('RT-240 — the Checkout surface is Arabic only', () => {
  it('while choosing a method (header, Back, tiles, action bar)', () => {
    renderSurface();
    expect(screen.getByTestId('payment-surface-back')).toBeInTheDocument();
    expect(latinLeaks(screen.getByTestId('payment-surface'))).toEqual([]);
  });

  it('with money applied (commit, cancel, the M-P1 reason)', async () => {
    renderSurface();
    act(() => {
      usePaymentStore.getState().applyAttemptSnapshot(APPLIED);
    });
    expect(await screen.findByTestId('payment-surface-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('payment-surface-back-blocked')).toBeInTheDocument();
    expect(latinLeaks(screen.getByTestId('payment-surface'))).toEqual([]);
  });

  it('on Completion, and it never claims the receipt was printed', async () => {
    renderSurface();
    act(() => {
      usePaymentStore.getState().applyAttemptSnapshot(APPLIED);
    });
    const confirm = await screen.findByTestId('payment-surface-confirm');
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });
    const surface = await screen.findByTestId('payment-surface');
    expect(screen.getByTestId('payment-surface-settled')).toBeInTheDocument();
    expect(latinLeaks(surface)).toEqual([]);
    expect(surface).not.toHaveTextContent(PRINTED);
  });
});

describe('RT-240 M-C2 — no cashier receipt surface says «طُبع»', () => {
  it('the printer and drawer banners, and every reprint state', async () => {
    let settle: (value: unknown) => void = () => undefined;
    const reprint = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const { container } = render(
      <>
        <PrinterFailureBanner
          printFailure={{
            sale_id: 's-1',
            failure_reason: 'printer_offline',
            has_successful_print: true,
          }}
          onReprint={vi.fn()}
          _testReceiptsBridge={{ retryPrint: vi.fn() } as unknown as ReceiptsBridgeAPI}
          _idempotencyKeyFactory={() => 'k'}
        />
        <DrawerFailureBanner
          drawerFailure={{ sale_id: 's-1', last_successful_open_at: '2026-10-07T09:00:00.000Z' }}
          onManualOverride={vi.fn()}
          now="2026-10-07T10:00:00.000Z"
        />
        <ReprintAffordance
          sale={{ sale_id: 's-1', has_successful_print: true }}
          _testReceiptsBridge={{ reprint } as unknown as ReceiptsBridgeAPI}
        />
      </>,
    );
    expect(container).not.toHaveTextContent(PRINTED);
    await act(async () => {
      screen.getByRole('button', { name: 'إعادة طباعة الإيصال' }).click();
      await Promise.resolve();
    });
    expect(container).not.toHaveTextContent(PRINTED);
    await act(async () => {
      settle({ kind: 'ok', print_event_id: 'pe-1', reprinted_at: '2026-10-07T10:01:00.000Z' });
      await Promise.resolve();
    });
    expect(container).not.toHaveTextContent(PRINTED);
  });
});
