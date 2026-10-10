/**
 * RT-242 (freeze A1 `UndoNotice`, UX-11) — the Undo offer's lifetime is
 * presentation only, and focus or pointer inside the notice holds it.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { CartStatusLine, UNDO_NOTICE_MS } from '../sale/CartStatusLine';
import type { UndoOffer } from '../../sale/useSaleUndo';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function offer(seq: number, kind: UndoOffer['kind'] = 'added'): UndoOffer {
  return {
    kind,
    name: 'بنادول',
    cartId: 'cart-1',
    targetActionId: `action-${String(seq)}`,
    undoKey: `undo-${String(seq)}`,
    seq,
  };
}

function view(current: UndoOffer, canUndo = true) {
  return (
    <CartStatusLine
      announcement={{ kind: current.kind, name: current.name, seq: current.seq }}
      offer={current}
      canUndo={canUndo}
      onUndo={vi.fn()}
    />
  );
}

const UNDO = { name: 'تراجع عن إضافة بنادول' };

describe('CartStatusLine', () => {
  it('withdraws «تراجع» after its lifetime, keeping the acknowledgement', () => {
    render(view(offer(1)));
    expect(screen.getByRole('button', UNDO)).toHaveTextContent('تراجع');
    act(() => {
      vi.advanceTimersByTime(UNDO_NOTICE_MS);
    });
    expect(screen.queryByRole('button', UNDO)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('أُضيف: بنادول');
  });

  it('holds while focused or hovered, and restarts when focus leaves', () => {
    render(view(offer(1)));
    const button = screen.getByRole('button', UNDO);
    act(() => {
      button.focus();
    });
    act(() => {
      vi.advanceTimersByTime(UNDO_NOTICE_MS * 3);
    });
    expect(screen.getByRole('button', UNDO)).toBeInTheDocument();
    act(() => {
      button.blur();
    });
    fireEvent.pointerEnter(button.parentElement as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(UNDO_NOTICE_MS * 3);
    });
    expect(screen.getByRole('button', UNDO)).toBeInTheDocument();
    fireEvent.pointerLeave(button.parentElement as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(UNDO_NOTICE_MS);
    });
    expect(screen.queryByRole('button', UNDO)).not.toBeInTheDocument();
  });

  it('a new offer restarts the lifetime', () => {
    const { rerender } = render(view(offer(1)));
    act(() => {
      vi.advanceTimersByTime(UNDO_NOTICE_MS - 1);
    });
    rerender(view(offer(2)));
    act(() => {
      vi.advanceTimersByTime(UNDO_NOTICE_MS - 1);
    });
    expect(screen.getByRole('button', UNDO)).toBeInTheDocument();
  });

  it('keeps «تراجع» outside the live region, so it is not re-announced', () => {
    render(view(offer(1, 'removed')));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('حُذف بنادول.');
    expect(status).not.toContainElement(
      screen.getByRole('button', { name: 'تراجع عن حذف بنادول' }),
    );
  });

  it('shows no button when the bridge cannot undo', () => {
    render(view(offer(1), false));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
