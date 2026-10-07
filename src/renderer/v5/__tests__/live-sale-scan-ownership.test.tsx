/**
 * RT-239 (VNext A2) — the real Sale screen owns scans.
 *
 * Mounts `LiveSaleWorkspace` with the scan guard, adds a line the ordinary way,
 * then sends wedge bursts with focus on the line's own controls (RT-159 F-01):
 * the burst must reach the catalogue lookup and must never press `+` or `حذف`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import { ScanGuardHost, resetScanGuardForTests } from '../../scan/ScanGuardHost';
import { SCAN_DIALOG_OPEN_MESSAGE } from '../../scan/scan-messages';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetScanGuardForTests();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
});

const PANADOL: ProductSnapshotDisplay = {
  product_id: 'p-1',
  display_name_ar: 'بنادول',
  price_minor: 1500,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

function signIn(): void {
  useFeatureFlagsStore.setState({ cart: true, productSearch: true, payments: true });
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

function makeBridges(): {
  cart: CartBridgeAPI;
  catalogue: CatalogueBridgeAPI;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  lookupBarcode: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn();
  const remove = vi.fn();
  const lookupBarcode = vi.fn().mockResolvedValue({ kind: 'one', product: PANADOL });
  const add = vi.fn().mockResolvedValue({
    kind: 'ok',
    line_id: 'line-1',
    merged: false,
    version: 1,
    display_name: 'بنادول',
    unit_price_minor: 1500,
    line_subtotal_minor: 1500,
    quantity: 1,
  });
  const cart = {
    create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-1' }),
    lines: { add, update, remove, setNote: vi.fn() },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: vi.fn(),
    handoff: vi.fn(),
    subscribe: vi.fn(),
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
  return { cart, catalogue, update, remove, lookupBarcode };
}

/** A sale with one line in the cart, added the ordinary (human-speed) way. */
async function saleWithOneLine(bridges: ReturnType<typeof makeBridges>): Promise<void> {
  signIn();
  render(
    <LiveSaleWorkspace
      cartBridge={bridges.cart}
      catalogueBridge={bridges.catalogue}
      onPaymentContinue={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.type(
    screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' }),
    '6223004355218{Enter}',
  );
  await screen.findByRole('dialog', { name: 'تأكيد إضافة الصنف' });
  await user.click(screen.getByRole('button', { name: 'إضافة إلى السلة' }));
  await screen.findByRole('list', { name: 'أصناف السلة' });
  bridges.lookupBarcode.mockClear();
}

/**
 * Mount the guard AFTER the line exists, and freeze the clock so every event
 * of a burst has the same timestamp whatever the machine load.
 */
function armScanGuard(): void {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  render(<ScanGuardHost />);
}

function burst(target: Element, code: string): void {
  for (const key of code) fireEvent.keyDown(target, { key });
  fireEvent.keyDown(target, { key: 'Enter' });
}

describe('the Sale screen is the scan owner (F-01)', () => {
  it.each([
    ['زيادة كمية', /زيادة كمية/],
    ['حذف', /^حذف$/],
  ])(
    'a burst with %s focused reaches the catalogue lookup and does not press it',
    async (_name, label) => {
      const bridges = makeBridges();
      await saleWithOneLine(bridges);
      armScanGuard();
      const control = screen.getByRole('button', { name: label });
      act(() => {
        control.focus();
      });
      burst(control, '6223004355218');
      await waitFor(() => {
        expect(bridges.lookupBarcode).toHaveBeenCalledWith({ barcode: '6223004355218' });
      });
      expect(bridges.update).not.toHaveBeenCalled();
      expect(bridges.remove).not.toHaveBeenCalled();
      await screen.findByRole('dialog', { name: 'تأكيد إضافة الصنف' });
    },
  );

  it('a second burst while the add dialog is open is refused, not lost silently', async () => {
    const bridges = makeBridges();
    await saleWithOneLine(bridges);
    armScanGuard();
    const body = document.body;
    burst(body, '6223004355218');
    const dialog = await screen.findByRole('dialog', { name: 'تأكيد إضافة الصنف' });
    bridges.lookupBarcode.mockClear();
    burst(dialog, '6223004355219');
    expect(await screen.findByText(SCAN_DIALOG_OPEN_MESSAGE)).toBeInTheDocument();
    expect(bridges.lookupBarcode).not.toHaveBeenCalled();
  });

  it('a burst typed into the search field is a scan and clears the field', async () => {
    const bridges = makeBridges();
    await saleWithOneLine(bridges);
    armScanGuard();
    const search = screen.getByLabelText<HTMLInputElement>('البحث بالاسم أو الباركود');
    act(() => {
      search.focus();
    });
    for (const key of '6223004355218') {
      fireEvent.keyDown(search, { key });
      fireEvent.change(search, { target: { value: search.value + key } });
    }
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => {
      expect(bridges.lookupBarcode).toHaveBeenCalledWith({ barcode: '6223004355218' });
    });
    expect(search).toHaveValue('');
  });
});
