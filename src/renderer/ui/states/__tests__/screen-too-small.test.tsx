import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ScreenTooSmall } from '../index';
import { expectNoAxeViolations } from '../../primitives/__tests__/axe-config';

afterEach(cleanup);

/**
 * T013 — ScreenTooSmall frozen-copy assertions.
 * (contracts/shell-regions.md §"ScreenTooSmall"; copy amended by RT-241 to M-F2)
 */
describe('ScreenTooSmall (T013)', () => {
  it('heading carries the M-F2 copy (RT-241)', () => {
    render(<ScreenTooSmall />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('الشاشة أصغر من 1024×768.');
  });

  it('body carries the M-F2 action', () => {
    render(<ScreenTooSmall />);
    expect(screen.getByText('كبّر النافذة أو استخدم شاشة أكبر.')).toBeInTheDocument();
  });

  it('renders Arabic RTL, with the size as an isolated LTR run', () => {
    render(<ScreenTooSmall />);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('dir', 'rtl');
    expect(main).toHaveAttribute('lang', 'ar');
    const size = screen.getByText('1024×768');
    expect(size.tagName).toBe('BDI');
    expect(size).toHaveAttribute('dir', 'ltr');
  });

  it('exactly one <h1>', () => {
    const { container } = render(<ScreenTooSmall />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('exactly one <main>', () => {
    const { container } = render(<ScreenTooSmall />);
    expect(container.querySelectorAll('main')).toHaveLength(1);
  });

  it('zero actionable elements — no button, a, input, or [role="button"]', () => {
    const { container } = render(<ScreenTooSmall />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
  });

  it('heading receives focus on mount (tabIndex=-1 + focus)', () => {
    render(<ScreenTooSmall />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(document.activeElement).toBe(heading);
  });
});

/**
 * RT-313 (RT-312 D5) — the M-F2 variants. `width` is the copy above, unchanged;
 * `height` is the height message; `both` states the size and gives the height
 * action. Western digits, each an isolated LTR run.
 */
const HEIGHT_HEADING = 'ارتفاع الشاشة أقل من الحد المدعوم.';
const HEIGHT_ACTION = /^كبّر النافذة، أو اضبط مقياس العرض في Windows على 100% أو 125%\s?\.$/;

function body(container: HTMLElement): Element | null {
  return container.querySelector('.screen-too-small__body');
}

describe('ScreenTooSmall variants (RT-313)', () => {
  it('defaults to the width variant', () => {
    render(<ScreenTooSmall />);
    expect(screen.getByRole('main')).toHaveAttribute('data-shortfall', 'width');
  });

  it('height: the height heading and the Windows-scale action', () => {
    const { container } = render(<ScreenTooSmall shortfall="height" />);
    expect(screen.getByRole('main')).toHaveAttribute('data-shortfall', 'height');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(HEIGHT_HEADING);
    expect(body(container)).toHaveTextContent(HEIGHT_ACTION);
    expect(screen.queryByText('1024×768')).not.toBeInTheDocument();
  });

  it('both: the size heading with the height action, not the width action', () => {
    const { container } = render(<ScreenTooSmall shortfall="both" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('الشاشة أصغر من 1024×768.');
    expect(body(container)).toHaveTextContent(HEIGHT_ACTION);
    expect(screen.queryByText('كبّر النافذة أو استخدم شاشة أكبر.')).not.toBeInTheDocument();
  });

  it.each(['height', 'both'] as const)(
    '%s: the scale percentages are Western digits in LTR isolates',
    (shortfall) => {
      render(<ScreenTooSmall shortfall={shortfall} />);
      for (const scale of ['100%', '125%']) {
        const run = screen.getByText(scale);
        expect(run.tagName).toBe('BDI');
        expect(run).toHaveAttribute('dir', 'ltr');
      }
      expect(document.body.textContent).not.toMatch(/[٠-٩]/);
    },
  );

  it.each(['height', 'both'] as const)(
    '%s: one <main>, one <h1>, nothing actionable, Arabic RTL',
    (shortfall) => {
      const { container } = render(<ScreenTooSmall shortfall={shortfall} />);
      expect(container.querySelectorAll('main')).toHaveLength(1);
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      expect(container.querySelectorAll('button, a, input, [role="button"]')).toHaveLength(0);
      expect(screen.getByRole('main')).toHaveAttribute('dir', 'rtl');
      expect(screen.getByRole('main')).toHaveAttribute('lang', 'ar');
    },
  );

  it('focus goes to the heading on entry, and to the new heading when the variant changes', () => {
    const { rerender } = render(<ScreenTooSmall shortfall="width" />);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));

    rerender(<ScreenTooSmall shortfall="height" />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(HEIGHT_HEADING);
    expect(document.activeElement).toBe(heading);
  });
});

describe('ScreenTooSmall accessibility (RT-313)', () => {
  it.each(['width', 'height', 'both'] as const)('%s: no axe violations', async (shortfall) => {
    const { container } = render(<ScreenTooSmall shortfall={shortfall} />);
    await expectNoAxeViolations(container);
  });
});
