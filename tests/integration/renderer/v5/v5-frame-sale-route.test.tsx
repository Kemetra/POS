import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
 * V5 UI foundation — the DEV-only `/v5/sale` preview composes the v5 frame
 * around the existing live Sale adapter. Driven through the REAL AppRouter so
 * the operator guard, feature flags, cart/catalogue bridges and the unchanged
 * `/app/checkout` route are exercised. Production absence is proven by a
 * renderer build + bundle grep, not here: Vitest always runs with DEV = true,
 * and `vi.stubEnv('DEV', false)` does not reach the router's cast
 * `import.meta.env` read (verified: the route still rendered with it stubbed).
 */

const V5_SALE = '/v5/sale';

const CASHIER_SESSION = {
  id: 'sess-frame',
  operator_id: 'op-frame',
  display_name: 'أمل',
  role: 'cashier' as const,
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-09-24T09:00:00.000Z',
};

const ENVELOPE = {
  envelope_version: 'v1' as const,
  cart_id: 'cart-frame',
  handoff_action_id: 'handoff-frame',
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
    terminal_id: 'term-frame',
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

function renderAt(path: string): void {
  render(<AppRouter pairing={pairedBridge()} operator={operatorBridge()} initialEntry={path} />);
}

function signInCashier(flags = { cart: true, payments: true, productSearch: true }): void {
  useFeatureFlagsStore.getState().hydrate(flags);
  useOperatorSessionStore.getState().hydrateSignedIn(CASHIER_SESSION);
}

beforeEach(() => {
  resetStores();
  (window as unknown as { api?: unknown }).api = {
    cart: {
      create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-frame' }),
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

describe('/v5/sale — v5 frame + live Sale (DEV-only preview)', () => {
  it('redirects a signed-out operator to sign-in without touching the cart bridge', async () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
    renderAt(V5_SALE);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/sign-in');
    });
    expect(api().cart.create).not.toHaveBeenCalled();
    expect(screen.queryByTestId('v5-frame')).not.toBeInTheDocument();
  });

  it('renders the Sale inside one v5 frame: one main, one nav, one brand, no legacy chrome', async () => {
    signInCashier();
    renderAt(V5_SALE);

    const sale = await screen.findByRole('region', { name: 'مساحة البيع' });
    const frame = screen.getByTestId('v5-frame');
    expect(frame).toHaveAttribute('dir', 'rtl');
    expect(within(screen.getByRole('main')).getByRole('region', { name: 'مساحة البيع' })).toBe(
      sale,
    );
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByText('POS Pulse')).toHaveLength(1);
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'التنقل الرئيسي' })).getByRole('link', {
        name: 'نقطة البيع',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the existing Sale controllers as the integration path: scan → confirm → handoff → checkout', async () => {
    const user = userEvent.setup();
    signInCashier();
    renderAt(V5_SALE);

    await screen.findByRole('region', { name: 'مساحة البيع' });
    await waitFor(() => {
      expect(api().cart.create).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(useCartStore.getState().activeCart).not.toBeNull();
    });
    await user.type(
      screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' }),
      '6221000000001{Enter}',
    );
    await user.click(await screen.findByRole('button', { name: 'إضافة إلى السلة' }));
    expect(api().cart.lines.add).toHaveBeenCalledOnce();
    const handoff = await screen.findByRole('button', { name: /تسليم السلة/ });
    await waitFor(() => {
      expect(handoff).toBeEnabled();
    });
    await user.click(handoff);
    await user.click(await screen.findByRole('button', { name: /المتابعة إلى الدفع/ }));

    await waitFor(() => {
      expect(screen.getByTestId('payment-surface')).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe('/app/checkout');
    expect(api().cart.handoff).toHaveBeenCalledOnce();
    expect(usePaymentStore.getState().envelope).toEqual(ENVELOPE);
  });

  it('respects the cart flag: off → the existing disabled message, no cart created', async () => {
    signInCashier({ cart: false, payments: true, productSearch: true });
    renderAt(V5_SALE);
    expect(await screen.findByText('سلة البيع غير مفعّلة على هذا الجهاز بعد.')).toBeInTheDocument();
    expect(screen.getByTestId('v5-frame')).toBeInTheDocument();
    expect(api().cart.create).not.toHaveBeenCalled();
  });

  it('respects the productSearch flag: off → cart only, no search or scan field', async () => {
    signInCashier({ cart: true, payments: true, productSearch: false });
    renderAt(V5_SALE);
    await screen.findByRole('region', { name: 'مساحة البيع' });
    expect(screen.queryByRole('textbox', { name: 'حقل التقاط مسح الباركود' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'سلة المشتريات' })).toBeInTheDocument();
  });

  it('leaves production /app/cart on the legacy shell and legacy Sale screen', async () => {
    signInCashier();
    renderAt('/app/cart');
    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('v5-frame')).not.toBeInTheDocument();
  });
});
