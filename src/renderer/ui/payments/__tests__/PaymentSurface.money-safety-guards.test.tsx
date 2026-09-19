import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type {
  PaymentsBridgeAPI,
  TenderBridgeAPI,
  SalesBridgeAPI,
} from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';

/**
 * 022 — coverage for `PaymentSurface`'s money-safety and bridge-absence guards.
 *
 * WHY THIS FILE EXISTS: removing the receipt block (external review P1) shrank
 * the file, so the same pre-existing uncovered branches now weigh more and
 * `src/renderer/ui/**` dropped below its 90% branch threshold. The honest fix
 * is to COVER those branches, not to lower the gate — and they are worth
 * covering on their own merits: they are the Constitution §II
 * `Number.isSafeInteger` money guards, the exact code that stops a malformed
 * minor value producing a float-tainted running sum.
 *
 * These guards are deliberately hard to reach through the UI (they exist for
 * states the main process should never emit), so the bridge doubles here return
 * the malformed projections directly.
 */

function makeEnvelope(subtotalMinor = 5000): PaymentIntentEnvelope {
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
    created_at: '2026-09-19T09:00:00.000Z',
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
        started_at: '2026-09-19T08:00:00.000Z',
      },
    },
  });
}

/** A line projection with an arbitrary applied amount (possibly malformed). */
function line(amountAppliedMinor: number, id = 'tl-1') {
  return {
    tender_line_id: id,
    tender_type: 'cash' as const,
    state: 'applied' as const,
    amount_applied_minor: amountAppliedMinor,
    applied_at: '2026-09-19T09:59:30.000Z',
    apply_order: 1,
  };
}

/**
 * A bridge whose `payments.read` returns whatever tender lines the test wants,
 * so the accumulator guards can be driven directly.
 */
function makeBridge(lines: ReturnType<typeof line>[]): {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  sales?: SalesBridgeAPI;
} {
  const attempt = {
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: 5000,
    started_at: '2026-09-19T09:59:00.000Z',
    tender_lines: lines,
  };
  const payments = {
    start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
    read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt: attempt })),
    confirm: vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, settled_at: '2026-09-19T10:00:00.000Z' }),
    ),
    cancel: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
  } as unknown as PaymentsBridgeAPI;
  const tender = {
    apply: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
  } as unknown as TenderBridgeAPI;
  return { payments, tender };
}

beforeEach(() => {
  signIn();
  usePaymentStore.getState().mount(makeEnvelope());
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
});

describe('022 — Constitution §II money-safety guards (CR-11)', () => {
  it('skips a tender line whose applied amount is not a safe integer', async () => {
    // A malformed minor value must not enter the running sum at all. The line
    // still EXISTS (state 'applied'), so the confirm affordance is offered —
    // what the guard protects is the running TOTAL, which must never be
    // float-tainted. The surface simply must not crash or settle on it.
    const bridge = makeBridge([line(Number.NaN)]);
    render(<PaymentSurface _testBridge={bridge} />);

    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Survived the malformed projection without throwing, and did not settle.
    expect(screen.getByTestId('payment-surface')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-settled')).not.toBeInTheDocument();
  });

  it('bails out without changing phase when the running sum overflows', async () => {
    // Two lines that are individually safe but whose SUM is not. The guard
    // must stop rather than let a float-tainted total drive the surface.
    const half = Number.MAX_SAFE_INTEGER;
    const bridge = makeBridge([line(half, 'tl-1'), line(half, 'tl-2')]);
    render(<PaymentSurface _testBridge={bridge} />);

    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The surface must not have settled or advanced on an unsafe total.
    expect(screen.queryByTestId('payment-surface-settled')).not.toBeInTheDocument();
  });

  it('degrades safely when no bridge is present (Slice-1 fall-back)', async () => {
    // `bridge === null` guards several handlers; with no _testBridge and no
    // window.api the surface must still render rather than throw.
    render(<PaymentSurface />);
    expect(await screen.findByTestId('payment-surface')).toBeInTheDocument();
    // Selecting a tender is a safe no-op: no bridge call is possible.
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    expect(screen.getByTestId('payment-surface')).toBeInTheDocument();
  });
});
