/**
 * RT-601 (VN-S6 S6-1a) — the composition of the connection monitor: the
 * passive feeder wraps a fetch, transitions are logged as `{ from, to }` only,
 * and a tick timer applies the time rules until it is stopped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TERMINAL_STATUS_TICK_MS, composeTerminalStatus } from '../compose-terminal-status.js';
import { TERMINAL_STATUS_TRANSITION_LOG } from '../terminal-status-monitor.js';

const T0 = Date.parse('2026-10-17T12:00:00.000Z');

function harness() {
  const clock = { t: T0 };
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const handle = { unref: vi.fn() };
  const status = composeTerminalStatus({
    now: () => clock.t,
    logger: {
      info: (obj, msg) => {
        lines.push({ obj, msg });
      },
    },
    setInterval: (fn, ms) => {
      expect(ms).toBe(TERMINAL_STATUS_TICK_MS);
      timers.push(fn);
      return handle;
    },
    clearInterval: (h) => {
      cleared.push(h);
    },
  });
  return { status, clock, lines, timers, cleared, handle };
}

describe('RT-601 composeTerminalStatus', () => {
  it('starts at checking and does not keep the process alive', () => {
    const { status, handle, timers } = harness();
    expect(status.monitor.snapshot().connection).toBe('checking');
    expect(timers).toHaveLength(1);
    expect(handle.unref).toHaveBeenCalled();
  });

  it('an observed Backend-Core answer moves it online and logs {from, to} only', async () => {
    const { status, lines } = harness();
    const fetch = status.observeFetch(() => Promise.resolve(new Response(null, { status: 200 })));
    await fetch('https://backend.example/api/pos/v1/cashier-admissions/roster');
    expect(status.monitor.snapshot().connection).toBe('online');
    expect(lines).toEqual([
      { obj: { from: 'checking', to: 'online' }, msg: TERMINAL_STATUS_TRANSITION_LOG },
    ]);
  });

  it('the tick timer applies the freshness window', async () => {
    const { status, clock, timers, lines } = harness();
    const fetch = status.observeFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    await fetch('https://backend.example/x');
    clock.t += 30_000;
    for (const fn of timers) fn();
    expect(lines.map((l) => l.obj)).toEqual([
      { from: 'checking', to: 'online' },
      { from: 'online', to: 'checking' },
    ]);
  });

  it('stop clears the timer once', () => {
    const { status, cleared, handle } = harness();
    status.stop();
    status.stop();
    expect(cleared).toEqual([handle]);
  });
});

describe('RT-601 composeTerminalStatus — default clock and timers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks on the real interval, uses Date.now, and stop clears the interval', async () => {
    vi.useFakeTimers({ now: T0 });
    const lines: Array<Record<string, unknown>> = [];
    const status = composeTerminalStatus({
      logger: {
        info: (obj) => {
          lines.push(obj);
        },
      },
    });
    expect(vi.getTimerCount()).toBe(1);

    const fetch = status.observeFetch(() => Promise.resolve(new Response(null, { status: 200 })));
    await fetch('https://backend.example/x');
    expect(status.monitor.snapshot().connectionSince).toBe('2026-10-17T12:00:00.000Z');

    vi.advanceTimersByTime(30_000);
    expect(lines).toEqual([
      { from: 'checking', to: 'online' },
      { from: 'online', to: 'checking' },
    ]);

    status.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
