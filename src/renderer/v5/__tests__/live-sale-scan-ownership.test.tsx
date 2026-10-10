/**
 * RT-239 (VNext A2) — the real Sale screen owns scans.
 *
 * Mounts `LiveSaleWorkspace` with the scan guard, adds a line the ordinary way,
 * then sends wedge bursts with focus on the line's own controls (RT-159 F-01):
 * the burst must reach the catalogue lookup and must never press `+` or `حذف`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { ScanGuardHost, resetScanGuardForTests } from '../../scan/ScanGuardHost';
import { SCAN_DIALOG_OPEN_MESSAGE } from '../../scan/scan-messages';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { makeBridges, saleWithLines } from './__helpers__/live-sale-harness';

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
      await saleWithLines(bridges);
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
      // D-C1: the scan adds directly; no dialog stands between scan and cart.
      await waitFor(() => {
        expect(bridges.add).toHaveBeenCalledTimes(2);
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // 15 §3.1 rule 6: after the add, focus is back on the scan owner, not the row control.
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' }),
        );
      });
    },
  );

  it('a burst with «تراجع» focused is a scan: it adds, and never undoes the last add', async () => {
    const bridges = makeBridges();
    await saleWithLines(bridges);
    armScanGuard();
    const undo = screen.getByRole('button', { name: 'تراجع عن إضافة بنادول' });
    act(() => {
      undo.focus();
    });
    burst(undo, '6223004355218');
    await waitFor(() => {
      expect(bridges.lookupBarcode).toHaveBeenCalledWith({ barcode: '6223004355218' });
    });
    expect(bridges.undoLast).not.toHaveBeenCalled();
  });

  it('a burst while a dialog is open is refused, not lost silently (M-S6)', async () => {
    const bridges = makeBridges();
    await saleWithLines(bridges);
    armScanGuard();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    const dialog = await screen.findByRole('dialog', { name: 'تأكيد إلغاء البيع' });
    burst(dialog, '6223004355219');
    expect(await screen.findByText(SCAN_DIALOG_OPEN_MESSAGE)).toBeInTheDocument();
    expect(bridges.lookupBarcode).not.toHaveBeenCalled();
    expect(bridges.voidCart).not.toHaveBeenCalled();
  });

  it('a burst typed into the search field is a scan and clears the field', async () => {
    const bridges = makeBridges();
    await saleWithLines(bridges);
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
