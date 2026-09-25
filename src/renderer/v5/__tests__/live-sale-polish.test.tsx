import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { FreshnessState } from '../../sale/useCatalogueFreshness';
import type { CartLineItem } from '../../sale/useSaleCartController';
import { LiveProductRail } from '../sale/LiveProductRail';
import { LiveSaleCart } from '../sale/LiveSaleCart';

afterEach(() => {
  cleanup();
});

const LINE: CartLineItem = {
  lineId: 'line-1',
  displayName: 'باراسيتامول',
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

function cartHeading(): HTMLElement {
  const heading = screen.getByRole('heading', { name: 'سلة المشتريات' });
  const bar = heading.closest<HTMLElement>('.v5-sale-cart-heading');
  if (bar === null) throw new Error('cart heading bar missing');
  return bar;
}

describe('v5 Sale polish — transaction state in the cart heading', () => {
  it('shows no state label while the cart is still being edited', () => {
    render(<LiveSaleCart {...cart()} />);
    expect(cartHeading().querySelector('.v5-live-cart-state')).toBeNull();
  });

  it.each([
    ['frozen, awaiting payment', { frozenSubtotalMinor: 3000, canVoid: false }, 'مُسلّمة للدفع'],
    ['paid', { frozenSubtotalMinor: 3000, canVoid: false, paid: true }, 'مدفوعة'],
    ['cancelled', { cancelled: true, canVoid: false }, 'ملغاة'],
  ] as const)('labels the %s cart from existing props only', (_name, over, label) => {
    render(<LiveSaleCart {...cart(over)} />);
    const state = cartHeading().querySelector('.v5-live-cart-state');
    expect(state).toHaveTextContent(label);
    // A label, not a live region: the actions area already announces changes.
    expect(state).not.toHaveAttribute('role');
  });

  it('places the void entry point in the cart heading, not on its own toolbar row', () => {
    render(<LiveSaleCart {...cart()} />);
    const voidButton = screen.getByRole('button', { name: 'إلغاء البيع' });
    expect(cartHeading()).toContainElement(voidButton);
  });

  it('drops the decorative eyebrow above the cart heading', () => {
    render(<LiveSaleCart {...cart()} />);
    expect(screen.queryByText('المعاملة الجارية')).not.toBeInTheDocument();
  });
});

describe('v5 Sale polish — action notices carry their tone', () => {
  it('renders a handoff failure as a danger notice', () => {
    render(<LiveSaleCart {...cart({ handoffError: 'تعذّر تسليم السلة.' })} />);
    expect(screen.getByRole('alert')).toHaveClass('v5-live-notice', 'v5-live-notice--danger');
  });

  it('renders the paid and voided acknowledgements as state notices', () => {
    const { rerender } = render(
      <LiveSaleCart {...cart({ frozenSubtotalMinor: 3000, canVoid: false, paid: true })} />,
    );
    expect(screen.getByText('تم الدفع لهذه السلة.')).toHaveClass('v5-live-notice--success');
    rerender(<LiveSaleCart {...cart({ lines: [], canVoid: false, voided: true })} />);
    expect(screen.getByText('تم إلغاء البيع.')).toHaveClass('v5-live-notice');
  });
});

describe('v5 Sale polish — catalogue freshness tone', () => {
  function renderRail(freshness: FreshnessState): HTMLElement {
    render(
      <LiveProductRail
        state={{ kind: 'idle' }}
        freshness={freshness}
        lastSuccessAt="2026-09-24T10:00:00.000Z"
        feedback="idle"
        refreshing={false}
        onRefresh={vi.fn()}
        onSearch={vi.fn()}
        onScan={vi.fn()}
        onSelect={vi.fn()}
        onRecover={vi.fn()}
        searchRef={{ current: null }}
      />,
    );
    const bar = screen.getByRole('button', { name: 'تحديث الكتالوج' }).closest('[data-tone]');
    if (!(bar instanceof HTMLElement)) throw new Error('freshness bar missing');
    return bar;
  }

  it.each([
    ['never-synced', 'warning'],
    ['unavailable', 'warning'],
    ['synced-empty', 'warning'],
    ['updated', 'neutral'],
    ['loading', 'neutral'],
  ] as const)('marks %s as %s', (freshness, tone) => {
    expect(renderRail(freshness)).toHaveAttribute('data-tone', tone);
  });

  it('keeps the scanner field distinct from typed search without renaming it', () => {
    renderRail('updated');
    const scan = screen.getByRole('textbox', { name: 'حقل التقاط مسح الباركود' });
    expect(scan.closest('.v5-live-scan-field')).not.toBeNull();
    expect(scan.closest('.v5-sale-search-field')).toBeNull();
  });
});

describe('v5 Sale polish — CSS states', () => {
  const css = readFileSync(resolve(__dirname, '../sale/live-sale.css'), 'utf8');

  it('shows which search result the keyboard has selected', () => {
    expect(css).toMatch(/\.v5-sale-product-row\[aria-selected='true'\]\s*\{/);
    expect(css).toMatch(/\.v5-sale-product-list:focus-visible\s*\{/);
  });

  it('sizes the search recovery buttons with the other live controls', () => {
    const rule = /((?:[^{}]*,\s*)?\.v5-live-message button[^{]*)\{([^}]*)\}/.exec(css);
    expect(rule, 'recovery button rule').not.toBeNull();
    expect(rule?.[2]).toMatch(/min-block-size:\s*44px/);
  });

  it('makes a disabled primary action read as unavailable, not as a pale enabled button', () => {
    const rule = /\.v5-sale-checkout:disabled\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/background:\s*var\(--color-surface-sunken\)/);
    expect(rule?.[1]).not.toMatch(/opacity/);
  });
});

describe('v5 Sale polish — frozen cart stays keyboard-scrollable', () => {
  it('exposes the line area as a focusable, named region', () => {
    render(<LiveSaleCart {...cart({ frozenSubtotalMinor: 3000, canVoid: false })} />);
    expect(screen.getByRole('region', { name: 'بنود السلة' })).toHaveAttribute('tabindex', '0');
  });
});

describe('v5 Sale polish — CTA label size', () => {
  it('keeps the CTA label at the CTA size when the arrow is absent (handing off)', () => {
    const css = readFileSync(resolve(__dirname, '../sale/live-sale.css'), 'utf8');
    const rule = /\.v5-live-sale \.v5-sale-checkout span:last-child\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'live CTA label override').not.toBeNull();
    expect(rule?.[1]).toMatch(/font-size:\s*inherit/);
  });
});
