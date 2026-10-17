/**
 * RT-601 (VN-S6 S6-1a) — composition of the connection monitor for the main
 * process: one monitor, the passive feeder (`observeFetch`) for the Backend-Core
 * device and operator fetch paths, a tick timer for the time rules, and the
 * transition log (`{ from, to }` only, A4-8).
 *
 * RT-602 (VN-S6 S6-1b) adds the active feeder when `probe` is given: the
 * liveness probe on the §2.5 cadence (it uses the UNOBSERVED fetch, so a probe
 * never counts as passive traffic), `powerMonitor` resume → `checking`, and the
 * `net.isOnline()` edge on each tick. `stop` ends all of it.
 *
 * Nothing reads the snapshot outside main yet: the bridge is S6-2.
 */
import { LIVENESS_PROBE_DEFAULTS, runLivenessProbe } from './liveness-probe.js';
import {
  createLivenessProbeScheduler,
  type LivenessProbeScheduler,
} from './liveness-probe-scheduler.js';
import { withReachabilityObservation } from './reachability-observation.js';
import {
  createTerminalStatusMonitor,
  logTerminalStatusTransition,
  type TerminalStatusMonitor,
} from './terminal-status-monitor.js';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** How often the time rules are applied; fine enough for the 5 s recovery hold. */
export const TERMINAL_STATUS_TICK_MS = 1_000;

interface TimerHandle {
  unref?: () => unknown;
}

type ResumeListener = () => void;

/** The active feeder's inputs (RT-602). */
export interface TerminalStatusProbeDeps {
  /** The Backend-Core API base URL; the probe GETs `{baseUrl}/api/v1/health/live`. */
  baseUrl: string;
  /** The raw fetch, NOT the observed one: the probe reports its own outcome. */
  fetch: FetchLike;
  /** `net.isOnline()`; read on each tick, fed to the monitor on a change. */
  isInterfaceOnline?: () => boolean;
  /** Electron `powerMonitor`: `resume` → `checking`. */
  powerMonitor?: {
    on(event: 'resume', listener: ResumeListener): unknown;
    removeListener(event: 'resume', listener: ResumeListener): unknown;
  };
}

export interface ComposeTerminalStatusDeps {
  logger: { info(obj: Record<string, unknown>, msg: string): void };
  /** The active feeder; without it the monitor has the passive feeder only. */
  probe?: TerminalStatusProbeDeps;
  now?: () => number;
  /** Monotonic clock for durations; defaults to `now` when injected, else `performance.now`. */
  monotonicNow?: () => number;
  setInterval?: (fn: () => void, ms: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}

export interface TerminalStatusComposition {
  monitor: TerminalStatusMonitor;
  /** Wrap a Backend-Core fetch so its transport outcomes feed the monitor. */
  observeFetch(fetchImpl: FetchLike): FetchLike;
  stop(): void;
}

export function composeTerminalStatus(deps: ComposeTerminalStatusDeps): TerminalStatusComposition {
  // An injected wall clock (tests) also drives durations unless a monotonic one is given.
  const monotonicNow = deps.monotonicNow ?? deps.now ?? (() => performance.now());
  const monitor = createTerminalStatusMonitor({
    now: deps.now ?? Date.now,
    monotonicNow,
    onTransition: (transition) => {
      logTerminalStatusTransition(deps.logger, transition);
    },
  });
  const active =
    deps.probe === undefined ? null : composeActiveFeeder(monitor, deps.probe, monotonicNow);
  const schedule = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel =
    deps.clearInterval ??
    ((handle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });
  let timer: TimerHandle | null = schedule(() => {
    active?.readInterface();
    monitor.tick();
    active?.scheduler.tick();
  }, TERMINAL_STATUS_TICK_MS);
  timer.unref?.();

  return {
    monitor,
    observeFetch: (fetchImpl) => {
      const observed = withReachabilityObservation(fetchImpl, (observation) => {
        active?.scheduler.notePassiveObservation();
        monitor.observe(observation);
      });
      return active === null ? observed : trackInFlight(observed, active.scheduler);
    },
    stop() {
      if (timer === null) return;
      cancel(timer);
      timer = null;
      active?.stop();
    },
  };
}

interface ActiveFeeder {
  scheduler: LivenessProbeScheduler;
  /** Feed a change of `net.isOnline()` to the monitor. */
  readInterface(): void;
  stop(): void;
}

function composeActiveFeeder(
  monitor: TerminalStatusMonitor,
  probe: TerminalStatusProbeDeps,
  monotonicNow: () => number,
): ActiveFeeder {
  const scheduler = createLivenessProbeScheduler({
    monitor,
    monotonicNow,
    runProbe: (signal) =>
      runLivenessProbe({
        fetch: probe.fetch,
        baseUrl: probe.baseUrl,
        timeoutMs: LIVENESS_PROBE_DEFAULTS.timeoutMs,
        signal,
      }),
  });
  const onResume: ResumeListener = () => {
    scheduler.resume();
  };
  probe.powerMonitor?.on('resume', onResume);
  let interfaceUp: boolean | null = null;

  return {
    scheduler,
    readInterface() {
      if (probe.isInterfaceOnline === undefined) return;
      let up: boolean;
      try {
        up = probe.isInterfaceOnline();
      } catch {
        return; // no reading is no evidence
      }
      if (up === interfaceUp) return;
      interfaceUp = up;
      scheduler.observeInterface(up);
    },
    stop() {
      probe.powerMonitor?.removeListener('resume', onResume);
      scheduler.stop();
    },
  };
}

/** Count a passive request as in flight until it settles: no probe meanwhile. */
function trackInFlight(fetchImpl: FetchLike, scheduler: LivenessProbeScheduler): FetchLike {
  return async (input, init) => {
    scheduler.passiveRequestStarted();
    try {
      return await fetchImpl(input, init);
    } finally {
      scheduler.passiveRequestEnded();
    }
  };
}
