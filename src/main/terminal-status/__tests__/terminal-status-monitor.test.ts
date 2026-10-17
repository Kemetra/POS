/**
 * RT-601 (VN-S6 S6-1a, doc 24 §2.2, §2.4, §2.5, §5.1 "Monitor") —
 * `TerminalStatusMonitor`, a pure state machine driven by a fake clock.
 *
 *  - It starts at `checking`, never `online` (§2.4).
 *  - `K` = 2 consecutive bad observations leave `online`.
 *  - Offline/degraded → online waits for a 5 s hold after a qualifying answer.
 *  - No evidence for `W` → `checking` (no `online` on inertia).
 *  - `resume` → `checking`. An interface-down report → `offline`; interface-up
 *    never yields `online`.
 */
import { describe, expect, it } from 'vitest';

import {
  TERMINAL_STATUS_DEFAULTS,
  TERMINAL_STATUS_TRANSITION_LOG,
  createTerminalStatusMonitor,
  logTerminalStatusTransition,
  type ConnectionStateCode,
  type ConnectionTransition,
  type ReachabilityObservation,
} from '../terminal-status-monitor.js';

const T0 = Date.parse('2026-10-17T12:00:00.000Z');
const OK: ReachabilityObservation = { kind: 'answer', status: 200 };
const FAULT: ReachabilityObservation = { kind: 'transport_fault' };
const EDGE_521: ReachabilityObservation = { kind: 'answer', status: 521 };

function harness() {
  const clock = { t: T0 };
  const transitions: ConnectionTransition[] = [];
  const monitor = createTerminalStatusMonitor({
    now: () => clock.t,
    onTransition: (t) => transitions.push(t),
  });
  const advance = (ms: number): void => {
    clock.t += ms;
  };
  return { monitor, transitions, advance, clock };
}

/** Drive a monitor to `online` and clear the recorded transitions. */
function online() {
  const h = harness();
  h.monitor.observe(OK);
  h.transitions.length = 0;
  return h;
}

describe('RT-601 TerminalStatusMonitor — defaults (D-6-3)', () => {
  it('uses the approved §2.5 values', () => {
    expect(TERMINAL_STATUS_DEFAULTS).toEqual({
      badStreakToLeave: 2,
      recoveryHoldMs: 5_000,
      freshnessWindowMs: 30_000,
    });
  });
});

describe('RT-601 TerminalStatusMonitor — initial state (§2.4)', () => {
  it('starts at checking with no contact, never online', () => {
    const { monitor } = harness();
    expect(monitor.snapshot()).toEqual({
      connection: 'checking',
      connectionSince: '2026-10-17T12:00:00.000Z',
      lastContactAt: null,
    });
  });

  it('stays checking with no traffic at all, however long it waits', () => {
    const { monitor, advance, transitions } = harness();
    advance(10 * 60_000);
    monitor.tick();
    expect(monitor.snapshot().connection).toBe('checking');
    expect(transitions).toEqual([]);
  });
});

describe('RT-601 TerminalStatusMonitor — checking → online', () => {
  it('one qualifying answer moves checking → online and records the contact', () => {
    const { monitor, transitions, advance } = harness();
    advance(1_000);
    monitor.observe(OK);
    expect(monitor.snapshot()).toEqual({
      connection: 'online',
      connectionSince: '2026-10-17T12:00:01.000Z',
      lastContactAt: '2026-10-17T12:00:01.000Z',
    });
    expect(transitions).toEqual([{ from: 'checking', to: 'online' }]);
  });

  it('a Backend-Core 401 counts as reachable (§2.4)', () => {
    const { monitor } = harness();
    monitor.observe({ kind: 'answer', status: 401 });
    expect(monitor.snapshot().connection).toBe('online');
  });

  it('an ignored status (3xx, 400, 408) is not evidence', () => {
    const { monitor } = harness();
    for (const status of [304, 400, 408]) monitor.observe({ kind: 'answer', status });
    expect(monitor.snapshot()).toMatchObject({ connection: 'checking', lastContactAt: null });
  });
});

describe('RT-601 TerminalStatusMonitor — K = 2 to leave online', () => {
  it('one transport fault does not leave online', () => {
    const { monitor, transitions } = online();
    monitor.observe(FAULT);
    expect(monitor.snapshot().connection).toBe('online');
    expect(transitions).toEqual([]);
  });

  it('two consecutive transport faults → offline', () => {
    const { monitor, transitions } = online();
    monitor.observe(FAULT);
    monitor.observe(FAULT);
    expect(monitor.snapshot().connection).toBe('offline');
    expect(transitions).toEqual([{ from: 'online', to: 'offline' }]);
  });

  it('two consecutive edge/server failures → degraded, never online', () => {
    const { monitor } = online();
    monitor.observe(EDGE_521);
    monitor.observe({ kind: 'answer', status: 503 });
    expect(monitor.snapshot().connection).toBe('degraded');
  });

  it('a qualifying answer between two faults resets the streak', () => {
    const { monitor } = online();
    monitor.observe(FAULT);
    monitor.observe(OK);
    monitor.observe(FAULT);
    expect(monitor.snapshot().connection).toBe('online');
  });

  it('from checking, K = 2 also applies before offline', () => {
    const { monitor } = harness();
    monitor.observe(FAULT);
    expect(monitor.snapshot().connection).toBe('checking');
    monitor.observe(FAULT);
    expect(monitor.snapshot().connection).toBe('offline');
  });

  it('once bad, the latest bad kind decides offline vs degraded', () => {
    const { monitor } = online();
    monitor.observe(FAULT);
    monitor.observe(FAULT);
    monitor.observe({ kind: 'answer', status: 502 });
    expect(monitor.snapshot().connection).toBe('degraded');
    monitor.observe(FAULT);
    expect(monitor.snapshot().connection).toBe('offline');
  });
});

/** A step: an observation, or a number of milliseconds to advance before a tick. */
type Step = ReachabilityObservation | number;

/** Drive a monitor to `offline` (two faults) and clear the recorded transitions. */
function offline() {
  const h = online();
  h.monitor.observe(FAULT);
  h.monitor.observe(FAULT);
  h.transitions.length = 0;
  return h;
}

const START = { online, offline } as const;

interface Scenario {
  name: string;
  from: keyof typeof START;
  steps: Step[];
  expected: ConnectionStateCode;
}

function play(scenario: Scenario): ReturnType<typeof harness> {
  const h = START[scenario.from]();
  for (const step of scenario.steps) {
    if (typeof step === 'number') {
      h.advance(step);
      h.monitor.tick();
    } else {
      h.monitor.observe(step);
    }
  }
  return h;
}

describe('RT-601 TerminalStatusMonitor — 5 s recovery hold', () => {
  it.each<Scenario>([
    {
      name: 'an answer while offline does not show online at once',
      from: 'offline',
      steps: [OK],
      expected: 'offline',
    },
    {
      name: 'the hold has not elapsed at 4.999 s',
      from: 'offline',
      steps: [OK, 4_999],
      expected: 'offline',
    },
    {
      name: 'online once the hold has elapsed (on tick)',
      from: 'offline',
      steps: [OK, 4_999, 1],
      expected: 'online',
    },
    {
      name: 'a later answer inside the hold does not restart it early',
      from: 'offline',
      steps: [OK, 4_000, OK],
      expected: 'offline',
    },
    {
      name: 'a bad observation during the hold cancels it',
      from: 'offline',
      steps: [OK, 2_000, FAULT, 4_000],
      expected: 'offline',
    },
    {
      name: 'degraded holds after an answer',
      from: 'online',
      steps: [EDGE_521, EDGE_521, OK],
      expected: 'degraded',
    },
    {
      name: 'degraded → online also waits for the hold',
      from: 'online',
      steps: [EDGE_521, EDGE_521, OK, 5_000],
      expected: 'online',
    },
  ])('$name', (scenario) => {
    expect(play(scenario).monitor.snapshot().connection).toBe(scenario.expected);
  });

  it('a later answer after the hold (no tick in between) also completes it', () => {
    const h = offline();
    h.monitor.observe(OK);
    h.advance(5_000);
    h.monitor.observe(OK);
    expect(h.transitions).toEqual([{ from: 'offline', to: 'online' }]);
  });

  it('records the contact during the hold, and reports the recovery once', () => {
    const h = play({ name: '', from: 'offline', steps: [1_000, OK, 5_000], expected: 'online' });
    expect(h.monitor.snapshot().lastContactAt).toBe('2026-10-17T12:00:01.000Z');
    expect(h.transitions).toEqual([{ from: 'offline', to: 'online' }]);
  });
});

describe('RT-601 TerminalStatusMonitor — freshness window W', () => {
  it.each<Scenario>([
    {
      name: 'online is still fresh just inside W',
      from: 'online',
      steps: [29_999],
      expected: 'online',
    },
    {
      name: 'online with no answer for W → checking (no inertia)',
      from: 'online',
      steps: [30_000],
      expected: 'checking',
    },
    {
      name: 'a single fault does not keep online fresh',
      from: 'online',
      steps: [25_000, FAULT, 5_000],
      expected: 'checking',
    },
    {
      name: 'offline with no evidence for W → checking',
      from: 'offline',
      steps: [30_000],
      expected: 'checking',
    },
    {
      name: 'continued faults keep offline',
      from: 'offline',
      steps: [20_000, FAULT, 20_000],
      expected: 'offline',
    },
  ])('$name', (scenario) => {
    expect(play(scenario).monitor.snapshot().connection).toBe(scenario.expected);
  });

  it('logs the expiry as online → checking', () => {
    const h = play({ name: '', from: 'online', steps: [30_000], expected: 'checking' });
    expect(h.transitions).toEqual([{ from: 'online', to: 'checking' }]);
  });

  it('expiry is also applied when the snapshot is read', () => {
    const { monitor, advance } = online();
    advance(30_000);
    expect(monitor.snapshot().connection).toBe('checking');
  });
});

describe('RT-601 TerminalStatusMonitor — resume and the network interface', () => {
  it('resume → checking from online, and keeps the last contact', () => {
    const { monitor, transitions } = online();
    monitor.resume();
    expect(monitor.snapshot()).toMatchObject({
      connection: 'checking',
      lastContactAt: '2026-10-17T12:00:00.000Z',
    });
    expect(transitions).toEqual([{ from: 'online', to: 'checking' }]);
  });

  it('resume → checking from offline, and drops a running hold', () => {
    const { monitor, advance } = online();
    monitor.observe(FAULT);
    monitor.observe(FAULT);
    monitor.observe(OK);
    monitor.resume();
    advance(5_000);
    monitor.tick();
    expect(monitor.snapshot().connection).toBe('checking');
  });

  it('interface down → offline at once (fast path), from online', () => {
    const { monitor, transitions } = online();
    monitor.observeInterface(false);
    expect(monitor.snapshot().connection).toBe('offline');
    expect(transitions).toEqual([{ from: 'online', to: 'offline' }]);
  });

  it('interface down → offline at once, from checking', () => {
    const { monitor } = harness();
    monitor.observeInterface(false);
    expect(monitor.snapshot().connection).toBe('offline');
  });

  it('interface up never yields online, from any state', () => {
    const fromChecking = harness();
    fromChecking.monitor.observeInterface(true);
    expect(fromChecking.monitor.snapshot().connection).toBe('checking');

    const fromOffline = online();
    fromOffline.monitor.observeInterface(false);
    fromOffline.monitor.observeInterface(true);
    fromOffline.advance(10_000);
    fromOffline.monitor.tick();
    expect(fromOffline.monitor.snapshot().connection).toBe('offline');
  });

  it('interface up does not refresh a stale online', () => {
    const { monitor, advance } = online();
    advance(29_000);
    monitor.observeInterface(true);
    advance(1_000);
    monitor.tick();
    expect(monitor.snapshot().connection).toBe('checking');
  });
});

describe('RT-601 TerminalStatusMonitor — observer isolation', () => {
  it('a throwing transition listener never breaks the monitor', () => {
    const monitor = createTerminalStatusMonitor({
      now: () => T0,
      onTransition: () => {
        throw new Error('listener boom');
      },
    });
    expect(() => {
      monitor.observe(OK);
    }).not.toThrow();
    expect(monitor.snapshot().connection).toBe('online');
  });
});

describe('RT-601 transition logging (A4-8, no PII)', () => {
  it('logs exactly {from, to} under the closed-set message', () => {
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    logTerminalStatusTransition(
      {
        info: (obj, msg) => {
          lines.push({ obj, msg });
        },
      },
      // Extra fields on the event must never reach the log line.
      { from: 'online', to: 'offline', url: 'https://host.example' } as ConnectionTransition,
    );
    expect(TERMINAL_STATUS_TRANSITION_LOG).toBe('terminal_status:transition');
    expect(lines).toEqual([
      { obj: { from: 'online', to: 'offline' }, msg: 'terminal_status:transition' },
    ]);
  });
});

describe('RT-601 TerminalStatusMonitor — wall-clock steps never drive durations', () => {
  function twoClocks() {
    const wall = { t: T0 };
    const mono = { t: 1_000 };
    const monitor = createTerminalStatusMonitor({ now: () => wall.t, monotonicNow: () => mono.t });
    monitor.observe(OK);
    return { monitor, wall, mono };
  }

  it('a backward wall-clock step cannot keep a stale online alive', () => {
    const { monitor, wall, mono } = twoClocks();
    wall.t -= 60 * 60_000;
    mono.t += 30_000;
    expect(monitor.snapshot().connection).toBe('checking');
  });

  it('a forward wall-clock step cannot expire a fresh online', () => {
    const { monitor, wall, mono } = twoClocks();
    wall.t += 60 * 60_000;
    mono.t += 1_000;
    expect(monitor.snapshot().connection).toBe('online');
  });

  it('the snapshot still reports wall-clock ISO times', () => {
    const { monitor } = twoClocks();
    expect(monitor.snapshot()).toMatchObject({
      connectionSince: '2026-10-17T12:00:00.000Z',
      lastContactAt: '2026-10-17T12:00:00.000Z',
    });
  });
});
