/**
 * RT-242 (VNext W1-B) — the Direction B Sale: command bar with a results
 * dropdown over the cart, the money column, ↑/↓ row focus, and the newest row
 * brought into view. Behaviour is unchanged (confirm-first add); these tests
 * pin the layout contract of freeze package 15 §3.2–§3.3 and DESIGN.md
 * "Frame — Direction B".
 */
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { useCartStore } from '../../stores/cart-store';
import { useCatalogueSearchStore } from '../../stores/catalogueSearchStore';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config';
import {
  BRUFEN,
  PANADOL,
  makeBridges,
  renderSale,
  saleWithLines,
  signIn,
  type Bridges,
} from './__helpers__/live-sale-harness';
import userEvent from '@testing-library/user-event';

const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  useCartStore.getState().reset();
  useCatalogueSearchStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  usePaymentStore.getState().reset();
});

const anchor = (): HTMLElement => screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' });
const searchBox = (): HTMLElement =>
  screen.getByRole('searchbox', { name: 'البحث بالاسم أو الباركود' });
const row = (lineId: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-line-id="${lineId}"]`);
  if (el === null) throw new Error(`no row ${lineId}`);
  return el;
};

function withResults(bridges: Bridges): Bridges {
  (bridges.catalogue.search as Mock).mockResolvedValue({
    kind: 'results',
    items: [PANADOL, BRUFEN],
    truncated: false,
  });
  return bridges;
}

describe('command bar and results dropdown', () => {
  it('shows no results panel until a search runs', () => {
    signIn();
    renderSale(makeBridges());
    expect(screen.queryByRole('listbox', { name: 'نتائج البحث' })).not.toBeInTheDocument();
    expect(screen.queryByText('ابحث عن صنف لعرض المنتجات المتاحة.')).not.toBeInTheDocument();
  });

  it('Esc closes the results, clears the query and returns focus to the scan owner', async () => {
    signIn();
    renderSale(withResults(makeBridges()));
    const user = userEvent.setup();
    await user.type(searchBox(), 'بنا');
    await screen.findByRole('listbox', { name: 'نتائج البحث' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'نتائج البحث' })).not.toBeInTheDocument();
    expect(searchBox()).toHaveValue('');
    expect(anchor()).toHaveFocus();
  });

  // Codex review on #610: a keystroke inside the 150 ms debounce window must not
  // reopen the results after Esc closed them.
  it('Esc cancels a pending typed search, so the results stay closed', async () => {
    signIn();
    const bridges = withResults(makeBridges());
    renderSale(bridges);
    const user = userEvent.setup();
    await user.type(searchBox(), 'بنا');
    await screen.findByRole('listbox', { name: 'نتائج البحث' });
    const searches = (bridges.catalogue.search as Mock).mock.calls.length;
    await user.type(searchBox(), 'د{Escape}');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((bridges.catalogue.search as Mock).mock.calls).toHaveLength(searches);
    expect(screen.queryByRole('listbox', { name: 'نتائج البحث' })).not.toBeInTheDocument();
    expect(anchor()).toHaveFocus();
  });

  it('Esc from inside the results list closes them too', async () => {
    signIn();
    renderSale(withResults(makeBridges()));
    const user = userEvent.setup();
    await user.type(searchBox(), 'بنا');
    const listbox = await screen.findByRole('listbox', { name: 'نتائج البحث' });
    act(() => {
      listbox.focus();
    });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'نتائج البحث' })).not.toBeInTheDocument();
    expect(anchor()).toHaveFocus();
  });

  it('a pick closes the results; once the add resolves the typed query is cleared', async () => {
    signIn();
    renderSale(withResults(makeBridges()));
    const user = userEvent.setup();
    await user.type(searchBox(), 'بنا');
    const listbox = await screen.findByRole('listbox', { name: 'نتائج البحث' });
    await user.click(within(listbox).getAllByRole('option')[0] as HTMLElement);
    expect(screen.queryByRole('listbox', { name: 'نتائج البحث' })).not.toBeInTheDocument();
    await screen.findByRole('list', { name: 'أصناف السلة' });
    expect(searchBox()).toHaveValue('');
  });

  it('keeps the scan status and catalogue freshness on the command bar', () => {
    signIn();
    renderSale(makeBridges());
    const bar = screen.getByRole('region', { name: 'الأصناف والمنتجات' });
    expect(within(bar).getByTestId('scan-status')).toHaveTextContent('جاهز للمسح');
    expect(within(bar).getByRole('button', { name: 'تحديث الكتالوج' })).toBeInTheDocument();
  });

  it('is axe-clean with the results dropdown open', async () => {
    signIn();
    renderSale(withResults(makeBridges()));
    const user = userEvent.setup();
    await user.type(searchBox(), 'بنا');
    await screen.findByRole('listbox', { name: 'نتائج البحث' });
    await expectNoAxeViolations(document.body);
  });
});

describe('the last add is acknowledged and brought into view', () => {
  it('announces the added product politely', async () => {
    await saleWithLines(makeBridges(), 1);
    const ack = screen.getByText((_, el) => el?.classList.contains('v5-sale-last-add') ?? false);
    expect(ack).toHaveTextContent('أُضيف: بنادول');
    expect(ack).toHaveAttribute('role', 'status');
  });

  it('marks, scrolls to and briefly flashes the row the add landed on', async () => {
    await saleWithLines(makeBridges(), 2);
    expect(row('line-2')).toHaveAttribute('data-last-added', 'true');
    expect(row('line-1')).not.toHaveAttribute('data-last-added');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    await waitFor(() => {
      expect(row('line-2')).not.toHaveAttribute('data-flash');
    });
  });

  it('clears the acknowledgement when the sale is voided', async () => {
    const user = await saleWithLines(makeBridges(), 1);
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    await screen.findByText('تم إلغاء البيع.');
    expect(screen.queryByText(/أُضيف:/)).not.toBeInTheDocument();
  });
});

describe('↑ / ↓ move between cart rows (15 §3.3)', () => {
  it('enters the rows from the cart region and walks them', async () => {
    const user = await saleWithLines(makeBridges(), 2);
    const region = screen.getByRole('region', { name: 'بنود السلة' });
    act(() => {
      region.focus();
    });
    await user.keyboard('{ArrowDown}');
    expect(row('line-1')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(row('line-2')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(row('line-2')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(row('line-1')).toHaveFocus();
  });

  it('keeps the column: from a + it lands on the next row’s +', async () => {
    const user = await saleWithLines(makeBridges(), 2);
    const plus = row('line-1').querySelector<HTMLElement>('[data-row-action="increment"]');
    act(() => {
      plus?.focus();
    });
    await user.keyboard('{ArrowDown}');
    expect(row('line-2').querySelector('[data-row-action="increment"]')).toHaveFocus();
  });

  it('rows are focusable by arrow keys only, not extra Tab stops', async () => {
    await saleWithLines(makeBridges(), 1);
    expect(row('line-1')).toHaveAttribute('tabindex', '-1');
  });
});

describe('the money column (Direction B)', () => {
  it('holds the totals and the commit, with the void in its own region', async () => {
    await saleWithLines(makeBridges(), 1);
    const money = screen.getByRole('region', { name: 'ملخص العملية' });
    expect(within(money).getByLabelText('ملخص المبالغ')).toBeInTheDocument();
    expect(within(money).getByRole('button', { name: /تسليم السلة للدفع/ })).toBeEnabled();
    expect(within(money).getByRole('button', { name: 'إلغاء البيع' })).toBeInTheDocument();
  });

  it('is axe-clean with lines in the cart', async () => {
    await saleWithLines(makeBridges(), 2);
    await expectNoAxeViolations(document.body);
  });
});
