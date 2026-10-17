/**
 * RT-601 (VN-S6 S6-1a) — composition of the connection monitor for the main
 * process: one monitor, the passive feeder (`observeFetch`) for the Backend-Core
 * device and operator fetch paths, a tick timer for the time rules, and the
 * transition log (`{ from, to }` only, A4-8).
 *
 * Nothing reads the snapshot outside main yet: the bridge is S6-2, the active
 * probe and the resume / interface feeders are S6-1b.
 */
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

export interface ComposeTerminalStatusDeps {
  logger: { info(obj: Record<string, unknown>, msg: string): void };
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
  const monitor = createTerminalStatusMonitor({
    now: deps.now ?? Date.now,
    // An injected wall clock (tests) also drives durations unless a monotonic one is given.
    monotonicNow: deps.monotonicNow ?? deps.now ?? (() => performance.now()),
    onTransition: (transition) => {
      logTerminalStatusTransition(deps.logger, transition);
    },
  });
  const schedule = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel =
    deps.clearInterval ??
    ((handle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });
  let timer: TimerHandle | null = schedule(() => {
    monitor.tick();
  }, TERMINAL_STATUS_TICK_MS);
  timer.unref?.();

  return {
    monitor,
    observeFetch: (fetchImpl) =>
      withReachabilityObservation(fetchImpl, (observation) => {
        monitor.observe(observation);
      }),
    stop() {
      if (timer === null) return;
      cancel(timer);
      timer = null;
    },
  };
}
