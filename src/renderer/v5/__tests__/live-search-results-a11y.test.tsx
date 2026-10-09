// RT-242 scope item 4 — the search results listbox carried an axe
// `nested-interactive` (serious) violation since PR #460: each `role="option"`
// held a focusable «اختيار» button. The option itself is now the activation
// target; listbox + aria-activedescendant are retained.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config';
import { LiveSearchResults } from '../sale/LiveSearchResults';

afterEach(cleanup);

const PANADOL: ProductSnapshotDisplay = {
  product_id: 'p-1',
  display_name_ar: 'بنادول',
  display_name_en: 'Panadol',
  price_minor: 1500,
  selling_barcode: '6223004355218',
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

const NIGHT: ProductSnapshotDisplay = {
  product_id: 'p-2',
  display_name_ar: 'بنادول نايت',
  price_minor: 2250,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

function renderResults(
  items: readonly ProductSnapshotDisplay[],
  options: { truncated?: boolean } = {},
): { onSelect: ReturnType<typeof vi.fn>; container: HTMLElement } {
  const onSelect = vi.fn();
  const { container } = render(
    <LiveSearchResults
      state={{ kind: 'results', items, truncated: options.truncated ?? false }}
      onSelect={onSelect}
      onRecover={vi.fn()}
    />,
  );
  return { onSelect, container };
}

describe('search results listbox (RT-242 item 4)', () => {
  it('reports no axe violations with one result showing', async () => {
    const { container } = renderResults([PANADOL]);
    await expectNoAxeViolations(container);
  });

  it('reports no axe violations when the results are truncated', async () => {
    const { container } = renderResults([PANADOL, NIGHT], { truncated: true });
    await expectNoAxeViolations(container);
    expect(screen.getByText('النتائج محدودة؛ عدّل البحث لتضييقها.')).toBeInTheDocument();
  });

  it('has no focusable control inside an option', () => {
    renderResults([PANADOL, NIGHT]);
    for (const option of screen.getAllByRole('option')) {
      expect(within(option).queryByRole('button')).toBeNull();
      expect(option.querySelector('button, a[href], input, [tabindex]')).toBeNull();
    }
  });

  it('keeps the listbox + aria-activedescendant model', () => {
    renderResults([PANADOL, NIGHT]);
    const listbox = screen.getByRole('listbox', { name: 'نتائج البحث' });
    const [first] = screen.getAllByRole('option');
    expect(listbox).toHaveAttribute('aria-activedescendant', first?.id);
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('picks the option on click', async () => {
    const { onSelect } = renderResults([PANADOL, NIGHT]);
    const user = userEvent.setup();
    const [, second] = screen.getAllByRole('option');
    await user.click(second as HTMLElement);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(NIGHT);
  });

  it('moves the active option with ArrowUp/ArrowDown and picks it with Enter', async () => {
    const { onSelect } = renderResults([PANADOL, NIGHT]);
    const user = userEvent.setup();
    const listbox = screen.getByRole('listbox', { name: 'نتائج البحث' });
    act(() => {
      listbox.focus();
    });
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const [first, second] = screen.getAllByRole('option');
    expect(listbox).toHaveAttribute('aria-activedescendant', second?.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(listbox).toHaveAttribute('aria-activedescendant', first?.id);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(NIGHT);
  });

  it('names each option by its product so a pointer pick is announced', () => {
    renderResults([PANADOL]);
    expect(screen.getByRole('option', { name: /بنادول/ })).toBeInTheDocument();
  });
});
