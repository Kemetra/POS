/**
 * RT-238 — the action bar's building blocks on their own: where `PinnedPrimary`
 * renders in each ownership state, and how `FocusWhen` behaves when there is
 * nothing to focus or nobody to tell.
 */
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CheckoutActionBar,
  FocusWhen,
  PinnedPrimary,
  PrimarySlotContext,
} from '../CheckoutActionBar.js';

afterEach(cleanup);

function Bar(props: { entryOwnsPrimary: boolean }): JSX.Element {
  const [node, setNode] = useState<HTMLElement | null>(null);
  return (
    <PrimarySlotContext.Provider value={{ node, entryOwnsPrimary: props.entryOwnsPrimary }}>
      <div data-testid="entry">
        <PinnedPrimary>
          <button type="button">تطبيق</button>
        </PinnedPrimary>
      </div>
      <CheckoutActionBar
        endSlotRef={setNode}
        cancel={null}
        commit={null}
        reason={null}
        notices={null}
      />
    </PrimarySlotContext.Provider>
  );
}

describe('PinnedPrimary', () => {
  it('renders in place when there is no action bar', () => {
    render(
      <div data-testid="entry">
        <PinnedPrimary>
          <button type="button">تطبيق</button>
        </PinnedPrimary>
      </div>,
    );
    expect(screen.getByTestId('entry')).toContainElement(screen.getByRole('button'));
  });

  it('moves into the end slot when the entry owns the primary', () => {
    render(<Bar entryOwnsPrimary />);
    const end = screen.getByTestId('payment-surface-actions').querySelector('[data-slot="end"]');
    expect(end).toContainElement(screen.getByRole('button', { name: 'تطبيق' }));
    expect(screen.getByTestId('entry')).toBeEmptyDOMElement();
  });

  it('is not rendered at all inside the bar when the entry does not own the primary', () => {
    render(<Bar entryOwnsPrimary={false} />);
    expect(screen.queryByRole('button', { name: 'تطبيق' })).not.toBeInTheDocument();
  });
});

describe('FocusWhen', () => {
  it('focuses the target and reports it when it turns active', () => {
    const onFocused = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">هدف</button>
        <FocusWhen active={false} find={() => screen.getByRole('button')} onFocused={onFocused} />
      </>,
    );
    expect(onFocused).not.toHaveBeenCalled();
    rerender(
      <>
        <button type="button">هدف</button>
        <FocusWhen active find={() => screen.getByRole('button')} onFocused={onFocused} />
      </>,
    );
    expect(screen.getByRole('button')).toHaveFocus();
    expect(onFocused).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no target, and does not report a move', () => {
    const onFocused = vi.fn();
    render(<FocusWhen active find={() => null} onFocused={onFocused} />);
    expect(onFocused).not.toHaveBeenCalled();
  });

  it('works without a callback', () => {
    render(
      <>
        <button type="button">هدف</button>
        <FocusWhen active find={() => screen.getByRole('button')} />
      </>,
    );
    expect(screen.getByRole('button')).toHaveFocus();
  });
});
