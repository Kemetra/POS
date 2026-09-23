import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';
import '@testing-library/jest-dom/vitest';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
});

type Role = 'cashier' | 'manager' | 'admin';

const PANADOL: ProductSnapshotDisplay = {
  product_id: 'p-1',
  display_name_ar: 'بنادول',
  price_minor: 1500,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

const ENVELOPE = {
  envelope_version: 'v1' as const,
  cart_id: 'cart-1',
  operator_session_id: 'session-1',
  owning_operator_id: 'op-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  lines: [],
  discount_placeholders: [],
  subtotal_minor: 1500,
  created_at: '2026-09-23T20:00:00Z',
  handoff_action_id: 'handoff-1',
};

function signIn(role: Role = 'cashier'): void {
  useFeatureFlagsStore.setState({ cart: true, productSearch: true, payments: true });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: 'صيدلي',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-09-23T20:00:00Z',
  });
}

function makeBridges(): {
  cart: CartBridgeAPI;
  catalogue: CatalogueBridgeAPI;
  fns: {
    create: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    setNote: ReturnType<typeof vi.fn>;
    voidCart: ReturnType<typeof vi.fn>;
    handoff: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    lookupBarcode: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  };
} {
  const fns = {
    create: vi.fn().mockResolvedValue({ kind: 'ok', cart_id: 'cart-1' }),
    add: vi.fn().mockResolvedValue({
      kind: 'ok',
      line_id: 'line-1',
      merged: false,
      version: 1,
      display_name: 'بنادول',
      unit_price_minor: 1500,
      line_subtotal_minor: 1500,
      quantity: 1,
    }),
    update: vi.fn(),
    remove: vi.fn().mockResolvedValue({ kind: 'ok' }),
    setNote: vi.fn().mockResolvedValue({ kind: 'ok', version: 2 }),
    voidCart: vi.fn().mockResolvedValue({ kind: 'ok' }),
    handoff: vi.fn().mockResolvedValue({ kind: 'ok', envelope: ENVELOPE }),
    search: vi.fn(),
    lookupBarcode: vi.fn().mockResolvedValue({ kind: 'one', product: PANADOL }),
    refresh: vi.fn().mockResolvedValue({ kind: 'refused', reason: 'no_session' }),
  };
  const cart = {
    create: fns.create,
    lines: { add: fns.add, update: fns.update, remove: fns.remove, setNote: fns.setNote },
    discountPlaceholders: { add: vi.fn(), remove: vi.fn() },
    void: fns.voidCart,
    handoff: fns.handoff,
    subscribe: vi.fn(),
  } as unknown as CartBridgeAPI;
  const catalogue = {
    search: fns.search,
    lookupBarcode: fns.lookupBarcode,
    lookupSku: vi.fn(),
    resolve: vi.fn(),
    freshness: vi.fn().mockResolvedValue({ kind: 'ok', last_success_at: null, is_empty: true }),
    refresh: fns.refresh,
    counts: vi.fn(),
  } as unknown as CatalogueBridgeAPI;
  return { cart, catalogue, fns };
}

function renderSale(bridges: ReturnType<typeof makeBridges>, onPaymentContinue = vi.fn()): void {
  render(
    <LiveSaleWorkspace
      cartBridge={bridges.cart}
      catalogueBridge={bridges.catalogue}
      onPaymentContinue={onPaymentContinue}
    />,
  );
}

async function scanAndOpenConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => {
    expect(useCartStore.getState().activeCart).not.toBeNull();
  });
  const scan = screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' });
  await user.type(scan, '6223004355218{Enter}');
  await screen.findByRole('dialog', { name: 'تأكيد إضافة الصنف' });
}

async function addOneLine(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await scanAndOpenConfirm(user);
  await user.click(screen.getByRole('button', { name: 'إضافة إلى السلة' }));
  await screen.findByRole('list', { name: 'أصناف السلة' });
}

describe('live v5 Sale adapter', () => {
  it('scans, confirms, hands off, then mounts the existing payment envelope', async () => {
    signIn();
    const bridges = makeBridges();
    const onPaymentContinue = vi.fn();
    renderSale(bridges, onPaymentContinue);
    const user = userEvent.setup();
    await scanAndOpenConfirm(user);
    expect(bridges.fns.add).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'إضافة إلى السلة' }));
    await waitFor(() => {
      expect(screen.getAllByText('15.00 EGP').length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole('button', { name: /تسليم السلة/ }));
    await waitFor(() => {
      expect(bridges.fns.handoff).toHaveBeenCalledOnce();
    });
    await user.click(screen.getByRole('button', { name: /المتابعة إلى الدفع/ }));
    expect(onPaymentContinue).toHaveBeenCalledOnce();
    expect(usePaymentStore.getState().envelope).toEqual(ENVELOPE);
  });

  it('does not call business bridges before session and feature gates', () => {
    const create = vi.fn();
    const cart = { create } as unknown as CartBridgeAPI;
    const catalogue = { freshness: vi.fn() } as unknown as CatalogueBridgeAPI;
    const view = (): JSX.Element => (
      <LiveSaleWorkspace
        cartBridge={cart}
        catalogueBridge={catalogue}
        onPaymentContinue={vi.fn()}
      />
    );
    const { rerender } = render(view());
    expect(create).not.toHaveBeenCalled();
    useOperatorSessionStore.getState().hydrateSignedIn({
      id: 'session-1',
      operator_id: 'op-1',
      display_name: 'صيدلي',
      role: 'cashier',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      started_at: '2026-09-23T20:00:00Z',
    });
    rerender(view());
    expect(create).not.toHaveBeenCalled();
    useFeatureFlagsStore.setState({ cart: true, productSearch: false });
    rerender(view());
    expect(create).not.toHaveBeenCalled();
  });

  it('starts with an honest empty search and no static demo products or totals', async () => {
    signIn();
    const bridges = makeBridges();
    renderSale(bridges);
    await waitFor(() => {
      expect(bridges.fns.create).toHaveBeenCalledOnce();
    });
    expect(screen.queryByText('بنادول أدفانس 500 مجم أقراص')).not.toBeInTheDocument();
    expect(screen.getByText(/لم يُنزّل الكتالوج بعد/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /تسليم السلة/ })).toBeDisabled();
    expect(screen.getByText(/لا توجد أصناف في السلة/)).toBeInTheDocument();
    act(() => {
      useCatalogueSearchStore.getState().beginSearch('بنادول');
    });
    expect(screen.getByText(/جارٍ البحث/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /تحديث الكتالوج/ }));
    await waitFor(() => {
      expect(bridges.fns.refresh).toHaveBeenCalledOnce();
    });
    expect(screen.queryByText(/no_session/)).not.toBeInTheDocument();
  });

  it('moves focus to Add when confirm opens; Escape cancels without a write and returns to search', async () => {
    signIn();
    const bridges = makeBridges();
    renderSale(bridges);
    const user = userEvent.setup();
    await scanAndOpenConfirm(user);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'إضافة إلى السلة' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'تأكيد إضافة الصنف' })).not.toBeInTheDocument();
    expect(bridges.fns.add).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole('searchbox', { name: 'البحث بالاسم أو الباركود' }),
    );
  });

  it('typed search lists only real result fields and supports keyboard selection into confirm', async () => {
    signIn();
    const bridges = makeBridges();
    const full: ProductSnapshotDisplay = {
      ...PANADOL,
      display_name_en: 'Panadol',
      unit_pack_label: '×20',
      selling_barcode: '6223004355218',
      sku: 'SKU-1',
    };
    const bare: ProductSnapshotDisplay = {
      ...PANADOL,
      product_id: 'p-2',
      display_name_ar: 'بنادول نايت',
      price_minor: 2250,
    };
    bridges.fns.search.mockResolvedValue({
      kind: 'results',
      items: [full, bare],
      truncated: false,
    });
    renderSale(bridges);
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox', { name: 'البحث بالاسم أو الباركود' }), 'بنا');
    const listbox = await screen.findByRole('listbox', { name: 'نتائج البحث' });
    expect(bridges.fns.search).toHaveBeenLastCalledWith({ query: 'بنا' });
    const [first, second] = within(listbox).getAllByRole('option');
    expect(first).toHaveTextContent('Panadol');
    expect(first?.querySelectorAll('bdi')).toHaveLength(2);
    expect(second?.querySelectorAll('bdi')).toHaveLength(0);
    expect(second?.querySelector('.v5-sale-product-meta')).toBeNull();
    expect(second).toHaveTextContent('22.50 EGP');
    act(() => {
      listbox.focus();
    });
    await user.keyboard('{ArrowDown}{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'تأكيد إضافة الصنف' });
    expect(dialog).toHaveTextContent('بنادول نايت');
    expect(bridges.fns.add).not.toHaveBeenCalled();
  });

  it('shows a generic add refusal and keeps the cart empty', async () => {
    signIn();
    const bridges = makeBridges();
    bridges.fns.add.mockResolvedValue({ kind: 'refused', reason: 'stale_version' });
    renderSale(bridges);
    const user = userEvent.setup();
    await scanAndOpenConfirm(user);
    await user.click(screen.getByRole('button', { name: 'إضافة إلى السلة' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/تعذّرت الإضافة/);
    expect(screen.queryByText(/stale_version/)).not.toBeInTheDocument();
    expect(screen.getByText(/لا توجد أصناف في السلة/)).toBeInTheDocument();
  });

  it('applies only bridge-confirmed quantity changes with the current line version', async () => {
    signIn();
    const bridges = makeBridges();
    bridges.fns.update
      .mockResolvedValueOnce({ kind: 'ok', version: 2 })
      .mockResolvedValueOnce({ kind: 'refused', reason: 'stale_version' });
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: 'زيادة كمية بنادول' }));
    await waitFor(() => {
      expect(screen.getByLabelText('الكمية 2')).toBeInTheDocument();
    });
    expect(bridges.fns.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ line_id: 'line-1', op: 'increment', version: 1 }),
    );
    expect(screen.getAllByText('30.00 EGP').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'إنقاص كمية بنادول' }));
    await waitFor(() => {
      expect(bridges.fns.update).toHaveBeenCalledTimes(2);
    });
    expect(bridges.fns.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ op: 'decrement', version: 2 }),
    );
    expect(screen.getByLabelText('الكمية 2')).toBeInTheDocument();
    expect(screen.queryByText(/stale_version/)).not.toBeInTheDocument();
  });

  it('removes a note-less line when decremented at quantity one', async () => {
    signIn();
    const bridges = makeBridges();
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: 'إنقاص كمية بنادول' }));
    await waitFor(() => {
      expect(screen.getByText(/لا توجد أصناف في السلة/)).toBeInTheDocument();
    });
    expect(bridges.fns.remove).toHaveBeenCalledWith(
      expect.objectContaining({ line_id: 'line-1', version: 1 }),
    );
    expect(bridges.fns.update).not.toHaveBeenCalled();
  });

  it('keeps a refused handoff editable with generic copy', async () => {
    signIn();
    const bridges = makeBridges();
    bridges.fns.handoff.mockResolvedValue({ kind: 'refused', reason: 'stale_version' });
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: /تسليم السلة/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/stale_version/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /المتابعة إلى الدفع/ })).not.toBeInTheDocument();
    expect(usePaymentStore.getState().envelope).toBeNull();
  });

  it.each([
    ['cashier', false],
    ['manager', true],
  ] as const)('after handoff, %s void visibility is %s', async (role, visible) => {
    signIn(role);
    const bridges = makeBridges();
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: /تسليم السلة/ }));
    await screen.findByRole('button', { name: /المتابعة إلى الدفع/ });
    expect(screen.queryByRole('button', { name: 'إلغاء البيع' }) !== null).toBe(visible);
  });

  it('note dialog focuses its field, and Escape returns focus to the opener', async () => {
    signIn();
    const bridges = makeBridges();
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    const opener = screen.getByRole('button', { name: 'ملاحظة' });
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'ملاحظة الصنف' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'ملاحظة الصنف' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it('void dialog focuses the safe action, and Escape returns focus to the opener', async () => {
    signIn('manager');
    const bridges = makeBridges();
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    const opener = screen.getByRole('button', { name: 'إلغاء البيع' });
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'العودة' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'تأكيد إلغاء البيع' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it('drops local lines on sign-out and does not resurrect them on the next sign-in', async () => {
    signIn();
    const bridges = makeBridges();
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    act(() => {
      useOperatorSessionStore.getState().reset();
    });
    expect(screen.queryByRole('list', { name: 'أصناف السلة' })).not.toBeInTheDocument();
    expect(screen.queryByText('15.00 EGP')).not.toBeInTheDocument();
    act(() => {
      signIn();
    });
    expect(await screen.findByText(/لا توجد أصناف في السلة/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'أصناف السلة' })).not.toBeInTheDocument();
  });

  it('never continues to payment when the payments flag is off', async () => {
    signIn();
    useFeatureFlagsStore.setState({ payments: false });
    const bridges = makeBridges();
    const onPaymentContinue = vi.fn();
    renderSale(bridges, onPaymentContinue);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: /تسليم السلة/ }));
    const proceed = await screen.findByRole('button', { name: /المتابعة إلى الدفع/ });
    expect(proceed).toBeDisabled();
    await user.click(proceed);
    expect(onPaymentContinue).not.toHaveBeenCalled();
    expect(usePaymentStore.getState().envelope).toBeNull();
  });

  it('saves a trimmed note with the current version and renders it', async () => {
    signIn();
    const bridges = makeBridges();
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: 'ملاحظة' }));
    const field = screen.getByRole('textbox', { name: 'ملاحظة الصنف' });
    expect(field).toHaveAttribute('maxLength', '200');
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'مسح الملاحظة' })).toBeDisabled();
    await user.type(field, '  بعد الأكل  ');
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'ملاحظة الصنف' })).not.toBeInTheDocument();
    });
    expect(bridges.fns.setNote).toHaveBeenCalledWith(
      expect.objectContaining({ line_id: 'line-1', version: 1, note: 'بعد الأكل' }),
    );
    expect(screen.getByText('ملاحظة: بعد الأكل')).toBeInTheDocument();
  });

  it('keeps the note dialog open with generic copy when the save is refused', async () => {
    signIn();
    const bridges = makeBridges();
    bridges.fns.setNote.mockResolvedValue({ kind: 'refused', reason: 'stale_version' });
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: 'ملاحظة' }));
    await user.type(screen.getByRole('textbox', { name: 'ملاحظة الصنف' }), 'ملاحظة');
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذّر حفظ الملاحظة.');
    expect(screen.getByRole('dialog', { name: 'ملاحظة الصنف' })).toBeInTheDocument();
    expect(screen.queryByText(/stale_version/)).not.toBeInTheDocument();
  });

  it('clears an existing note by saving null', async () => {
    signIn();
    const bridges = makeBridges();
    bridges.fns.setNote
      .mockResolvedValueOnce({ kind: 'ok', version: 2 })
      .mockResolvedValueOnce({ kind: 'ok', version: 3 });
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: 'ملاحظة' }));
    await user.type(screen.getByRole('textbox', { name: 'ملاحظة الصنف' }), 'مؤقت');
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    await screen.findByText('ملاحظة: مؤقت');
    await user.click(screen.getByRole('button', { name: 'ملاحظة' }));
    await user.click(screen.getByRole('button', { name: 'مسح الملاحظة' }));
    await waitFor(() => {
      expect(screen.queryByText('ملاحظة: مؤقت')).not.toBeInTheDocument();
    });
    expect(bridges.fns.setNote).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: 2, note: null }),
    );
  });

  it('decrements (does not remove) a quantity-one line that carries a note', async () => {
    signIn();
    const bridges = makeBridges();
    bridges.fns.update.mockResolvedValue({ kind: 'ok', version: 3 });
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: 'ملاحظة' }));
    await user.type(screen.getByRole('textbox', { name: 'ملاحظة الصنف' }), 'مهم');
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    await screen.findByText('ملاحظة: مهم');
    await user.click(screen.getByRole('button', { name: 'إنقاص كمية بنادول' }));
    await waitFor(() => {
      expect(bridges.fns.update).toHaveBeenCalledWith(
        expect.objectContaining({ line_id: 'line-1', op: 'decrement', version: 2 }),
      );
    });
    expect(bridges.fns.remove).not.toHaveBeenCalled();
  });

  it('voids through the bridge and shows the cancelled state without line controls', async () => {
    signIn('manager');
    const bridges = makeBridges();
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    expect(await screen.findByText('تم إلغاء البيع.')).toBeInTheDocument();
    expect(bridges.fns.voidCart).toHaveBeenCalledWith(
      expect.objectContaining({ cart_id: 'cart-1' }),
    );
    expect(screen.queryByRole('dialog', { name: 'تأكيد إلغاء البيع' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'زيادة كمية بنادول' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إلغاء البيع' })).not.toBeInTheDocument();
  });

  it('surfaces controlled / Rx awareness on result rows and the confirm dialog only when flagged', async () => {
    signIn();
    const bridges = makeBridges();
    const controlled: ProductSnapshotDisplay = {
      ...PANADOL,
      product_id: 'p-c',
      display_name_ar: 'ترامادول',
      controlled_substance: true,
      prescription_required: true,
    };
    bridges.fns.search.mockResolvedValue({
      kind: 'results',
      items: [controlled, PANADOL],
      truncated: false,
    });
    renderSale(bridges);
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox', { name: 'البحث بالاسم أو الباركود' }), 'بنا');
    const listbox = await screen.findByRole('listbox', { name: 'نتائج البحث' });
    const [flagged, plain] = within(listbox).getAllByRole('option');
    expect(flagged).toHaveTextContent('مادة خاضعة للرقابة');
    expect(flagged).toHaveTextContent('بوصفة طبية');
    expect(plain).not.toHaveTextContent('مادة خاضعة للرقابة');
    expect(plain).not.toHaveTextContent('بوصفة طبية');
    await user.click(screen.getByRole('button', { name: 'اختيار ترامادول' }));
    const dialog = await screen.findByRole('dialog', { name: 'تأكيد إضافة الصنف' });
    expect(dialog).toHaveTextContent('مادة خاضعة للرقابة');
    expect(dialog).toHaveTextContent('بوصفة طبية');
  });

  it('keeps the void dialog open on refusal, matching legacy, and leaks no reason', async () => {
    signIn('manager');
    const bridges = makeBridges();
    bridges.fns.voidCart.mockResolvedValue({ kind: 'refused', reason: 'role_denied' });
    renderSale(bridges);
    const user = userEvent.setup();
    await addOneLine(user);
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    await waitFor(() => {
      expect(bridges.fns.voidCart).toHaveBeenCalledOnce();
    });
    expect(screen.getByRole('dialog', { name: 'تأكيد إلغاء البيع' })).toBeInTheDocument();
    expect(screen.queryByText(/role_denied/)).not.toBeInTheDocument();
    expect(screen.queryByText('تم إلغاء البيع.')).not.toBeInTheDocument();
  });
});

describe('live v5 Sale touch targets', () => {
  it('sizes every live button rule to at least the 44px floor', () => {
    const css = readFileSync(resolve(__dirname, '../sale/live-sale.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector]) =>
      selector?.includes('button'),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      for (const match of (body ?? '').matchAll(/(?:min-)?block-size:\s*(\d+)px/g)) {
        expect(Number(match[1]), selector?.trim()).toBeGreaterThanOrEqual(44);
      }
    }
  });
});
