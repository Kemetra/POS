/**
 * RT-17 slice 4 part 3 — the shift screens' bridge access and formatting
 * helpers: no bridge without the namespace, the last status read wins, one
 * call at a time, and entry / display formatting that never guesses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { ShiftStatusResponse } from '../../../shared/shift-cashup/types';
import { useShiftStatus, useSingleFlight, windowShiftBridge } from '../shift/shift-bridge';
import {
  formatShiftMoney,
  formatShiftTime,
  normalizeDigits,
  parseShiftAmount,
} from '../shift/shift-format';
import { fakeShiftBridge, openShiftView, statusView } from './__helpers__/shift-test-kit';

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api;
});

describe('windowShiftBridge', () => {
  it('is null without window.api or without its shiftCashup namespace', () => {
    expect(windowShiftBridge()).toBeNull();
    (window as unknown as { api: unknown }).api = {};
    expect(windowShiftBridge()).toBeNull();
  });
});

describe('useShiftStatus — the last read wins', () => {
  it('ignores an earlier read that answers after a later one', async () => {
    const bridge = fakeShiftBridge();
    let answerFirst: (value: ShiftStatusResponse) => void = () => undefined;
    bridge.status
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        kind: 'status',
        status: statusView({ openShift: openShiftView() }),
      });
    const { result } = renderHook(() => useShiftStatus(bridge));
    act(() => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(result.current.state.kind).toBe('status');
    });
    await act(async () => {
      answerFirst({ kind: 'status', status: statusView() });
      await Promise.resolve();
    });
    const { state } = result.current;
    expect(state.kind === 'status' && state.status.openShift).not.toBeNull();
  });
});

describe('useSingleFlight — one call at a time', () => {
  it('drops a second run while the first is in flight, then accepts again', async () => {
    const { result } = renderHook(() => useSingleFlight());
    let finish: () => void = () => undefined;
    const calls: string[] = [];
    act(() => {
      result.current.run(
        () =>
          new Promise<void>((resolve) => {
            calls.push('first');
            finish = resolve;
          }),
      );
      result.current.run(() => {
        calls.push('second');
        return Promise.resolve();
      });
    });
    expect(result.current.busy).toBe(true);
    expect(calls).toEqual(['first']);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(false);
    act(() => {
      result.current.run(() => {
        calls.push('third');
        return Promise.resolve();
      });
    });
    expect(calls).toEqual(['first', 'third']);
  });
});

describe('shift formatting', () => {
  it('formats EGP minor units, and a dash for anything it cannot show exactly', () => {
    expect(formatShiftMoney(-750)).toBe('-7.50 EGP');
    expect(formatShiftMoney(100, 'USD')).toBe('—');
    expect(formatShiftMoney(1.5)).toBe('—');
  });

  it('formats a time with Western digits, and a dash for an invalid instant', () => {
    expect(formatShiftTime('2026-10-06T08:00:00.000Z')).toMatch(/\d/);
    expect(formatShiftTime('2026-10-06T08:00:00.000Z')).not.toMatch(/[٠-٩]/);
    expect(formatShiftTime('not a time')).toBe('—');
  });

  it('normalises Arabic-Indic and Persian digits and trims', () => {
    expect(normalizeDigits(' ١٢٣ ')).toBe('123');
    expect(normalizeDigits('۴۵۶')).toBe('456');
  });

  it.each<[string, number | null]>([
    ['12.5', 1_250],
    ['٠', 0],
    ['1,000', null],
    ['1e3', null],
    ['-1', null],
  ])('parses %j to %j minor units', (raw, minor) => {
    expect(parseShiftAmount(raw)).toBe(minor);
  });
});
