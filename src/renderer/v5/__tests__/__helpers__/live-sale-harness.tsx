/**
 * Shared harness for the live v5 Sale tests that need a real cart in the
 * workspace: fake bridges, a signed-in cashier, and a sale built the ordinary
 * (human-speed) way through the scan field, with direct add (D-C1).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, vi } from 'vitest';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../../shared/bridge-api';
import type { ProductSnapshotDisplay } from '../../../../shared/catalogue/product-snapshot';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { LiveSaleWorkspace } from '../../sale/LiveSaleWorkspace';

export const PANADOL: ProductSnapshotDisplay = {
  product_id: 'p-1',
  display_name_ar: 'بنادول',
  price_minor: 1500,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

export const BRUFEN: ProductSnapshotDisplay = {
  product_id: 'p-2',
  display_name_ar: 'بروفين',
  price_minor: 2500,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

export function signIn(options: { productSearch?: boolean } = {}): void {
  useFeatureFlagsStore.setState({
    cart: true,
    productSearch: options.productSearch ?? true,
    payments: true,
  });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: 'صيدلي',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-09-23T20:00:00Z',
  });
}

function addResult(lineId: string, name: string, priceMinor: number): unknown {
  return {
    kind: 'ok',
    line_id: lineId,
    merged: false,
    version: 1,
    display_name: name,
    unit_price_minor: priceMinor,
    line_subtotal_minor: priceMinor,
    quantity: 1,
  };
}

export interface Bridges {
  cart: CartBridgeAPI;
  catalogue: CatalogueBridgeAPI;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  voidCart: ReturnType<typeof vi.fn>;
  lookupBarcode: ReturnType<typeof vi.fn>;
  undoLast: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
}

/** Bridges whose first two adds produce the lines بنادول then بروفين. */
export function makeBridges(): Bridges {
  const update = vi.fn().mockResolvedValue({ kind: 'ok', version: 2 });
  const remove = vi.fn().mockResolvedValue({ kind: 'ok' });
  const voidCart = vi.fn().mockResolvedValue({ kind: 'ok' });
  const undoLast = vi.fn();
  const snapshot = vi.fn();
  const lookupBarcode = vi
    .fn()
    .mockResolvedValueOnce({ kind: 'one', product: PANADOL })
    .mockResolvedValueOnce({ kind: 'one', product: BRUFEN })
    .mockResolvedValue({ kind: 'one', product: PANADOL });
  const add = vi
    .fn()
    .mockResolvedValueOnce(addResult('line-1', 'بنادول', 1500))
    .mockResolvedValueOnce(addResult('line-2', 'بروفين', 2500));
  const cart = {
    create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-1' }),
    lines: { add, update, remove, setNote: vi.fn().mockResolvedValue({ kind: 'ok', version: 2 }) },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: voidCart,
    handoff: vi.fn(),
    subscribe: vi.fn(),
    undoLast,
    snapshot,
  } as unknown as CartBridgeAPI;
  const catalogue = {
    search: vi.fn(),
    lookupBarcode,
    lookupSku: vi.fn(),
    resolve: vi.fn(),
    freshness: vi.fn().mockResolvedValue({ kind: 'ok', last_success_at: null, is_empty: true }),
    refresh: vi.fn().mockResolvedValue({ kind: 'refused', reason: 'no_session' }),
    counts: vi.fn(),
  } as unknown as CatalogueBridgeAPI;
  return { cart, catalogue, update, remove, voidCart, lookupBarcode, undoLast, snapshot, add };
}

export function renderSale(bridges: Bridges): void {
  render(
    <LiveSaleWorkspace
      cartBridge={bridges.cart}
      catalogueBridge={bridges.catalogue}
      onPaymentContinue={vi.fn()}
    />,
  );
}

/** Scan one code at human speed; the add is direct (D-C1). Waits for the NEW line to land. */
export async function addLineByScan(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const before = document.querySelectorAll('.v5-sale-cart-line').length;
  await user.type(
    screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' }),
    '6223004355218{Enter}',
  );
  await waitFor(() => {
    expect(document.querySelectorAll('.v5-sale-cart-line')).toHaveLength(before + 1);
  });
}

/** A signed-in sale with `count` lines (1 or 2) in the cart. */
export async function saleWithLines(
  bridges: Bridges,
  count = 1,
): Promise<ReturnType<typeof userEvent.setup>> {
  signIn();
  renderSale(bridges);
  const user = userEvent.setup();
  for (let i = 0; i < count; i += 1) {
    await addLineByScan(user);
  }
  bridges.lookupBarcode.mockClear();
  return user;
}
