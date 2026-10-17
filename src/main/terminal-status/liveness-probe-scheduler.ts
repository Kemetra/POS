/**
 * RT-602 (VN-S6 S6-1b, doc 24 §2.3, §2.5) — the active feeder's cadence.
 *
 * It decides WHEN the liveness probe runs and feeds each result to the
 * `TerminalStatusMonitor`; the monitor alone decides the state (K = 2, the 5 s
 * hold, `W`). It holds no timer: the owner calls `tick` (the 1 s worker).
 *
 *  - The probe runs only when the passive feeder has seen no traffic for `P`
 *    (10 s), never while a passive request is in flight (a sale-sync drain
 *    included), and one at a time. The first probe runs at once.
 *  - After a bad result that has not yet moved the monitor to offline/degraded,
 *    a confirmation probe follows after 3 s instead of `P`, so a lost link flips
 *    within ≈ 10 + 4 + 3 + 4 = 21 s, while one lost probe never does.
 *  - `resume` (from sleep): the monitor goes to `checking`, an open probe is
 *    aborted and its result dropped, and the next probe is due at once.
 *  - `observeInterface`: down is the monitor's fast path to `offline`; up is
 *    never evidence, it only brings the next probe forward.
 *  - `stop` (quit): the open probe is aborted and no probe runs again.
 */
import { classifyObservation } from './reachability-observation.js';
import { LIVENESS_PROBE_DEFAULTS, type LivenessProbeTiming } from './liveness-probe.js';
import type { ReachabilityObservation, TerminalStatusMonitor } from './terminal-status-monitor.js';

export interface LivenessProbeSchedulerDeps {
  monitor: Pick<TerminalStatusMonitor, 'observe' | 'observeInterface' | 'resume' | 'snapshot'>;
  /** Run one probe; `null` means no evidence (aborted). */
  runProbe: (signal: AbortSignal) => Promise<ReachabilityObservation | null>;
  /** Monotonic milliseconds. */
  monotonicNow: () => number;
  timing?: Partial<LivenessProbeTiming>;
}

export interface LivenessProbeScheduler {
  /** Start a probe if one is due. */
  tick(): void;
  /** The passive feeder saw an outcome: the link is not idle. */
  notePassiveObservation(): void;
  passiveRequestStarted(): void;
  passiveRequestEnded(): void;
  /** `powerMonitor` resume. */
  resume(): void;
  /** `net.isOnline()` changed. */
  observeInterface(up: boolean): void;
  stop(): void;
}

export function createLivenessProbeScheduler(
  deps: LivenessProbeSchedulerDeps,
): LivenessProbeScheduler {
  const timing: LivenessProbeTiming = { ...LIVENESS_PROBE_DEFAULTS, ...deps.timing };
  const now = deps.monotonicNow;
  let nextProbeAt = now();
  let open: AbortController | null = null;
  let passiveInFlight = 0;
  let stopped = false;

  function abortOpen(): void {
    open?.abort();
    open = null;
  }

  function nextDelay(result: ReachabilityObservation): number {
    deps.monitor.observe(result);
    if (classifyObservation(result) === 'reachable') return timing.intervalMs;
    const state = deps.monitor.snapshot().connection;
    const confirmed = state === 'offline' || state === 'degraded';
    return confirmed ? timing.intervalMs : timing.confirmDelayMs;
  }

  function settle(controller: AbortController, result: ReachabilityObservation | null): void {
    if (open !== controller) return; // aborted (resume / stop): drop it
    open = null;
    const delay = result === null ? timing.intervalMs : nextDelay(result);
    nextProbeAt = now() + delay;
  }

  /** Not stopped, no probe open, no passive request in flight, and the time has come. */
  function isDue(): boolean {
    if (stopped) return false;
    if (open !== null) return false;
    if (passiveInFlight > 0) return false;
    return now() >= nextProbeAt;
  }

  function start(): void {
    const controller = new AbortController();
    open = controller;
    // The executor runs synchronously, so the probe starts now; a synchronous
    // throw becomes a rejection, handled below like a failed probe.
    const pending = new Promise<ReachabilityObservation | null>((resolve) => {
      resolve(deps.runProbe(controller.signal));
    });
    pending.then(
      (result) => {
        settle(controller, result);
      },
      () => {
        settle(controller, null);
      },
    );
  }

  return {
    tick() {
      if (isDue()) start();
    },

    notePassiveObservation() {
      nextProbeAt = Math.max(nextProbeAt, now() + timing.intervalMs);
    },

    passiveRequestStarted() {
      passiveInFlight += 1;
    },

    passiveRequestEnded() {
      passiveInFlight = Math.max(0, passiveInFlight - 1);
    },

    resume() {
      abortOpen();
      deps.monitor.resume();
      nextProbeAt = now();
    },

    observeInterface(up) {
      deps.monitor.observeInterface(up);
      if (up) nextProbeAt = Math.min(nextProbeAt, now());
    },

    stop() {
      stopped = true;
      abortOpen();
    },
  };
}
