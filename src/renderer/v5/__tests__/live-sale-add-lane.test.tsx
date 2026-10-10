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

describe('void and the direct-add lane', () => {
  it('a void waits for an admitted add, then ends the sale with nothing leaking into the next', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges);
    const lookup = deferred<unknown>();
    bridges.lookupBarcode.mockReset();
    bridges.lookupBarcode.mockReturnValueOnce(lookup.promise);
    await user.type(screen.getByRole('textbox', SCAN_FIELD), '6223004355218{Enter}');
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    // The void is held until the scan it follows has settled.
    expect(bridges.voidCart).not.toHaveBeenCalled();

    await act(async () => {
      lookup.resolve({ kind: 'one', product: BRUFEN });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await screen.findByText('تم إلغاء البيع.');
    expect(bridges.add).toHaveBeenCalledTimes(2);
    expect(bridges.voidCart).toHaveBeenCalledOnce();
    expect((bridges.cart as unknown as { create: Mock }).create).toHaveBeenCalledOnce();
    expect(useCartStore.getState().activeCart).toBeNull();
    expect(screen.queryByRole('list', { name: 'أصناف السلة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^تراجع/ })).not.toBeInTheDocument();
  });

  it('a refused void keeps the line its in-flight add committed (Codex P2 on #621)', async () => {
    const bridges = makeBridges();
    bridges.voidCart.mockResolvedValue({ kind: 'refused', reason: 'role_denied' });
    const user = await saleWithLines(bridges);
    const add = deferred<unknown>();
    bridges.add.mockReset();
    bridges.add.mockReturnValueOnce(add.promise);
    await user.type(screen.getByRole('textbox', SCAN_FIELD), '6223004355218{Enter}');
    await waitFor(() => {
      expect(bridges.add).toHaveBeenCalledOnce();
    });
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    await act(async () => {
      add.resolve({
        kind: 'ok',
        line_id: 'line-2',
        merged: false,
        version: 1,
        display_name: 'بروفين',
        unit_price_minor: 2500,
        line_subtotal_minor: 2500,
        quantity: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await waitFor(() => {
      expect(bridges.voidCart).toHaveBeenCalledOnce();
    });
    expect(document.querySelectorAll('.v5-sale-cart-line')).toHaveLength(2);
    expect(screen.getByText(/أُضيف:/)).toHaveTextContent('أُضيف: بروفين');
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
