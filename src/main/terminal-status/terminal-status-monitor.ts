/**
 * RT-601 (VN-S6 S6-1a, doc 24 §2.1–§2.5) — the main-process connection axis of
 * the terminal status signal.
 *
 * A pure state machine with an injected clock. It holds no timer and makes no
 * request: feeders report observations (`observe`), the network interface
 * (`observeInterface`) and a resume from sleep (`resume`), and the owner calls
 * `tick` to apply the time-based rules. `snapshot` applies them too, so a read
 * never returns a state that has already expired.
 *
 * States (§2.2): `checking` (no evidence), `online` (Backend-Core answered
 * within `W`), `degraded` (reachable but failing: 5xx / 429), `offline`
 * (transport faults, or the interface is down).
 *
 * What never counts as `online` (§2.4): the initial value (it starts at
 * `checking`), an interface-up report, the absence of failures (no qualifying
 * answer for `W` → `checking`) and an edge/server failure. A missing token or a
 * terminal change makes no request, so it never reaches the monitor at all.
 *
 * Timing (§2.5, D-6-3): `K` = 2 consecutive bad observations to become offline
 * or degraded; leaving offline/degraded needs a qualifying answer and then a
 * 5 s hold with no bad observation; `W` = 30 s.
 *
 * The snapshot carries closed-set codes and ISO timestamps only. A transition
 * is reported as `{ from, to }` and nothing else (A4-8, no PII).
 */
import { classifyObservation } from './reachability-observation.js';
import type { ConnectionStateCode } from '../../shared/terminal-status/types.js';

// RT-603: the code set now lives in the shared bridge contract.
export type { ConnectionStateCode };

/**
 * What a feeder saw on one request: an HTTP answer, no answer at all, or (the
 * RT-602 liveness probe only) an answer that is not Backend-Core's liveness
 * reply — an edge, proxy or portal answered in its place.
 */
export type ReachabilityObservation =
  | { readonly kind: 'answer'; readonly status: number }
  | { readonly kind: 'transport_fault' }
  | { readonly kind: 'not_backend_core' };

export interface ConnectionTransition {
  readonly from: ConnectionStateCode;
  readonly to: ConnectionStateCode;
}

export interface ConnectionSnapshot {
  readonly connection: ConnectionStateCode;
  /** When `connection` last changed (ISO 8601 UTC). */
  readonly connectionSince: string;
  /** Last qualifying Backend-Core answer (ISO 8601 UTC), or null if none since start. */
  readonly lastContactAt: string | null;
}

export interface TerminalStatusTiming {
  /** `K`: consecutive bad observations that leave `online` / `checking`. */
  readonly badStreakToLeave: number;
  /** How long a recovery must hold before offline/degraded → online. */
  readonly recoveryHoldMs: number;
  /** `W`: no evidence for this long → `checking`. */
  readonly freshnessWindowMs: number;
}

/** The approved §2.5 values (D-6-3); tuned after bench run B1. */
export const TERMINAL_STATUS_DEFAULTS: TerminalStatusTiming = {
  badStreakToLeave: 2,
  recoveryHoldMs: 5_000,
  freshnessWindowMs: 30_000,
};

export interface TerminalStatusMonitorDeps {
  /** Epoch milliseconds: the ISO timestamps in the snapshot only. */
  now: () => number;
  /**
   * Monotonic milliseconds for every duration (hold, `W`), so a wall-clock step
   * (NTP, a manual change) can neither keep a stale `online` alive nor expire a
   * fresh one. Defaults to `now` (tests drive both from one fake clock).
   */
  monotonicNow?: () => number;
  /** Called once per state change. A throwing listener never breaks the monitor. */
  onTransition?: (transition: ConnectionTransition) => void;
  timing?: Partial<TerminalStatusTiming>;
}

export interface TerminalStatusMonitor {
  observe(observation: ReachabilityObservation): void;
  /** `net.isOnline()`: false is a fast path to `offline`; true is never evidence. */
  observeInterface(up: boolean): void;
  /** Resume from sleep: nothing seen before it is current any more. */
  resume(): void;
  /** Apply the time-based rules (recovery hold, freshness window). */
  tick(): void;
  snapshot(): ConnectionSnapshot;
}

type BadState = 'offline' | 'degraded';

export function createTerminalStatusMonitor(
  deps: TerminalStatusMonitorDeps,
): TerminalStatusMonitor {
  const timing: TerminalStatusTiming = { ...TERMINAL_STATUS_DEFAULTS, ...deps.timing };

  const elapsedClock = deps.monotonicNow ?? deps.now;
  let connection: ConnectionStateCode = 'checking';
  /** Wall-clock times, reported only. */
  let sinceWall = deps.now();
  let lastContactWall: number | null = null;
  /** Monotonic times, used for every duration. */
  let lastContactAt: number | null = null;
  /** Last observation of any kind that counted as evidence. */
  let lastEvidenceAt: number | null = null;
  let badStreak = 0;
  /** Start of a running recovery hold (offline/degraded → online), else null. */
  let holdStartedAt: number | null = null;

  function moveTo(next: ConnectionStateCode): void {
    if (next === connection) return;
    const transition: ConnectionTransition = { from: connection, to: next };
    connection = next;
    sinceWall = deps.now();
    try {
      deps.onTransition?.(transition);
    } catch {
      // Reporting is best-effort; the state stays correct.
    }
  }

  function isBad(): boolean {
    return connection === 'offline' || connection === 'degraded';
  }

  function onReachable(at: number): void {
    lastContactAt = at;
    lastContactWall = deps.now();
    badStreak = 0;
    if (!isBad()) {
      moveTo('online');
      return;
    }
    holdStartedAt ??= at;
    applyHold(at);
  }

  function onBad(next: BadState): void {
    holdStartedAt = null;
    badStreak += 1;
    if (isBad() || badStreak >= timing.badStreakToLeave) moveTo(next);
  }

  function applyHold(at: number): void {
    if (holdStartedAt === null || at - holdStartedAt < timing.recoveryHoldMs) return;
    holdStartedAt = null;
    moveTo('online');
  }

  function applyFreshness(at: number): void {
    // `online` must be backed by a recent ANSWER; a bad state by any recent evidence.
    const basis = connection === 'online' ? lastContactAt : lastEvidenceAt;
    if (connection === 'checking' || basis === null) return;
    if (at - basis < timing.freshnessWindowMs) return;
    badStreak = 0;
    holdStartedAt = null;
    moveTo('checking');
  }

  function tick(): void {
    const at = elapsedClock();
    applyHold(at);
    applyFreshness(at);
  }

  return {
    observe(observation) {
      const kind = classifyObservation(observation);
      if (kind === 'ignored') return;
      const at = elapsedClock();
      lastEvidenceAt = at;
      if (kind === 'reachable') onReachable(at);
      else onBad(kind === 'transport_fault' ? 'offline' : 'degraded');
    },

    observeInterface(up) {
      if (up) return;
      lastEvidenceAt = elapsedClock();
      holdStartedAt = null;
      badStreak = Math.max(badStreak, timing.badStreakToLeave);
      moveTo('offline');
    },

    resume() {
      badStreak = 0;
      holdStartedAt = null;
      lastEvidenceAt = null;
      moveTo('checking');
    },

    tick,

    snapshot() {
      tick();
      return {
        connection,
        connectionSince: new Date(sinceWall).toISOString(),
        lastContactAt: lastContactWall === null ? null : new Date(lastContactWall).toISOString(),
      };
    },
  };
}

/** The closed-set transition log message (A4-8). */
export const TERMINAL_STATUS_TRANSITION_LOG = 'terminal_status:transition';

/**
 * Write one transition. The payload is built from an allowlist ({ from, to }),
 * never by spreading the event, so nothing else can reach the log line.
 */
export function logTerminalStatusTransition(
  logger: { info(obj: Record<string, unknown>, msg: string): void },
  transition: ConnectionTransition,
): void {
  logger.info({ from: transition.from, to: transition.to }, TERMINAL_STATUS_TRANSITION_LOG);
}
