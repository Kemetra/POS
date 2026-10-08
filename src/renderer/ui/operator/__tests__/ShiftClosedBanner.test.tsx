import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShiftClosedBanner } from '../ShiftClosedBanner';

describe('ShiftClosedBanner (UX-12 date)', () => {
  afterEach(cleanup);

  it('shows the close date with Western digits and no clock', () => {
    const iso = new Date(2026, 5, 7, 15, 5, 0).toISOString();
    render(<ShiftClosedBanner closedAt={iso} onDismiss={() => undefined} />);
    const text = screen.getByTestId('shift-closed-banner').textContent;
    expect(text).toContain('2026');
    expect(text).not.toMatch(/[٠-٩۰-۹]/);
    expect(text).not.toContain('15:05');
  });

  it('falls back to the raw value when the timestamp is unparseable', () => {
    render(<ShiftClosedBanner closedAt="not-a-date" onDismiss={() => undefined} />);
    expect(screen.getByTestId('shift-closed-banner').textContent).toContain('not-a-date');
  });

  it('calls onDismiss', () => {
    const onDismiss = vi.fn();
    render(<ShiftClosedBanner closedAt="2026-06-07T12:00:00.000Z" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('shift-closed-banner-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
