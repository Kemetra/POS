import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../../../../../src/renderer/router.js';
import type { OperatorBridgeAPI, PairingBridgeAPI } from '../../../../../src/shared/bridge-api.js';
import type { PairingStatus } from '../../../../../src/shared/pairing-types.js';
import { useOperatorSessionStore } from '../../../../../src/renderer/stores/operator-session-store.js';
import { useCartStore } from '../../../../../src/renderer/stores/cart-store.js';
import { usePaymentStore } from '../../../../../src/renderer/stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../../../src/renderer/stores/feature-flags-store.js';

/**
 * 006-payments-tender — cart → checkout wiring (integration).
 *
 * Regression for the production gap found during the POS-011-S5 smoke:
 * <PaymentSurface> was built + unit-tested but NEVER mounted in the running
 * app, and "Continue to payment" only called usePaymentStore.mount(envelope)
 * — it never navigated anywhere, so clicking it did nothing visible.
 *
 * This test drives the REAL route composition through AppRouter (not a
 * hand-mocked tree): a signed-in manager on a frozen cart at /app/cart with
 * an envelope in the payment store and the payments flag on. Clicking
 * "Continue to payment" must:
 *   1. navigate to /app/checkout, and
 *   2. mount the live PaymentSurface (data-testid="payment-surface").
 *
 * It also asserts the flag-OFF fallback: /app/checkout renders the reserved
 * CheckoutPlaceholder, not PaymentSurface.
 */

const MANAGER_SESSION = {
  id: 'sess-checkout',
  operator_id: 'op-checkout',
  display_name: 'Manager One',
  role: 'manager' as const,
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-06-11T09:00:00.000Z',
};

function makeEnvelope() {
  return {
    envelope_version: 'v1' as const,
    cart_id: 'cart-checkout',
    handoff_action_id: 'handoff-checkout',
    created_at: '2026-06-11T09:05:00.000Z',
    subtotal_minor: 1250,
    currency_code: 'EGP',
    lines: [
      {
        line_id: 'line-1',
        display_name: 'Paracetamol 500mg Tablets',
        quantity: 1,
        unit_price_minor: 1250,
        line_subtotal_minor: 1250,
        note: null,
      },
    ],
    discount_placeholders: [],
  };
}

function pairedBridge(): PairingBridgeAPI {
  const status: PairingStatus = {
    kind: 'paired',
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term-checkout',
    terminal_label: 'Counter 1',
    paired_at: 1_735_689_600,
  };
  return {
    getStatus: vi.fn(() => Promise.resolve(status)),
    submit: vi.fn(() => Promise.reject(new Error('not used'))),
  };
}

function operatorBridge(): OperatorBridgeAPI {
  return {
    signIn: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    getCurrentSession: vi.fn(() => Promise.resolve(null)),
    _reportActivity: vi.fn(),
    emitAuditEvent: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    _emitAuditEventSmoke: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    listBranchRoster: vi.fn(() => Promise.resolve({ kind: 'roster' as const, cashiers: [] })),
    confirmTakeover: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    cancelTakeover: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
    resetCashierPin: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    provisionCashierPin: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    unlockCashier: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    forceCloseShift: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    listStuckShifts: vi.fn(() => Promise.resolve({ kind: 'stuck_shifts' as const, shifts: [] })),
    dismissShiftClosedNotice: vi.fn(() => Promise.resolve()),
  };
}

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  // window.api so CatalogueSalePane's eager-create + PaymentSurface bridge reads
  // don't throw under jsdom. PaymentSurface degrades to Slice-1 (no bridge) which
  // still renders the tender-selection surface.
  (window as unknown as { api?: unknown }).api = {
    cart: {
      create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-checkout' }),
      lines: { add: vi.fn(), update: vi.fn(), remove: vi.fn(), setNote: vi.fn() },
      discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
      void: vi.fn(),
      handoff: vi.fn(),
      subscribe: vi.fn(),
    },
    catalogue: {
      lookupBarcode: vi.fn(),
      lookupSku: vi.fn(),
      search: vi.fn(),
      resolve: vi.fn(),
      refresh: vi.fn(() => Promise.resolve({ kind: 'refused', reason: 'no_session' })),
      freshness: vi.fn(() =>
        Promise.resolve({ kind: 'ok', last_success_at: null, is_empty: true }),
      ),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useOperatorSessionStore.getState().reset();
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

describe('cart → checkout wiring (006 mount)', () => {
  it('Continue to payment navigates to /app/checkout and mounts PaymentSurface', async () => {
    // Drive the REAL flow end-to-end through AppRouter so the load-bearing seam
    // — CartWorkspace actually wiring onPaymentContinue → navigate — is exercised,
    // not stubbed. Use the SCAN path (lookupBarcode) to skip the typed-search
    // debounce. The handoff is what hydrates CartPane's LOCAL envelope, which is
    // why the frozen state can't simply be seeded into the store.
    const user = userEvent.setup();
    useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
    useOperatorSessionStore.getState().hydrateSignedIn(MANAGER_SESSION);

    const envelope = makeEnvelope();
    const api = (
      window as unknown as {
        api: {
          cart: {
            create: ReturnType<typeof vi.fn>;
            lines: { add: ReturnType<typeof vi.fn> };
            handoff: ReturnType<typeof vi.fn>;
          };
          catalogue: { lookupBarcode: ReturnType<typeof vi.fn> };
        };
      }
    ).api;
    api.catalogue.lookupBarcode = vi.fn().mockResolvedValue({
      kind: 'one',
      product: {
        product_id: 'p-1',
        display_name_ar: 'Paracetamol 500mg Tablets',
        price_minor: 1250,
        active: true,
        controlled_substance: false,
        prescription_required: false,
      },
    });
    api.cart.lines.add = vi.fn().mockResolvedValue({
      kind: 'ok',
      line_id: 'line-1',
      display_name: 'Paracetamol 500mg Tablets',
      unit_price_minor: 1250,
      line_subtotal_minor: 1250,
      quantity: 1,
      version: 1,
      merged: false,
    });
    api.cart.handoff = vi.fn().mockResolvedValue({ kind: 'ok', envelope });

    render(
      <AppRouter pairing={pairedBridge()} operator={operatorBridge()} initialEntry="/app/cart" />,
    );

    // No cart exists yet: the first confirmed add creates it (#466).
    expect(api.cart.create).not.toHaveBeenCalled();

    // Scan → single match → confirm_pending → Add.
    const scan = await screen.findByTestId('scan-capture-field');
    await user.type(scan, '6221000000001');
    fireEvent.keyDown(scan, { key: 'Enter' });
    const addBtn = await screen.findByRole('button', { name: /Add/ });
    await user.click(addBtn);

    // Line added → cart editing → Hand off to payment.
    const handoffBtn = await screen.findByTestId('cart-handoff-button');
    await waitFor(() => expect(handoffBtn).toBeEnabled());
    await user.click(handoffBtn);

    // Frozen → HandoffSummary with the now-enabled Continue button.
    const continueBtn = await screen.findByTestId('handoff-continue-button');
    expect(continueBtn).toBeEnabled();
    await user.click(continueBtn);

    // Load-bearing wiring assertion: the live payment surface mounts on checkout.
    await waitFor(() => expect(screen.getByTestId('payment-surface')).toBeInTheDocument());
    expect(window.location.pathname).toBe('/app/checkout');
  });

  it('drives the full single-tender path: scan → add → handoff → tender → confirm → settled → New sale → /app/cart', async () => {
    // P0 smoke chain as an integration test (the one path the ticket is about),
    // driven through the REAL AppRouter so every seam is exercised wired, not
    // stubbed. The recent-sale poll returns a STALE prior sale on the first
    // call (finalized BEFORE this settled_at) to prove the surface ignores it
    // and waits for THIS sale — the timing bug that a unit mock can't catch.
    const user = userEvent.setup();
    useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
    useOperatorSessionStore.getState().hydrateSignedIn(MANAGER_SESSION);

    const envelope = makeEnvelope();
    const settledAt = '2026-06-11T09:06:00.000Z';
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    (api.catalogue as { lookupBarcode: ReturnType<typeof vi.fn> }).lookupBarcode = vi
      .fn()
      .mockResolvedValue({
        kind: 'one',
        product: {
          product_id: 'p-1',
          display_name_ar: 'Paracetamol 500mg Tablets',
          price_minor: 1250,
          active: true,
          controlled_substance: false,
          prescription_required: false,
        },
      });
    const cartApi = api.cart as {
      lines: { add: ReturnType<typeof vi.fn> };
      handoff: ReturnType<typeof vi.fn>;
    };
    cartApi.lines.add = vi.fn().mockResolvedValue({
      kind: 'ok',
      line_id: 'line-1',
      display_name: 'Paracetamol 500mg Tablets',
      unit_price_minor: 1250,
      line_subtotal_minor: 1250,
      quantity: 1,
      version: 1,
      merged: false,
    });
    cartApi.handoff = vi.fn().mockResolvedValue({ kind: 'ok', envelope });

    // The payments + tender + sales bridge for the bridged PaymentSurface path.
    api.payments = {
      start: vi.fn(() => Promise.resolve({ kind: 'ok', payment_attempt_id: 'pa-1' })),
      confirm: vi.fn(() => Promise.resolve({ kind: 'ok', settled_at: settledAt })),
      cancel: vi.fn(),
      subscribe: vi.fn(),
      read: vi.fn(() =>
        Promise.resolve({
          kind: 'ok',
          payment_attempt: {
            payment_attempt_id: 'pa-1',
            state: 'started',
            envelope_subtotal_minor: envelope.subtotal_minor,
            started_at: '2026-06-11T09:05:30.000Z',
            tender_lines: [
              {
                tender_line_id: 'tl-1',
                tender_type: 'cash',
                amount_applied_minor: envelope.subtotal_minor,
                state: 'applied',
                apply_order: 1,
                applied_at: '2026-06-11T09:05:45.000Z',
              },
            ],
          },
        }),
      ),
    };
    api.tender = {
      apply: vi.fn(() =>
        Promise.resolve({
          kind: 'ok',
          tender_line_id: 'tl-1',
          amount_applied_minor: envelope.subtotal_minor,
          change_due_minor: 0,
        }),
      ),
      reverse: vi.fn(),
      read: vi.fn(),
    };
    api.sales = {
      read: vi.fn(),
      findByNumber: vi.fn(),
      // First poll = stale prior sale (finalized before settledAt) → ignored.
      // Subsequent polls = THIS sale.
      subscribe: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'ok',
          subscription_token: 's',
          recent: {
            sale_id: 'sale-prev',
            sale_number: 'C1-0006',
            finalized_at: '2026-06-11T09:05:59.000Z',
          },
        })
        .mockResolvedValue({
          kind: 'ok',
          subscription_token: 's',
          recent: {
            sale_id: 'sale-this',
            sale_number: 'C1-0007',
            finalized_at: '2026-06-11T09:06:00.500Z',
          },
        }),
      unsubscribe: vi.fn(),
    };

    render(
      <AppRouter pairing={pairedBridge()} operator={operatorBridge()} initialEntry="/app/cart" />,
    );

    // Scan → Add (creates the cart, #466) → handoff → Continue → checkout.
    const scan = await screen.findByTestId('scan-capture-field');
    await user.type(scan, '6221000000001');
    fireEvent.keyDown(scan, { key: 'Enter' });
    await user.click(await screen.findByRole('button', { name: /Add/ }));
    const handoffBtn = await screen.findByTestId('cart-handoff-button');
    await waitFor(() => expect(handoffBtn).toBeEnabled());
    await user.click(handoffBtn);
    await user.click(await screen.findByTestId('handoff-continue-button'));

    // Tender → enter exact cash → confirm cash line → confirm payment.
    await waitFor(() => expect(screen.getByTestId('payment-surface')).toBeInTheDocument());
    await user.click(await screen.findByTestId('tender-cash'));
    const amountInput = await screen.findByTestId('cash-entry-amount-input');
    await user.type(amountInput, String(envelope.subtotal_minor));
    await user.click(await screen.findByTestId('cash-entry-confirm'));
    await user.click(await screen.findByTestId('payment-surface-confirm'));

    // Settled → the honest settled state. 022 removed the sale number: it came
    // from a terminal-wide `recent` row that cannot be tied to THIS payment
    // (see PaymentSurface.completed.test.tsx for the full rationale — 006
    // invariant 13 is superseded pending a correlating identifier). What this
    // walk still proves is the end-to-end path and the never-stuck exit below.
    await waitFor(() => expect(screen.getByTestId('payment-surface-settled')).toBeInTheDocument());
    expect(screen.queryByTestId('payment-surface-sale-number')).not.toBeInTheDocument();

    // New sale → cashier is unstuck → back on a usable cart route.
    await user.click(screen.getByTestId('payment-surface-new-sale'));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/app/cart');
    });
    expect(usePaymentStore.getState().envelope).toBeNull();
  });

  it('checkout route falls back to the reserved placeholder when payments flag is off', async () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, payments: false });
    useOperatorSessionStore.getState().hydrateSignedIn(MANAGER_SESSION);

    render(
      <AppRouter
        pairing={pairedBridge()}
        operator={operatorBridge()}
        initialEntry="/app/checkout"
      />,
    );

    await waitFor(() =>
      expect(screen.getByText(/reserved for feature 005-checkout-payments/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('payment-surface')).not.toBeInTheDocument();
  });
});
