import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { ListCashierPinStatusResponse } from '../../../../shared/bridge-api';
import { useCashierList } from '../use-cashier-list';

/**
 * RT-424 — the list hook: a missing bridge method reads as a refusal, and only
 * the latest read may apply.
 */

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ROW = { id: 'a', display_name: 'أ', pin: 'ready' as const };

describe('RT-424 useCashierList', () => {
  it('a bridge without the method (an old test double) reads as refused, not a crash', async () => {
    const { result } = renderHook(() => useCashierList({}));
    await waitFor(() => {
      expect(result.current.list).toEqual({ kind: 'failed', reason: 'refused' });
    });
    expect(result.current.reading).toBe(false);
  });

  it('drops an older read that lands after a newer one', async () => {
    const first = deferred<ListCashierPinStatusResponse>();
    const second = deferred<ListCashierPinStatusResponse>();
    const answers = [first.promise, second.promise];
    const operator = { listCashierPinStatus: () => answers.shift() ?? second.promise };
    const { result } = renderHook(() => useCashierList(operator));

    // The mount read is `first`; this reload is `second`.
    act(() => {
      void result.current.reload();
    });
    await act(async () => {
      second.resolve({ kind: 'cashiers', cashiers: [ROW] });
      await second.promise;
    });
    expect(result.current.list).toEqual({ kind: 'rows', cashiers: [ROW] });

    await act(async () => {
      first.resolve({ kind: 'refused', category: 'no_connection' });
      await first.promise;
    });
    expect(result.current.list).toEqual({ kind: 'rows', cashiers: [ROW] });
    expect(result.current.landed).toBe(1);
  });

  it('an answer after unmount touches nothing', async () => {
    const gate = deferred<ListCashierPinStatusResponse>();
    const { result, unmount } = renderHook(() =>
      useCashierList({ listCashierPinStatus: () => gate.promise }),
    );
    unmount();
    await act(async () => {
      gate.resolve({ kind: 'cashiers', cashiers: [ROW] });
      await gate.promise;
    });
    expect(result.current.list).toEqual({ kind: 'loading' });
  });
});
