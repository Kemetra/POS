/**
 * RT-239 (VNext A2, rules 6-7) — where focus goes on the Sale, and the visible
 * scan status. Freeze package 15 §3.1 rule 6 and §3.4: the scan owner has focus
 * on arrival and after an add; keyboard row edits keep row context and a
 * keyboard removal moves to the neighbouring row; a pointer click on a row
 * control returns to the scan owner; a dialog close returns to its invoker.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config';
import { makeBridges, renderSale, saleWithLines, signIn } from './__helpers__/live-sale-harness';

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
});

const anchor = (): HTMLElement => screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' });
function removeButton(lineId: string): HTMLElement {
  const button = document.querySelector<HTMLElement>(
    `[data-line-id="${lineId}"] [data-row-action="remove"]`,
  );
  if (button === null) throw new Error(`no remove control for ${lineId}`);
  return button;
}

describe('focus goes to the scan owner (rule 6)', () => {
  it('on arrival at the Sale', async () => {
    signIn();
    renderSale(makeBridges());
    await waitFor(() => {
      expect(anchor()).toHaveFocus();
    });
  });

  it('after an add is resolved', async () => {
    const bridges = makeBridges();
    await saleWithLines(bridges, 1);
    await waitFor(() => {
      expect(anchor()).toHaveFocus();
    });
  });

  it('after the sale is voided (the control that opened the dialog is gone)', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges, 1);
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    await waitFor(() => {
      expect(bridges.voidCart).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(anchor()).toHaveFocus();
    });
  });
});

describe('row controls keep or return focus', () => {
  it('a pointer click on + returns focus to the scan owner', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges, 1);
    await user.click(screen.getByRole('button', { name: /زيادة كمية/ }));
    expect(anchor()).toHaveFocus();
    await waitFor(() => {
      expect(bridges.update).toHaveBeenCalled();
    });
  });

  it('a keyboard + keeps focus on the same button', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges, 1);
    const plus = screen.getByRole('button', { name: /زيادة كمية/ });
    plus.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(bridges.update).toHaveBeenCalled();
    });
    expect(screen.getByRole('button', { name: /زيادة كمية/ })).toHaveFocus();
  });

  it('a keyboard removal moves focus to the neighbouring row', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges, 2);
    const first = removeButton('line-1');
    first.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(bridges.remove).toHaveBeenCalledTimes(1);
    });
    // The cart bridge confirms the removal; the surviving row's own حذف takes focus.
    await waitFor(() => {
      expect(removeButton('line-2')).toHaveFocus();
    });
  });

  it('a keyboard removal of the last row hands focus to the scan owner', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges, 1);
    removeButton('line-1').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(bridges.remove).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(anchor()).toHaveFocus();
    });
  });

  it('a pointer click on حذف returns focus to the scan owner', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges, 2);
    await user.click(removeButton('line-1'));
    expect(anchor()).toHaveFocus();
  });

  it('closing the note dialog returns focus to the control that opened it', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges, 1);
    const note = screen.getByRole('button', { name: 'ملاحظة' });
    note.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'ملاحظة الصنف' });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'ملاحظة' })).toHaveFocus();
  });
});

describe('ScanStatus (rule 7)', () => {
  it('says ready on the Sale', async () => {
    signIn();
    renderSale(makeBridges());
    expect(await screen.findByTestId('scan-status')).toHaveTextContent('جاهز للمسح');
    expect(screen.getByTestId('scan-status')).toHaveAttribute('data-state', 'ready');
  });

  it('says scanning is paused while a dialog is open, and ready again after', async () => {
    const bridges = makeBridges();
    const user = await saleWithLines(bridges, 1);
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    // A loaded CI runner can take longer than waitFor's 1 s default to flip the
    // status (seen red on shared runners), so give both transitions a wide bound.
    await waitFor(
      () => {
        expect(screen.getByTestId('scan-status')).toHaveTextContent('المسح متوقف — نافذة مفتوحة');
      },
      { timeout: 5000 },
    );
    await user.click(screen.getByRole('button', { name: 'العودة' }));
    await waitFor(
      () => {
        expect(screen.getByTestId('scan-status')).toHaveTextContent('جاهز للمسح');
      },
      { timeout: 5000 },
    );
  }, 20_000);

  it('says unavailable when the catalogue is off, with text and an icon', () => {
    signIn({ productSearch: false });
    renderSale(makeBridges());
    const status = screen.getByTestId('scan-status');
    expect(status).toHaveTextContent('المسح غير متاح');
    expect(status).toHaveAttribute('data-state', 'unavailable');
    expect(status.querySelector('svg')).not.toBeNull();
  });

  it.each([true, false])('no axe violations (catalogue %s)', async (catalogue) => {
    signIn({ productSearch: catalogue });
    renderSale(makeBridges());
    const status = await screen.findByTestId('scan-status');
    await expectNoAxeViolations(status.parentElement as HTMLElement);
  });
});
