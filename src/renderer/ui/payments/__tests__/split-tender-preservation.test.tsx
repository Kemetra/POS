/**
 * 022 US3 T075 — split tender (FR-40) survives the US3 restyle.
 *
 * WHY THIS FILE EXISTS, AND WHY IT EXISTS *NOW*
 * ---------------------------------------------
 * Multi-line tender is a SHIPPED capability (006 T154), not a US3 addition:
 * when the applied sum is still below the envelope subtotal, `handleLineApplied`
 * returns the surface to tender selection so the cashier can add another line.
 *
 * US3 restyles that exact surface. Reading the source and observing the branch
 * is still intact proves nothing — nothing has been restyled yet, so of course
 * it is. The guard only has value if it is written BEFORE the restyle touches
 * `PaymentSurface`, so a later layout change that drops the return-to-selection
 * path fails loudly instead of silently removing a capability.
 *
 * tasks.md T075 says: "assert the behaviour survives".
 *
 * SCOPE — WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
 * ------------------------------------------------------------
 * It asserts the CONTROL FLOW: a part-payment reopens tender selection; a full
 * payment does not.
 *
 * It does NOT assert that the previously-applied lines are displayed, because
 * they are not: `paymentSlice.tender_lines` is filtered into `appliedLines` and
 * used only for arithmetic — it never reaches JSX. Displaying the applied lines
 * is NEW work that must be added and tested explicitly (US3-HANDOFF.md §3), not
 * assumed into existence by a preservation test, which would leave it with no
 * test of its own and a false sense of coverage.
 */

import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
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

const SUBTOTAL_MINOR = 5000;

function makeEnvelope(subtotalMinor = SUBTOTAL_MINOR): PaymentIntentEnvelope {
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

function makeBridge(lines: ReturnType<typeof line>[]): {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  sales?: SalesBridgeAPI;
} {
  const attempt = {
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: SUBTOTAL_MINOR,
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

/**
 * Drive the REAL apply path: select cash, enter an amount, confirm.
 *
 * Selecting a tender alone is not enough — it only sets `phase: 'entry'` and
 * mounts `<CashEntry>`. `handleLineApplied` (the split-tender branch under
 * test) fires from CashEntry's `onApplied`, which requires an actual confirm.
 * A helper that stopped at the click would leave the phase untouched and every
 * assertion below would pass against a surface with the branch deleted.
 */
async function applyCashLine(amountMinor: number): Promise<void> {
  await act(async () => {
    screen.getByTestId('tender-cash').click();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });

  const input = screen.getByTestId('cash-entry-amount-input');
  await act(async () => {
    fireEvent.change(input, { target: { value: (amountMinor / 100).toFixed(2) } });
    await Promise.resolve();
  });
  await act(async () => {
    screen.getByTestId('cash-entry-confirm').click();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
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

describe('022 US3 T075 — split tender (FR-40) survives the restyle', () => {
  it('a PART payment returns the surface to tender selection', async () => {
    // 2000 of 5000 applied — still owing, so the cashier must be able to pick a
    // second tender. This is the shipped 006 T154 behaviour US3 must preserve.
    render(<PaymentSurface _testBridge={makeBridge([line(2000)])} />);
    await applyCashLine(2000);

    expect(screen.getByTestId('tender-selection')).toBeInTheDocument();
    // All three tenders are reachable again for the next line.
    expect(screen.getByTestId('tender-cash')).toBeInTheDocument();
    expect(screen.getByTestId('tender-external-card')).toBeInTheDocument();
    expect(screen.getByTestId('tender-voucher')).toBeInTheDocument();
    // A part-payment must never settle the attempt.
    expect(screen.queryByTestId('payment-surface-settled')).not.toBeInTheDocument();
  });

  it('a FULL payment does NOT bounce back — the entry surface stays open', async () => {
    // The complement of the assertion above. Without it, a surface that ALWAYS
    // reopened selection would pass the part-payment test while being broken —
    // nothing would pin the split-tender CONDITION rather than the behaviour.
    //
    // NOTE the discriminator. `<TenderSelection>` renders unconditionally
    // (PaymentSurface.tsx:489 has no phase guard), so its testid is present in
    // BOTH cases and asserting on it can never distinguish them. What actually
    // moves is `phase`: on a part payment `handleLineApplied` resets it to
    // 'tender_selection' and unmounts the entry surface; on a full payment the
    // phase is left alone and the entry surface stays mounted.
    render(<PaymentSurface _testBridge={makeBridge([line(SUBTOTAL_MINOR)])} />);
    await applyCashLine(SUBTOTAL_MINOR);

    expect(screen.getByTestId('payment-surface-entry')).toBeInTheDocument();
  });

  it('a PART payment unmounts the entry surface (the same discriminator, inverted)', async () => {
    render(<PaymentSurface _testBridge={makeBridge([line(2000)])} />);
    await applyCashLine(2000);

    expect(screen.queryByTestId('payment-surface-entry')).not.toBeInTheDocument();
  });

  it('successive part payments keep reopening tender selection', async () => {
    // Two applied lines still short of the subtotal (2000 + 2000 < 5000): the
    // cashier is mid-split and must still be able to add a third line.
    render(<PaymentSurface _testBridge={makeBridge([line(2000, 'tl-1'), line(2000, 'tl-2')])} />);
    await applyCashLine(2000);

    expect(screen.getByTestId('tender-selection')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-surface-settled')).not.toBeInTheDocument();
  });
});
