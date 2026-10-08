import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ScreenTooSmall } from '../index';

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
