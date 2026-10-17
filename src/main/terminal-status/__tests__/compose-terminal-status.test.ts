/**
 * RT-601 (VN-S6 S6-1a) — the composition of the connection monitor: the
 * passive feeder wraps a fetch, transitions are logged as `{ from, to }` only,
 * and a tick timer applies the time rules until it is stopped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TERMINAL_STATUS_TICK_MS, composeTerminalStatus } from '../compose-terminal-status.js';
import { TERMINAL_STATUS_TRANSITION_LOG } from '../terminal-status-monitor.js';

const T0 = Date.parse('2026-10-17T12:00:00.000Z');

/** The URL a fetch was called with. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

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

/**
 * RT-602 (VN-S6 S6-1b) — the composition with the active feeder: the probe uses
 * the unobserved fetch (it is not passive traffic), the tick worker drives it,
 * `powerMonitor` resume and the `net.isOnline()` edge reach the monitor, and
 * stop removes the listener and ends the probing.
 */
describe('RT-602 composeTerminalStatus — active probe, resume and interface', () => {
  type ResumeListener = () => void;

  function probeHarness(opts: { interfaceUp?: () => boolean } = {}) {
    const clock = { t: T0 };
    const timers: Array<() => void> = [];
    const probeCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const probeReplies: Array<() => Promise<Response>> = [];
    const listeners = new Set<ResumeListener>();
    const powerMonitor = {
      on: vi.fn((_event: 'resume', l: ResumeListener) => {
        listeners.add(l);
      }),
      removeListener: vi.fn((_event: 'resume', l: ResumeListener) => {
        listeners.delete(l);
      }),
    };
    const status = composeTerminalStatus({
      now: () => clock.t,
      logger: { info: () => undefined },
      setInterval: (fn) => {
        timers.push(fn);
        return {};
      },
      clearInterval: () => undefined,
      probe: {
        baseUrl: 'https://backend.example',
        fetch: (input, init) => {
          probeCalls.push({ url: requestUrl(input), init });
          const reply = probeReplies.shift();
          return reply ? reply() : Promise.resolve(Response.json({ status: 'ok' }));
        },
        isInterfaceOnline: opts.interfaceUp ?? (() => true),
        powerMonitor,
      },
    });
    const tick = async (): Promise<void> => {
      for (const fn of timers) fn();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };
    return { status, clock, tick, probeCalls, probeReplies, listeners, powerMonitor };
  }

  it('the first tick probes the liveness URL with the unobserved fetch and goes online', async () => {
    const h = probeHarness();
    await h.tick();
    expect(h.probeCalls.map((c) => c.url)).toEqual(['https://backend.example/api/v1/health/live']);
    expect(new Headers(h.probeCalls[0]?.init?.headers).has('authorization')).toBe(false);
    expect(h.status.monitor.snapshot().connection).toBe('online');
  });

  it('does not probe while passive traffic is recent or in flight', async () => {
    const h = probeHarness();
    await h.tick();
    let release: (r: Response) => void = () => undefined;
    const passive = h.status.observeFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const call = passive('https://backend.example/api/pos/v1/sales');
    h.clock.t += 30_000;
    await h.tick();
    expect(h.probeCalls).toHaveLength(1);
    release(new Response(null, { status: 201 }));
    await call;
    h.clock.t += 9_000;
    await h.tick();
    expect(h.probeCalls).toHaveLength(1);
    h.clock.t += 1_000;
    await h.tick();
    expect(h.probeCalls).toHaveLength(2);
  });

  it('a passive transport fault still counts as traffic and ends the in-flight hold', async () => {
    const h = probeHarness();
    await h.tick();
    const passive = h.status.observeFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(passive('https://backend.example/x')).rejects.toThrow('fetch failed');
    h.clock.t += 10_000;
    await h.tick();
    expect(h.probeCalls).toHaveLength(2);
  });

  it('powerMonitor resume → checking, then the next tick probes', async () => {
    const h = probeHarness();
    await h.tick();
    expect(h.powerMonitor.on).toHaveBeenCalledWith('resume', expect.any(Function));
    h.clock.t += 2_000;
    for (const l of h.listeners) l();
    expect(h.status.monitor.snapshot().connection).toBe('checking');
    await h.tick();
    expect(h.probeCalls).toHaveLength(2);
    expect(h.status.monitor.snapshot().connection).toBe('online');
  });

  it('net.isOnline() false → offline on the next tick; true alone never online', async () => {
    let up = false;
    const h = probeHarness({ interfaceUp: () => up });
    h.probeReplies.push(() => Promise.reject(new TypeError('fetch failed')));
    await h.tick();
    expect(h.status.monitor.snapshot().connection).toBe('offline');
    up = true;
    h.probeReplies.push(() => Promise.reject(new TypeError('fetch failed')));
    h.clock.t += 1_000;
    await h.tick();
    expect(h.status.monitor.snapshot().connection).toBe('offline');
  });

  it('a throwing interface read is ignored', async () => {
    const h = probeHarness({
      interfaceUp: () => {
        throw new Error('no net');
      },
    });
    await h.tick();
    expect(h.status.monitor.snapshot().connection).toBe('online');
  });

  it('stop removes the resume listener and probes no more', async () => {
    const h = probeHarness();
    await h.tick();
    h.status.stop();
    expect(h.powerMonitor.removeListener).toHaveBeenCalledWith('resume', expect.any(Function));
    expect(h.listeners.size).toBe(0);
    h.clock.t += 60_000;
    await h.tick();
    expect(h.probeCalls).toHaveLength(1);
  });
});
