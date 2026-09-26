import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../../../../src/renderer/router.js';
import type { OperatorBridgeAPI, PairingBridgeAPI } from '../../../../src/shared/bridge-api.js';
import type { PairingStatus } from '../../../../src/shared/pairing-types.js';
import { useOperatorSessionStore } from '../../../../src/renderer/stores/operator-session-store.js';
import { useCartStore } from '../../../../src/renderer/stores/cart-store.js';
import { useCatalogueSearchStore } from '../../../../src/renderer/stores/catalogueSearchStore.js';
import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../../src/renderer/stores/feature-flags-store.js';

/**
 * 023 slice E — the DEV-only guarded functional preview `/app/sale-v5`.
 *
 * Driven through the REAL AppRouter so the `/app` OperatorRouteGuard, the
 * feature flags and the existing `/app/checkout` route are all exercised.
 * The production-bundle absence of this route is proven separately by a
 * renderer build + grep (Vitest always runs with DEV = true).
 */

const MANAGER_SESSION = {
  id: 'sess-v5',
  operator_id: 'op-v5',
  display_name: 'Manager One',
  role: 'manager' as const,
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-09-24T09:00:00.000Z',
};

const ENVELOPE = {
  envelope_version: 'v1' as const,
  cart_id: 'cart-v5',
  handoff_action_id: 'handoff-v5',
  created_at: '2026-09-24T09:05:00.000Z',
  subtotal_minor: 1250,
  currency_code: 'EGP',
  lines: [
    {
      line_id: 'line-1',
      display_name: 'باراسيتامول',
      quantity: 1,
      unit_price_minor: 1250,
      line_subtotal_minor: 1250,
      note: null,
    },
  ],
  discount_placeholders: [],
};

function pairedBridge(): PairingBridgeAPI {
  const status: PairingStatus = {
    kind: 'paired',
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term-v5',
    terminal_label: 'Counter 1',
    paired_at: 1_735_689_600,
  };
  return {
    getStatus: vi.fn(() => Promise.resolve(status)),
    submit: vi.fn(() => Promise.reject(new Error('not used'))),
  };
}

function refused<T>(): () => Promise<T> {
  return () => Promise.resolve({ kind: 'refused', category: 'invalid_input' } as T);
}

function operatorBridge(): OperatorBridgeAPI {
  return {
    signIn: vi.fn(refused()),
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
    confirmTakeover: vi.fn(refused()),
    cancelTakeover: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
    resetCashierPin: vi.fn(refused()),
    provisionCashierPin: vi.fn(refused()),
    unlockCashier: vi.fn(refused()),
    forceCloseShift: vi.fn(refused()),
    listStuckShifts: vi.fn(() => Promise.resolve({ kind: 'stuck_shifts' as const, shifts: [] })),
    dismissShiftClosedNotice: vi.fn(() => Promise.resolve()),
  } as OperatorBridgeAPI;
}

interface ApiFixture {
  cart: {
    create: ReturnType<typeof vi.fn>;
    lines: { add: ReturnType<typeof vi.fn> };
    handoff: ReturnType<typeof vi.fn>;
  };
  catalogue: { lookupBarcode: ReturnType<typeof vi.fn> };
}

function api(): ApiFixture {
  return (window as unknown as { api: ApiFixture }).api;
}

function resetStores(): void {
  useOperatorSessionStore.getState().reset();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
}

beforeEach(() => {
  resetStores();
  (window as unknown as { api?: unknown }).api = {
    cart: {
      create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-v5' }),
      lines: {
        add: vi.fn().mockResolvedValue({
          kind: 'ok',
          line_id: 'line-1',
          display_name: 'باراسيتامول',
          unit_price_minor: 1250,
          line_subtotal_minor: 1250,
          quantity: 1,
          version: 1,
          merged: false,
        }),
        update: vi.fn(),
        remove: vi.fn(),
        setNote: vi.fn(),
      },
      discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
      void: vi.fn(),
      handoff: vi.fn().mockResolvedValue({ kind: 'ok', envelope: ENVELOPE }),
      subscribe: vi.fn(),
    },
    catalogue: {
      lookupBarcode: vi.fn().mockResolvedValue({
        kind: 'one',
        product: {
          product_id: 'p-1',
          display_name_ar: 'باراسيتامول',
          price_minor: 1250,
          active: true,
          controlled_substance: false,
          prescription_required: false,
        },
      }),
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
  resetStores();
  delete (window as unknown as { api?: unknown }).api;
});

describe('/app/sale-v5 guarded functional preview (023 slice E)', () => {
  it('redirects a signed-out operator to sign-in without touching the cart bridge', async () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
    render(
      <AppRouter
        pairing={pairedBridge()}
        operator={operatorBridge()}
        initialEntry="/app/sale-v5"
      />,
    );
    await waitFor(() => {
      expect(window.location.pathname).toBe('/sign-in');
    });
    expect(api().cart.create).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'مساحة البيع' })).not.toBeInTheDocument();
  });

  it('scan → confirm → handoff → Continue reaches the unchanged /app/checkout PaymentSurface', async () => {
    const user = userEvent.setup();
    useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
    useOperatorSessionStore.getState().hydrateSignedIn(MANAGER_SESSION);
    render(
      <AppRouter
        pairing={pairedBridge()}
        operator={operatorBridge()}
        initialEntry="/app/sale-v5"
      />,
    );

    await screen.findByRole('region', { name: 'مساحة البيع' });
    // No cart until the first confirmed add creates it (#466).
    expect(api().cart.create).not.toHaveBeenCalled();
    await user.type(
      screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' }),
      '6221000000001{Enter}',
    );
    await user.click(await screen.findByRole('button', { name: 'إضافة إلى السلة' }));
    await waitFor(() => {
      expect(useCartStore.getState().activeCart).not.toBeNull();
    });
    expect(api().cart.create).toHaveBeenCalledOnce();
    const handoff = await screen.findByRole('button', { name: /تسليم السلة/ });
    await waitFor(() => {
      expect(handoff).toBeEnabled();
    });
    await user.click(handoff);
    const proceed = await screen.findByRole('button', { name: /المتابعة إلى الدفع/ });
    expect(proceed).toBeEnabled();
    await user.click(proceed);

    await waitFor(() => {
      expect(screen.getByTestId('payment-surface')).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe('/app/checkout');
    expect(api().cart.handoff).toHaveBeenCalledOnce();
    expect(usePaymentStore.getState().envelope).toEqual(ENVELOPE);
  });
});
