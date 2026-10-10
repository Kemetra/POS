/**
 * RT-242 — `useSaleUndo` on its own: the preload-bridge fallback, the guards
 * that keep an Undo from being sent, and the ticket that suppresses a stale
 * offer. The Sale-screen behaviour is covered in live-sale-undo.test.tsx.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CartBridgeAPI } from '../../../shared/bridge-api';
import { useSaleUndo } from '../useSaleUndo';

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api;
});

function installPreload(cart: Partial<CartBridgeAPI>): void {
  (window as unknown as { api: { cart: Partial<CartBridgeAPI> } }).api = { cart };
}

describe('useSaleUndo', () => {
  it('reads the preload bridge when none is injected, and offers nothing without undoLast', () => {
    installPreload({});
    const { result } = renderHook(() => useSaleUndo({ resync: vi.fn() }));
    expect(result.current.canUndo).toBe(false);
  });

  it('offers nothing when there is no preload bridge at all', () => {
    const { result } = renderHook(() => useSaleUndo({ resync: vi.fn() }));
    expect(result.current.canUndo).toBe(false);
  });

  it('sends the Undo through the preload bridge, then re-reads and settles', async () => {
    const undoLast = vi
      .fn()
      .mockResolvedValue({ kind: 'ok', effect: 'removed', line_id: 'l-1', version: 2 });
    installPreload({ undoLast });
    const resync = vi.fn().mockResolvedValue(undefined);
    const onSettled = vi.fn();
    const { result } = renderHook(() => useSaleUndo({ resync, onSettled }));
    expect(result.current.canUndo).toBe(true);
    act(() => {
      result.current.offerUndo('added', 'بنادول', 'cart-1', 'add-key', 0);
    });
    await act(async () => {
      await result.current.undo();
    });
    expect(undoLast).toHaveBeenCalledWith(
      expect.objectContaining({ cart_id: 'cart-1', target_action_id: 'add-key' }),
    );
    expect(resync).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(result.current.offer).toBeNull();
    expect(result.current.announcement).toMatchObject({ kind: 'undone' });
  });

  it('sends nothing with no standing offer, or while one Undo is in flight', async () => {
    let settle: (value: unknown) => void = () => undefined;
    const undoLast = vi.fn(() => new Promise((resolve) => (settle = resolve)));
    const bridge = { undoLast } as unknown as CartBridgeAPI;
    const { result } = renderHook(() => useSaleUndo({ bridge, resync: vi.fn() }));
    await act(async () => {
      await result.current.undo();
    });
    expect(undoLast).not.toHaveBeenCalled();

    act(() => {
      result.current.offerUndo('removed', 'بروفين', 'cart-1', 'rm-key', 0);
    });
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.undo();
    });
    await act(async () => {
      await result.current.undo();
    });
    expect(undoLast).toHaveBeenCalledOnce();
    await act(async () => {
      settle({ kind: 'refused', reason: 'undo_not_available' });
      await first;
    });
    expect(result.current.announcement).toMatchObject({ kind: 'unavailable' });
  });

  it('a stale ticket announces the action but offers no Undo; clear drops both', () => {
    const bridge = { undoLast: vi.fn() } as unknown as CartBridgeAPI;
    const { result } = renderHook(() => useSaleUndo({ bridge, resync: vi.fn() }));
    let ticket = 0;
    act(() => {
      ticket = result.current.withdraw();
    });
    act(() => {
      result.current.dismiss();
    });
    act(() => {
      result.current.offerUndo('removed', 'بروفين', 'cart-1', 'rm-key', ticket);
    });
    expect(result.current.announcement).toMatchObject({ kind: 'removed', name: 'بروفين' });
    expect(result.current.offer).toBeNull();
    act(() => {
      result.current.clear();
    });
    expect(result.current.announcement).toBeNull();
  });
});
