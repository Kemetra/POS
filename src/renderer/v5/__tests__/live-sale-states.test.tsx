import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { CatalogueSearchState } from '../../stores/catalogueSearchStore';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import type { CartLineItem } from '../../sale/useSaleCartController';
import { LiveProductRail } from '../sale/LiveProductRail';
import { LiveSaleCart } from '../sale/LiveSaleCart';

afterEach(() => {
  cleanup();
});

const ITEM: ProductSnapshotDisplay = {
  product_id: 'p-1',
  display_name_ar: 'بنادول',
  price_minor: 1500,
  active: true,
  controlled_substance: false,
  prescription_required: false,
};

function rail(
  state: CatalogueSearchState,
  over: Partial<Parameters<typeof LiveProductRail>[0]> = {},
): Parameters<typeof LiveProductRail>[0] {
  return {
    state,
    freshness: 'never-synced',
    lastSuccessAt: null,
    feedback: 'idle',
    refreshing: false,
    onRefresh: vi.fn(),
    onSearch: vi.fn(),
    onScan: vi.fn(),
    onSelect: vi.fn(),
    onRecover: vi.fn(),
    searchRef: { current: null },
    ...over,
  };
}

describe('LiveProductRail states', () => {
  const TERMINAL_STATES: readonly (readonly [CatalogueSearchState, string])[] = [
    [{ kind: 'not_found', query: 'بن' }, 'لم يُعثر على الصنف.'],
    [{ kind: 'ambiguous' }, 'تطابق أكثر من صنف مع الباركود.'],
    [{ kind: 'catalogue_unavailable' }, 'الكتالوج غير متاح حاليًا.'],
  ];
  it.each(TERMINAL_STATES)('renders honest copy for %o', (state, copy) => {
    const props = rail(state);
    render(<LiveProductRail {...props} />);
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it('offers recovery from not-found and ambiguous states', async () => {
    const props = rail({ kind: 'not_found', query: 'بن' });
    render(<LiveProductRail {...props} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'تعديل البحث' }));
    expect(props.onRecover).toHaveBeenCalledOnce();
  });

  it('shows the truncation hint and moves the active option with ArrowUp/ArrowDown', async () => {
    const second = { ...ITEM, product_id: 'p-2', display_name_ar: 'بروفين' };
    const props = rail({
      kind: 'results',
      items: [ITEM, second],
      truncated: true,
    });
    render(<LiveProductRail {...props} />);
    expect(screen.getByText('النتائج محدودة؛ عدّل البحث لتضييقها.')).toBeInTheDocument();
    const listbox = screen.getByRole('listbox', { name: 'نتائج البحث' });
    act(() => {
      listbox.focus();
    });
    const user = userEvent.setup();
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    expect(props.onSelect).toHaveBeenCalledWith(ITEM);
  });

  it('submits a typed query immediately on Enter and recovers when the field is cleared', async () => {
    const props = rail({ kind: 'idle' });
    render(<LiveProductRail {...props} />);
    const user = userEvent.setup();
    const search = screen.getByRole('searchbox', { name: 'البحث بالاسم أو الباركود' });
    await user.type(search, 'بنادول{Enter}');
    expect(props.onSearch).toHaveBeenCalledWith('بنادول');
    await user.clear(search);
    expect(props.onRecover).toHaveBeenCalled();
  });

  it('ignores an empty scan terminator', async () => {
    const props = rail({ kind: 'idle' });
    render(<LiveProductRail {...props} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' }), '   {Enter}');
    expect(props.onScan).not.toHaveBeenCalled();
  });

  it('shows an absolute last-update stamp and refresh feedback', () => {
    const props = rail(
      { kind: 'idle' },
      {
        freshness: 'updated',
        lastSuccessAt: '2026-06-07T10:42:00.000Z',
        feedback: 'already-running',
      },
    );
    render(<LiveProductRail {...props} />);
    expect(screen.getByText(/آخر تحديث:/)).toBeInTheDocument();
    expect(screen.getByText('جارٍ التحديث بالفعل')).toBeInTheDocument();
  });

  it('does not crash on an unparseable timestamp and shows it verbatim', () => {
    const props = rail(
      { kind: 'idle' },
      {
        freshness: 'synced-empty',
        lastSuccessAt: 'not-a-date',
      },
    );
    render(<LiveProductRail {...props} />);
    expect(screen.getByText(/not-a-date/)).toBeInTheDocument();
  });
});

const LINE: CartLineItem = {
  lineId: 'line-1',
  displayName: 'بنادول',
  quantity: 2,
  unitPriceMinor: 1500,
  lineSubtotalMinor: 3000,
  note: null,
  version: 1,
};

function cart(
  over: Partial<Parameters<typeof LiveSaleCart>[0]> = {},
): Parameters<typeof LiveSaleCart>[0] {
  return {
    lines: [LINE],
    discounts: [],
    subtotalMinor: 3000,
    itemCount: 2,
    frozenSubtotalMinor: null,
    canHandoff: true,
    handingOff: false,
    cancelled: false,
    canVoid: true,
    canContinue: false,
    handoffError: null,
    onIncrement: vi.fn(),
    onDecrement: vi.fn(),
    onRemove: vi.fn(),
    onSaveNote: vi.fn().mockResolvedValue(true),
    onRemoveDiscount: vi.fn(),
    onHandoff: vi.fn(),
    onContinue: vi.fn(),
    onVoid: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

describe('LiveSaleCart controls', () => {
  it('removes a line and an opaque discount placeholder through callbacks only', async () => {
    const props = cart({
      discounts: [
        { placeholderId: 'dp-1', lineId: 'line-1', attribution_operator_id: 'op-secret' },
      ],
    });
    render(<LiveSaleCart {...props} />);
    const user = userEvent.setup();
    expect(screen.getByText('خصم قيد المعالجة')).toBeInTheDocument();
    expect(screen.queryByText(/op-secret/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'إزالة الخصم' }));
    expect(props.onRemoveDiscount).toHaveBeenCalledWith('dp-1');
    await user.click(screen.getByRole('button', { name: 'حذف' }));
    expect(props.onRemove).toHaveBeenCalledWith(LINE);
  });

  it('closes the void and note dialogs from their secondary buttons without side effects', async () => {
    const props = cart();
    render(<LiveSaleCart {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    await user.click(screen.getByRole('button', { name: 'العودة' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ملاحظة' }));
    await user.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(props.onVoid).not.toHaveBeenCalled();
    expect(props.onSaveNote).not.toHaveBeenCalled();
  });

  it('shows handoff progress and the cancelled state honestly', () => {
    const { rerender } = render(<LiveSaleCart {...cart({ handingOff: true })} />);
    expect(screen.getByRole('button', { name: /جارٍ تسليم السلة/ })).toBeDisabled();
    rerender(<LiveSaleCart {...cart({ cancelled: true, canVoid: false })} />);
    expect(screen.getByText('تم إلغاء البيع.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'حذف' })).not.toBeInTheDocument();
  });

  it('keeps the void dialog open when the bridge refuses', async () => {
    const props = cart({ onVoid: vi.fn().mockResolvedValue(false) });
    render(<LiveSaleCart {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'إلغاء البيع' }));
    await user.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    await waitFor(() => {
      expect(props.onVoid).toHaveBeenCalledOnce();
    });
    expect(screen.getByRole('dialog', { name: 'تأكيد إلغاء البيع' })).toBeInTheDocument();
  });
});
