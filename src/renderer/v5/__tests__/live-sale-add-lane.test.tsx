/**
 * RT-242 (D-C1) — the direct-add lane never outlives its sale and never races
 * the freeze (Codex P1 on #621): a scan still in flight when the sale is voided
 * neither creates the next sale's cart nor shows its line, and handoff waits
 * until every admitted add has settled.
 */
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useLineFlagsStore } from '../../stores/line-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { useScanNoticeStore } from '../../scan/scan-notice-store';
import { BRUFEN, makeBridges, saleWithLines } from './__helpers__/live-sale-harness';

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function voidSale(user: Awaited<ReturnType<typeof saleWithLines>>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
  await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
  await screen.findByText('تم إلغاء البيع.');
}

describe('the direct-add lane ends with its sale', () => {
  it('a scan whose lookup answers after the void creates no cart and adds nothing', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges);
    const lookup = deferred<unknown>();
    bridges.lookupBarcode.mockReset();
    bridges.lookupBarcode.mockReturnValueOnce(lookup.promise);
    await user.type(screen.getByRole('textbox', SCAN_FIELD), '6223004355218{Enter}');
    await voidSale(user);

    await act(async () => {
      lookup.resolve({ kind: 'one', product: BRUFEN });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(bridges.add).toHaveBeenCalledOnce();
    expect((bridges.cart as unknown as { create: Mock }).create).toHaveBeenCalledOnce();
    expect(useCartStore.getState().activeCart).toBeNull();
    expect(screen.queryByRole('list', { name: 'أصناف السلة' })).not.toBeInTheDocument();
    expect(useScanNoticeStore.getState().message).toBeNull();
  });

  it('an add that answers after the void shows no line in the next sale', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges);
    const add = deferred<unknown>();
    bridges.add.mockReset();
    bridges.add.mockReturnValueOnce(add.promise);
    await user.type(screen.getByRole('textbox', SCAN_FIELD), '6223004355218{Enter}');
    await waitFor(() => {
      expect(bridges.add).toHaveBeenCalledOnce();
    });
    await voidSale(user);

    await act(async () => {
      add.resolve({
        kind: 'ok',
        line_id: 'line-late',
        merged: false,
        version: 1,
        display_name: 'بروفين',
        unit_price_minor: 2500,
        line_subtotal_minor: 2500,
        quantity: 1,
      });
      // Let the whole add chain run (several promise hops), not just one tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.queryByRole('list', { name: 'أصناف السلة' })).not.toBeInTheDocument();
    expect(screen.queryByText(/أُضيف: بروفين/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^تراجع/ })).not.toBeInTheDocument();
  });
});

describe('handoff never races an add', () => {
  it('holds «تسليم السلة للدفع» while an admitted add is in flight', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges);
    const { handoff } = bridges.cart as unknown as { handoff: Mock };
    const lookup = deferred<unknown>();
    bridges.lookupBarcode.mockReset();
    bridges.lookupBarcode.mockReturnValueOnce(lookup.promise);
    const commit = screen.getByRole('button', { name: /تسليم السلة/ });
    expect(commit).toBeEnabled();

    await user.type(screen.getByRole('textbox', SCAN_FIELD), '6223004355218{Enter}');

    await waitFor(() => {
      expect(commit).toBeDisabled();
    });
    await user.click(commit);
    expect(handoff).not.toHaveBeenCalled();
    await act(async () => {
      lookup.resolve({ kind: 'one', product: BRUFEN });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(commit).toBeEnabled();
    });
    expect(document.querySelectorAll('.v5-sale-cart-line')).toHaveLength(2);
  });
});
