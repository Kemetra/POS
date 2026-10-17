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

export type ConnectionStateCode = 'checking' | 'online' | 'degraded' | 'offline';

/** What a feeder saw on one request: an HTTP answer, or no answer at all. */
export type ReachabilityObservation =
  | { readonly kind: 'answer'; readonly status: number }
  | { readonly kind: 'transport_fault' };

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
  /** Epoch milliseconds. */
  now: () => number;
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

  let connection: ConnectionStateCode = 'checking';
  let since = deps.now();
  let lastContactAt: number | null = null;
  /** Last observation of any kind that counted as evidence. */
  let lastEvidenceAt: number | null = null;
  let badStreak = 0;
  /** Start of a running recovery hold (offline/degraded → online), else null. */
  let holdStartedAt: number | null = null;

  function moveTo(next: ConnectionStateCode, at: number): void {
    if (next === connection) return;
    const transition: ConnectionTransition = { from: connection, to: next };
    connection = next;
    since = at;
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
    badStreak = 0;
    if (!isBad()) {
      moveTo('online', at);
      return;
    }
    holdStartedAt ??= at;
    applyHold(at);
  }

  function onBad(next: BadState, at: number): void {
    holdStartedAt = null;
    badStreak += 1;
    if (isBad() || badStreak >= timing.badStreakToLeave) moveTo(next, at);
  }

  function applyHold(at: number): void {
    if (holdStartedAt === null || at - holdStartedAt < timing.recoveryHoldMs) return;
    holdStartedAt = null;
    moveTo('online', at);
  }

  function applyFreshness(at: number): void {
    // `online` must be backed by a recent ANSWER; a bad state by any recent evidence.
    const basis = connection === 'online' ? lastContactAt : lastEvidenceAt;
    if (connection === 'checking' || basis === null) return;
    if (at - basis < timing.freshnessWindowMs) return;
    badStreak = 0;
    holdStartedAt = null;
    moveTo('checking', at);
  }

  function tick(): void {
    const at = deps.now();
    applyHold(at);
    applyFreshness(at);
  }

  return {
    observe(observation) {
      const kind = classifyObservation(observation);
      if (kind === 'ignored') return;
      const at = deps.now();
      lastEvidenceAt = at;
      if (kind === 'reachable') onReachable(at);
      else onBad(kind === 'transport_fault' ? 'offline' : 'degraded', at);
    },

    observeInterface(up) {
      if (up) return;
      const at = deps.now();
      lastEvidenceAt = at;
      holdStartedAt = null;
      badStreak = Math.max(badStreak, timing.badStreakToLeave);
      moveTo('offline', at);
    },

    resume() {
      badStreak = 0;
      holdStartedAt = null;
      lastEvidenceAt = null;
      moveTo('checking', deps.now());
    },

    tick,

    snapshot() {
      tick();
      return {
        connection,
        connectionSince: new Date(since).toISOString(),
        lastContactAt: lastContactAt === null ? null : new Date(lastContactAt).toISOString(),
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
