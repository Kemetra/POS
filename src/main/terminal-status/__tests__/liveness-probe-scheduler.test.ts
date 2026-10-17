/**
 * RT-602 (VN-S6 S6-1b, doc 24 §2.3, §2.5, §5.1 "Monitor") — the active feeder's
 * cadence and the hysteresis it produces with the real `TerminalStatusMonitor`,
 * driven by one fake clock.
 *
 *  - The probe runs only when the passive feeder has seen no traffic for `P`
 *    (10 s), never while a passive request is in flight, and one at a time.
 *  - One bad probe never leaves `online`: a confirmation probe follows ~3 s
 *    later, and only the second bad result (K = 2) flips the state.
 *  - Worst case online → offline ≈ 10 + 4 + 3 + 4 = 21 s, inside 30 s.
 *  - Recovery: one alive probe, then a 5 s hold before `online`.
 *  - Resume from sleep → `checking` and an immediate probe.
 *  - Interface down → `offline` at once; interface up is never `online` and
 *    only brings the next probe forward.
 */
import { describe, expect, it } from 'vitest';

import { LIVENESS_PROBE_DEFAULTS } from '../liveness-probe.js';
import { createLivenessProbeScheduler } from '../liveness-probe-scheduler.js';
import {
  createTerminalStatusMonitor,
  type ConnectionTransition,
  type ReachabilityObservation,
} from '../terminal-status-monitor.js';

const T0 = Date.parse('2026-10-17T12:00:00.000Z');
const ALIVE: ReachabilityObservation = { kind: 'answer', status: 200 };
const FAULT: ReachabilityObservation = { kind: 'transport_fault' };
const EDGE_521: ReachabilityObservation = { kind: 'answer', status: 521 };

interface PendingProbe {
  at: number;
  signal: AbortSignal;
  settle: (result: ReachabilityObservation | null) => void;
}

/**
 * The real monitor and scheduler on one fake clock. Probes are held open until
 * the test settles them, so the timeout (a 4 s fault) is modelled explicitly.
 */
function harness() {
  const clock = { t: T0 };
  const transitions: ConnectionTransition[] = [];
  const monitor = createTerminalStatusMonitor({
    now: () => clock.t,
    onTransition: (t) => transitions.push(t),
  });
  const probes: PendingProbe[] = [];
  const scheduler = createLivenessProbeScheduler({
    monitor,
    monotonicNow: () => clock.t,
    runProbe: (signal) =>
      new Promise((resolve) => {
        probes.push({ at: clock.t, signal, settle: resolve });
      }),
  });

  /** Advance second by second, ticking the monitor and the scheduler like the 1 s worker. */
  async function advance(ms: number): Promise<void> {
    for (let step = 0; step < ms; step += 1_000) {
      clock.t += Math.min(1_000, ms - step);
      monitor.tick();
      scheduler.tick();
      await flush();
    }
  }

  /** Settle the newest open probe and let its result reach the monitor. */
  async function answer(result: ReachabilityObservation | null): Promise<void> {
    const open = probes.at(-1);
    if (open === undefined) throw new Error('no probe is open');
    open.settle(result);
    await flush();
  }

  const state = () => monitor.snapshot().connection;
  const probeTimes = () => probes.map((p) => (p.at - T0) / 1_000);
  return { clock, monitor, scheduler, probes, transitions, advance, answer, state, probeTimes };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** Start, answer the first probe alive and clear the records: idle and `online`. */
async function idleOnline() {
  const h = harness();
  h.scheduler.tick();
  await h.answer(ALIVE);
  expect(h.state()).toBe('online');
  h.transitions.length = 0;
  return h;
}

describe('RT-602 probe scheduler — when it probes', () => {
  it('probes at once on start, then every P while idle', async () => {
    const h = await idleOnline();
    await h.advance(9_000);
    expect(h.probes).toHaveLength(1);
    await h.advance(1_000);
    expect(h.probeTimes()).toEqual([0, 10]);
    await h.answer(ALIVE);
    await h.advance(10_000);
    expect(h.probeTimes()).toEqual([0, 10, 20]);
  });

  it('runs one probe at a time', async () => {
    const h = harness();
    h.scheduler.tick();
    await h.advance(20_000);
    expect(h.probes).toHaveLength(1);
  });

  it('does not probe while passive traffic keeps arriving within P', async () => {
    const h = await idleOnline();
    for (let i = 0; i < 6; i += 1) {
      await h.advance(5_000);
      h.scheduler.notePassiveObservation();
    }
    expect(h.probes).toHaveLength(1);
    await h.advance(10_000);
    expect(h.probes).toHaveLength(2);
  });

  it('never probes while a passive request is in flight', async () => {
    const h = await idleOnline();
    h.scheduler.passiveRequestStarted();
    await h.advance(30_000);
    expect(h.probes).toHaveLength(1);
    h.scheduler.passiveRequestEnded();
    await h.advance(1_000);
    expect(h.probes).toHaveLength(2);
  });

  it('keeps probing every P while offline, so it can recover', async () => {
    const h = harness();
    h.scheduler.tick();
    await h.answer(FAULT);
    await h.advance(3_000);
    await h.answer(FAULT);
    expect(h.state()).toBe('offline');
    await h.advance(10_000);
    expect(h.probeTimes()).toEqual([0, 3, 13]);
  });
});

describe('RT-602 probe scheduler — hysteresis (§2.5)', () => {
  it('one lost probe never leaves online; a good confirmation keeps it', async () => {
    const h = await idleOnline();
    await h.advance(10_000);
    await h.advance(4_000);
    await h.answer(FAULT);
    expect(h.state()).toBe('online');
    await h.advance(3_000);
    expect(h.probeTimes()).toEqual([0, 10, 17]);
    await h.answer(ALIVE);
    expect(h.state()).toBe('online');
    expect(h.transitions).toEqual([]);
  });

  it('a lost link flips online → offline inside 30 s (K = 2, worst case ≈ 21 s)', async () => {
    const h = await idleOnline();
    await h.advance(10_000); // probe at 10 s
    await h.advance(4_000); // its 4 s timeout
    await h.answer(FAULT);
    await h.advance(3_000); // confirmation at 17 s
    expect(h.state()).toBe('online');
    await h.advance(4_000); // its 4 s timeout
    await h.answer(FAULT);
    expect(h.state()).toBe('offline');
    expect(h.clock.t - T0).toBe(21_000);
    expect(h.transitions).toEqual([{ from: 'online', to: 'offline' }]);
  });

  it('an edge failure confirmed twice is degraded, not offline', async () => {
    const h = await idleOnline();
    await h.advance(10_000);
    await h.answer(EDGE_521);
    await h.advance(3_000);
    await h.answer({ kind: 'not_backend_core' });
    expect(h.state()).toBe('degraded');
  });

  it('recovery: one alive probe, then a 5 s hold before online', async () => {
    const h = harness();
    h.scheduler.tick();
    await h.answer(FAULT);
    await h.advance(3_000);
    await h.answer(FAULT);
    expect(h.state()).toBe('offline');
    h.transitions.length = 0;

    await h.advance(10_000);
    await h.answer(ALIVE);
    await h.advance(4_000);
    expect(h.state()).toBe('offline');
    await h.advance(1_000);
    expect(h.state()).toBe('online');
    expect(h.transitions).toEqual([{ from: 'offline', to: 'online' }]);
  });

  it('a bad probe during the hold restarts the recovery', async () => {
    const h = harness();
    h.scheduler.tick();
    await h.answer(FAULT);
    await h.advance(3_000);
    await h.answer(FAULT);
    await h.advance(10_000);
    await h.answer(ALIVE);
    h.scheduler.notePassiveObservation();
    h.monitor.observe(FAULT);
    await h.advance(5_000);
    expect(h.state()).toBe('offline');
  });

  it('an idle-online terminal stays online on probes alone, past W', async () => {
    const h = await idleOnline();
    for (let i = 0; i < 6; i += 1) {
      await h.advance(10_000);
      await h.answer(ALIVE);
    }
    expect(h.state()).toBe('online');
    expect(h.transitions).toEqual([]);
  });

  it('a probe that never settles ages online to checking after W', async () => {
    const h = await idleOnline();
    await h.advance(30_000);
    expect(h.state()).toBe('checking');
  });
});

describe('RT-602 probe scheduler — resume and interface', () => {
  it('resume → checking and an immediate probe', async () => {
    const h = await idleOnline();
    await h.advance(3_000);
    h.scheduler.resume();
    expect(h.state()).toBe('checking');
    h.scheduler.tick();
    expect(h.probeTimes()).toEqual([0, 3]);
    await h.answer(ALIVE);
    expect(h.state()).toBe('online');
  });

  it('resume drops a probe that started before the sleep', async () => {
    const h = await idleOnline();
    await h.advance(10_000);
    const stale = h.probes[1];
    h.scheduler.resume();
    expect(stale?.signal.aborted).toBe(true);
    stale?.settle(ALIVE);
    await flush();
    expect(h.state()).toBe('checking');
  });

  it('interface down → offline at once', async () => {
    const h = await idleOnline();
    h.scheduler.observeInterface(false);
    expect(h.state()).toBe('offline');
  });

  it('interface up is never online; it only brings the next probe forward', async () => {
    const h = harness();
    h.scheduler.tick();
    await h.answer(FAULT);
    await h.advance(3_000);
    await h.answer(FAULT);
    h.scheduler.observeInterface(false);
    await h.advance(2_000);
    h.scheduler.observeInterface(true);
    expect(h.state()).toBe('offline');
    h.scheduler.tick();
    expect(h.probeTimes()).toEqual([0, 3, 5]);
  });
});

describe('RT-602 probe scheduler — stop', () => {
  it('aborts the open probe, ignores its result and never probes again', async () => {
    const h = await idleOnline();
    await h.advance(10_000);
    const open = h.probes[1];
    h.scheduler.stop();
    expect(open?.signal.aborted).toBe(true);
    open?.settle(FAULT);
    await flush();
    await h.advance(60_000);
    expect(h.probes).toHaveLength(2);
  });

  it('a throwing probe runner is no evidence and does not stop the cadence', async () => {
    const clock = { t: T0 };
    const monitor = createTerminalStatusMonitor({ now: () => clock.t });
    let calls = 0;
    const scheduler = createLivenessProbeScheduler({
      monitor,
      monotonicNow: () => clock.t,
      runProbe: () => {
        calls += 1;
        return Promise.reject(new Error('boom'));
      },
    });
    scheduler.tick();
    await flush();
    expect(monitor.snapshot().connection).toBe('checking');
    clock.t += LIVENESS_PROBE_DEFAULTS.intervalMs;
    scheduler.tick();
    await flush();
    expect(calls).toBe(2);
  });

  it('a probe runner that throws synchronously is no evidence either', async () => {
    const clock = { t: T0 };
    const monitor = createTerminalStatusMonitor({ now: () => clock.t });
    let calls = 0;
    const scheduler = createLivenessProbeScheduler({
      monitor,
      monotonicNow: () => clock.t,
      runProbe: () => {
        calls += 1;
        throw new Error('boom');
      },
    });
    scheduler.tick();
    expect(calls).toBe(1);
    await flush();
    expect(monitor.snapshot().connection).toBe('checking');
    clock.t += LIVENESS_PROBE_DEFAULTS.intervalMs;
    scheduler.tick();
    expect(calls).toBe(2);
  });
});
