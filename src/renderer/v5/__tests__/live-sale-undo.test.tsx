/**
 * RT-242 (D-C1 + RT-245) — Undo of the last direct add or delete on the real
 * Sale screen. The renderer names only the action it just completed; main
 * chooses and applies the inverse; the cart is then re-read from main.
 */
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useLineFlagsStore } from '../../stores/line-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { useScanNoticeStore } from '../../scan/scan-notice-store';
import { resetSaleStores } from '../../sale/reset-sale-stores';
import { makeBridges, saleWithLines, type Bridges } from './__helpers__/live-sale-harness';

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useLineFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
  useScanNoticeStore.setState({ message: null, seq: 0 });
});

const SCAN_FIELD = { name: 'حقل التقاط مسح الباركود' };

function snapshotWith(lines: ReadonlyArray<{ id: string; name: string }>) {
  return {
    kind: 'ok',
    snapshot: {
      cart_id: 'cart-1',
      state: 'editing',
      lines: lines.map((line) => ({
        line_id: line.id,
        display_name: line.name,
        quantity: 1,
        unit_price_minor: 1500,
        line_subtotal_minor: 1500,
        note: null,
        version: 3,
      })),
      discount_placeholders: [],
      paid: false,
      envelope: null,
    },
  };
}

function cartLines(): HTMLElement {
  return screen.getByRole('list', { name: 'أصناف السلة' });
}

function addKey(bridges: Bridges, call = 0): string {
  return (bridges.add.mock.calls[call]?.[0] as { idempotency_key: string }).idempotency_key;
}

describe('Undo of the last direct add', () => {
  it('names the add it just made, lets main undo it, then re-reads the cart', async () => {
    const bridges = makeBridges();
    bridges.undoLast.mockResolvedValue({
      kind: 'ok',
      effect: 'removed',
      line_id: 'line-1',
      version: 2,
    });
    bridges.snapshot.mockResolvedValue(snapshotWith([]));
    const user = await saleWithLines(bridges);
    expect(screen.getByText(/أُضيف:/)).toHaveTextContent('أُضيف: بنادول');

    await user.click(screen.getByRole('button', { name: 'تراجع عن إضافة بنادول' }));

    expect(bridges.undoLast).toHaveBeenCalledOnce();
    const req = bridges.undoLast.mock.calls[0]?.[0] as Record<string, string>;
    expect(req).toMatchObject({ cart_id: 'cart-1', target_action_id: addKey(bridges) });
    expect(req.idempotency_key).not.toBe(addKey(bridges));
    await waitFor(() => {
      expect(screen.queryByRole('list', { name: 'أصناف السلة' })).not.toBeInTheDocument();
    });
    expect(bridges.snapshot).toHaveBeenCalledWith({ cart_id: 'cart-1' });
    expect(screen.getByText('تم التراجع.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^تراجع/ })).not.toBeInTheDocument();
    // 15 §3.1 rule 6: after an Undo the next scan is the next thing the cashier does.
    expect(document.activeElement).toBe(screen.getByRole('textbox', SCAN_FIELD));
    // The renderer never composes an inverse itself.
    expect(bridges.remove).not.toHaveBeenCalled();
    expect(bridges.update).not.toHaveBeenCalled();
  });

  it('a refused Undo says it is no longer available and re-reads the cart', async () => {
    const bridges = makeBridges();
    bridges.undoLast.mockResolvedValue({ kind: 'refused', reason: 'undo_not_available' });
    bridges.snapshot.mockResolvedValue(snapshotWith([{ id: 'line-1', name: 'بنادول' }]));
    const user = await saleWithLines(bridges);

    await user.click(screen.getByRole('button', { name: 'تراجع عن إضافة بنادول' }));

    expect(await screen.findByText('لم يعد التراجع متاحًا.')).toBeInTheDocument();
    expect(bridges.snapshot).toHaveBeenCalledOnce();
    expect(screen.queryByText(/undo_not_available/)).not.toBeInTheDocument();
    expect(within(cartLines()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('a lost Undo response keeps the offer, and pressing again replays the same Undo key', async () => {
    const bridges = makeBridges();
    bridges.undoLast
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValueOnce({ kind: 'ok', effect: 'removed', line_id: 'line-1', version: 2 });
    bridges.snapshot.mockResolvedValue(snapshotWith([]));
    const user = await saleWithLines(bridges);

    await user.click(screen.getByRole('button', { name: 'تراجع عن إضافة بنادول' }));
    await user.click(await screen.findByRole('button', { name: 'تراجع عن إضافة بنادول' }));

    await waitFor(() => {
      expect(bridges.undoLast).toHaveBeenCalledTimes(2);
    });
    const [first, second] = bridges.undoLast.mock.calls.map(
      ([r]) => (r as { idempotency_key: string }).idempotency_key,
    );
    expect(second).toBe(first);
  });

  it('a lost Undo response with no retry still re-reads the cart, so it is never stale', async () => {
    const bridges = makeBridges();
    bridges.undoLast.mockRejectedValue(new Error('ipc'));
    bridges.snapshot.mockResolvedValue(snapshotWith([]));
    const user = await saleWithLines(bridges);

    await user.click(screen.getByRole('button', { name: 'تراجع عن إضافة بنادول' }));

    await waitFor(() => {
      expect(screen.queryByRole('list', { name: 'أصناف السلة' })).not.toBeInTheDocument();
    });
    expect(bridges.snapshot).toHaveBeenCalledWith({ cart_id: 'cart-1' });
    // The offer stays for a retry with the same key.
    expect(screen.getByRole('button', { name: 'تراجع عن إضافة بنادول' })).toBeInTheDocument();
  });

  it('a cart re-read that fails after the Undo falls back to reading the cart again, never to a stale list', async () => {
    const bridges = makeBridges();
    bridges.undoLast.mockResolvedValue({
      kind: 'ok',
      effect: 'removed',
      line_id: 'line-1',
      version: 2,
    });
    bridges.snapshot.mockRejectedValue(new Error('ipc'));
    const user = await saleWithLines(bridges);

    await user.click(screen.getByRole('button', { name: 'تراجع عن إضافة بنادول' }));

    expect(await screen.findByText('تعذّر تحميل السلة الحالية.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'أصناف السلة' })).not.toBeInTheDocument();
  });

  it('a cart read that answers after the sale ended never paints the old cart', async () => {
    const bridges = makeBridges();
    bridges.undoLast.mockResolvedValue({
      kind: 'ok',
      effect: 'removed',
      line_id: 'line-1',
      version: 2,
    });
    let answerSnapshot: (value: unknown) => void = () => undefined;
    bridges.snapshot.mockReturnValueOnce(new Promise((resolve) => (answerSnapshot = resolve)));
    const user = await saleWithLines(bridges, 2);
    await user.click(screen.getByRole('button', { name: 'تراجع عن إضافة بروفين' }));
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    await screen.findByText('تم إلغاء البيع.');

    await act(async () => {
      answerSnapshot(snapshotWith([{ id: 'line-1', name: 'بنادول' }]));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByRole('list', { name: 'أصناف السلة' })).not.toBeInTheDocument();
    expect(screen.queryByText('تعذّر تحميل السلة الحالية.')).not.toBeInTheDocument();
  });

  it('any other cart change withdraws the offer (main would refuse it anyway)', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges);
    expect(screen.getByRole('button', { name: 'تراجع عن إضافة بنادول' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'زيادة كمية بنادول' }));

    expect(screen.queryByRole('button', { name: /^تراجع/ })).not.toBeInTheDocument();
    expect(bridges.undoLast).not.toHaveBeenCalled();
  });

  it('offers nothing when the bridge cannot undo (fail closed)', async () => {
    const bridges = makeBridges();
    delete (bridges.cart as { undoLast?: unknown }).undoLast;
    await saleWithLines(bridges);
    expect(screen.getByText(/أُضيف:/)).toHaveTextContent('أُضيف: بنادول');
    expect(screen.queryByRole('button', { name: /^تراجع/ })).not.toBeInTheDocument();
  });

  it('the next scan replaces the offer with one for the new add', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges);
    await user.type(screen.getByRole('textbox', SCAN_FIELD), '6223004355218{Enter}');
    await screen.findByRole('button', { name: 'تراجع عن إضافة بروفين' });
    expect(screen.queryByRole('button', { name: 'تراجع عن إضافة بنادول' })).not.toBeInTheDocument();
  });
});

describe('Undo of a delete', () => {
  it('names the delete it just made, and main restores the same line', async () => {
    const bridges = makeBridges();
    bridges.undoLast.mockResolvedValue({
      kind: 'ok',
      effect: 'restored',
      line_id: 'line-1',
      version: 3,
    });
    bridges.snapshot.mockResolvedValue(snapshotWith([{ id: 'line-1', name: 'بنادول' }]));
    const user = await saleWithLines(bridges);

    await user.click(screen.getByRole('button', { name: /^حذف$/ }));
    await waitFor(() => {
      expect(bridges.remove).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText(/حُذف/)).toHaveTextContent('حُذف بنادول.');
    await user.click(screen.getByRole('button', { name: 'تراجع عن حذف بنادول' }));

    const removeKey = (bridges.remove.mock.calls[0]?.[0] as { idempotency_key: string })
      .idempotency_key;
    expect(bridges.undoLast.mock.calls[0]?.[0]).toMatchObject({ target_action_id: removeKey });
    await waitFor(() => {
      expect(within(cartLines()).getByText('بنادول')).toBeInTheDocument();
    });
    // The restored line carries main's version for the next mutation.
    await user.click(screen.getByRole('button', { name: 'زيادة كمية بنادول' }));
    expect(bridges.update).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
  });

  it('a delete still in flight offers no Undo once a later change has started', async () => {
    const bridges = makeBridges();
    let confirmRemove: (value: unknown) => void = () => undefined;
    bridges.remove.mockReturnValueOnce(new Promise((resolve) => (confirmRemove = resolve)));
    const user = await saleWithLines(bridges, 2);

    await user.click(screen.getAllByRole('button', { name: /^حذف$/ })[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'زيادة كمية بروفين' }));
    await act(async () => {
      confirmRemove({ kind: 'ok' });
      await Promise.resolve();
    });

    expect(await screen.findByText(/حُذف/)).toHaveTextContent('حُذف بنادول.');
    expect(screen.queryByRole('button', { name: /^تراجع/ })).not.toBeInTheDocument();
  });

  it('a decrement that removes a noted one-unit line offers its Undo (main records it as a remove)', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges);
    await user.click(screen.getByRole('button', { name: 'ملاحظة' }));
    await user.type(screen.getByRole('textbox', { name: 'ملاحظة الصنف' }), 'بعد الأكل');
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    await screen.findByText(/ملاحظة: بعد الأكل/);

    await user.click(screen.getByRole('button', { name: 'إنقاص كمية بنادول' }));

    const offer = await screen.findByRole('button', { name: 'تراجع عن حذف بنادول' });
    expect(offer).toBeInTheDocument();
    const updateKey = (bridges.update.mock.calls[0]?.[0] as { idempotency_key: string })
      .idempotency_key;
    bridges.undoLast.mockResolvedValue({ kind: 'refused', reason: 'undo_not_available' });
    bridges.snapshot.mockResolvedValue(snapshotWith([]));
    await user.click(offer);
    expect(bridges.undoLast.mock.calls[0]?.[0]).toMatchObject({ target_action_id: updateKey });
  });

  it('a second Delete before the first answers is not sent', async () => {
    const bridges = makeBridges();
    let confirmRemove: (value: unknown) => void = () => undefined;
    bridges.remove.mockReturnValueOnce(new Promise((resolve) => (confirmRemove = resolve)));
    const user = await saleWithLines(bridges);
    await user.click(screen.getByRole('button', { name: /^حذف$/ }));
    await user.click(screen.getByRole('button', { name: /^حذف$/ }));
    await act(async () => {
      confirmRemove({ kind: 'ok' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(bridges.remove).toHaveBeenCalledOnce();
    const removeKey = (bridges.remove.mock.calls[0]?.[0] as { idempotency_key: string })
      .idempotency_key;
    bridges.undoLast.mockResolvedValue({ kind: 'refused', reason: 'undo_not_available' });
    bridges.snapshot.mockResolvedValue(snapshotWith([]));
    await user.click(await screen.findByRole('button', { name: 'تراجع عن حذف بنادول' }));
    expect(bridges.undoLast.mock.calls[0]?.[0]).toMatchObject({ target_action_id: removeKey });
  });

  it('a refused delete offers no Undo', async () => {
    const bridges = makeBridges();
    bridges.remove.mockResolvedValue({ kind: 'refused', reason: 'stale_version' });
    const user = await saleWithLines(bridges);
    await user.click(screen.getByRole('button', { name: /^حذف$/ }));
    await waitFor(() => {
      expect(bridges.remove).toHaveBeenCalledOnce();
    });
    expect(screen.queryByRole('button', { name: /تراجع عن حذف/ })).not.toBeInTheDocument();
  });
});

describe('M-S9 line flag', () => {
  it('keeps the add-time Rx badge on the line after the cart is re-read', async () => {
    const bridges = makeBridges();
    bridges.lookupBarcode.mockReset();
    bridges.lookupBarcode.mockResolvedValue({
      kind: 'one',
      product: {
        product_id: 'p-rx',
        display_name_ar: 'بنادول',
        price_minor: 1500,
        active: true,
        controlled_substance: false,
        prescription_required: true,
      },
    });
    bridges.undoLast.mockResolvedValue({ kind: 'refused', reason: 'undo_not_available' });
    bridges.snapshot.mockResolvedValue(snapshotWith([{ id: 'line-1', name: 'بنادول' }]));
    const user = await saleWithLines(bridges);
    expect(within(cartLines()).getByText('بوصفة طبية')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'تراجع عن إضافة بنادول' }));
    await screen.findByText('لم يعد التراجع متاحًا.');
    expect(within(cartLines()).getByText('بوصفة طبية')).toBeInTheDocument();
  });

  it('New sale forgets the flags of the finished sale', () => {
    act(() => {
      useLineFlagsStore
        .getState()
        .remember('line-1', { controlled_substance: false, prescription_required: true });
    });
    resetSaleStores();
    expect(useLineFlagsStore.getState().byLine).toEqual({});
  });
});
