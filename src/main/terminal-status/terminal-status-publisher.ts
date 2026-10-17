/**
 * RT-603 (VN-S6 S6-2, doc 24 §3) — the main-side source of the terminal status
 * bridge: `read()` answers `terminalStatus:get`, and a 1 s refresh pushes
 * `terminalStatus:changed` through `send`.
 *
 * The snapshot is built field by field from an allowlist (A4-3): the monitor's
 * connection axis (RT-601/602) and the sync aggregate (RT-601). Nothing else a
 * source carries can reach it.
 *
 * Device gate (§2.1, A4-5): while the terminal is unpaired or its device is
 * revoked, the connection is `checking` — never `offline` for a revoked device,
 * never `online`. Until the paired sale-sync starter binds a sync reader, the
 * sync axis is empty (zero counts, null times).
 *
 * Rate (A4-7): a push only when the snapshot changed, and never two within
 * 1 s. `read()` reuses a sync aggregate up to 1 s old; the background refresh
 * reads it every 5 s, or at once when the connection code changed. The
 * connection axis is in memory and always current.
 *
 * Logging (A4-8): one closed-set warning per run of sync read failures, with
 * no detail; the last known sync axis is kept meanwhile.
 */
import type { TerminalSyncAggregate } from './sync-aggregate.js';
import type { ConnectionSnapshot } from './terminal-status-monitor.js';
import type {
  ConnectionStateCode,
  TerminalStatusSnapshot,
  TerminalStatusSync,
} from '../../shared/terminal-status/types.js';

/** Minimum spacing between two `terminalStatus:changed` pushes. */
export const TERMINAL_STATUS_PUSH_MIN_INTERVAL_MS = 1_000;
/** How old a sync aggregate `read()` may reuse. */
export const TERMINAL_STATUS_GET_CACHE_MS = 1_000;
/** How often the background refresh re-reads the sync aggregate. */
export const TERMINAL_STATUS_SYNC_POLL_MS = 5_000;
/** The background refresh cadence. */
export const TERMINAL_STATUS_REFRESH_MS = 1_000;

export const TERMINAL_STATUS_SYNC_READ_FAILED_LOG = 'terminal_status:sync_read_failed';

const EMPTY_SYNC: TerminalStatusSync = {
  pending: 0,
  heldPreviousPairing: 0,
  deadLetter: 0,
  oldestPendingAt: null,
  paused: null,
  lastSuccessAt: null,
};

type SyncReader = () => Promise<TerminalSyncAggregate>;

interface TimerHandle {
  unref?: () => unknown;
}

export interface TerminalStatusPublisherDeps {
  /** The monitor's snapshot (it applies the time rules on read). */
  readConnection: () => ConnectionSnapshot;
  /** True while unpaired or revoked: the connection reads `checking`. */
  isDeviceGated: () => boolean;
  /** Push to the app windows. A throw is swallowed. */
  send: (snapshot: TerminalStatusSnapshot) => void;
  /** Epoch milliseconds, for the gate's `connectionSince` only. */
  now: () => number;
  /** Monotonic milliseconds, for every spacing and cache age. */
  monotonicNow: () => number;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
  setInterval?: (fn: () => void, ms: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}

export interface TerminalStatusPublisher {
  /** The `terminalStatus:get` answer. */
  read(): Promise<TerminalStatusSnapshot>;
  /** Bound by the paired sale-sync starter; null returns to the empty axis. Ignored after `stop`. */
  setSyncReader(reader: SyncReader | null): void;
  /** One background step: push the snapshot if it changed and the spacing allows. */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

function toSync(aggregate: TerminalSyncAggregate): TerminalStatusSync {
  return {
    pending: aggregate.pending,
    heldPreviousPairing: aggregate.heldPreviousPairing,
    deadLetter: aggregate.deadLetter,
    oldestPendingAt: aggregate.oldestPendingAt,
    paused: aggregate.paused,
    lastSuccessAt: aggregate.lastSuccessAt,
  };
}

interface ConnectionAxis {
  readonly connection: ConnectionStateCode;
  readonly connectionSince: string;
  readonly lastContactAt: string | null;
}

function buildSnapshot(axis: ConnectionAxis, sync: TerminalStatusSync): TerminalStatusSnapshot {
  return {
    v: 1,
    connection: axis.connection,
    connectionSince: axis.connectionSince,
    lastContactAt: axis.lastContactAt,
    sync: toSync(sync),
  };
}

/** The sync axis with its reader, a short-lived cache and failure tracking. */
function createSyncSource(
  monotonicNow: () => number,
  logger: TerminalStatusPublisherDeps['logger'],
) {
  let reader: SyncReader | null = null;
  let cached: { value: TerminalStatusSync; at: number } | null = null;
  let inFlight: Promise<TerminalStatusSync> | null = null;
  let failing = false;

  async function load(current: SyncReader): Promise<TerminalStatusSync> {
    let value: TerminalStatusSync;
    try {
      value = toSync(await current());
      failing = false;
    } catch {
      if (!failing) logger.warn({}, TERMINAL_STATUS_SYNC_READ_FAILED_LOG);
      failing = true;
      value = cached?.value ?? EMPTY_SYNC;
    }
    // A reader swapped meanwhile owns the cache now.
    if (reader === current) cached = { value, at: monotonicNow() };
    return value;
  }

  return {
    set(next: SyncReader | null): void {
      reader = next;
      cached = null;
      inFlight = null;
    },
    get(maxAgeMs: number): Promise<TerminalStatusSync> {
      const current = reader;
      if (current === null) return Promise.resolve(EMPTY_SYNC);
      if (cached !== null && monotonicNow() - cached.at < maxAgeMs) {
        return Promise.resolve(cached.value);
      }
      if (inFlight !== null) return inFlight;
      const pending = load(current).finally(() => {
        if (inFlight === pending) inFlight = null;
      });
      inFlight = pending;
      return pending;
    },
  };
}

export function createTerminalStatusPublisher(
  deps: TerminalStatusPublisherDeps,
): TerminalStatusPublisher {
  const sync = createSyncSource(deps.monotonicNow, deps.logger);
  const schedule = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel =
    deps.clearInterval ??
    ((handle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });

  let gated: boolean | null = null;
  /** Wall time the gate last closed or opened: `connectionSince` is never earlier. */
  let gateChangedAt: number | null = null;
  let lastKey: string | null = null;
  let lastConnection: ConnectionStateCode | null = null;
  let lastPushAt: number | null = null;
  let refreshing = false;
  let stopped = false;
  let timer: TimerHandle | null = null;

  /** A failing read keeps the last known gate, else fails closed to `checking`. */
  function readGate(): boolean {
    try {
      return deps.isDeviceGated();
    } catch {
      return gated ?? true;
    }
  }

  function connectionAxis(): ConnectionAxis {
    const nowGated = readGate();
    // A first reading counts as a change only when it is gated.
    if (gated === null ? nowGated : nowGated !== gated) gateChangedAt = deps.now();
    gated = nowGated;
    const monitor = deps.readConnection();
    if (nowGated) {
      return {
        connection: 'checking',
        connectionSince: new Date(gateChangedAt ?? deps.now()).toISOString(),
        lastContactAt: monitor.lastContactAt,
      };
    }
    const connectionSince =
      gateChangedAt === null
        ? monitor.connectionSince
        : new Date(Math.max(Date.parse(monitor.connectionSince), gateChangedAt)).toISOString();
    return {
      connection: monitor.connection,
      connectionSince,
      lastContactAt: monitor.lastContactAt,
    };
  }

  function pushIfDue(snapshot: TerminalStatusSnapshot): void {
    // Re-checked here: `stop` may have run while the sync read was awaited.
    if (stopped) return;
    const key = JSON.stringify(snapshot);
    if (key === lastKey) return;
    const at = deps.monotonicNow();
    if (lastPushAt !== null && at - lastPushAt < TERMINAL_STATUS_PUSH_MIN_INTERVAL_MS) return;
    lastKey = key;
    lastPushAt = at;
    try {
      deps.send(snapshot);
    } catch {
      // A closing window must not stop the publisher.
    }
  }

  async function refresh(): Promise<void> {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const axis = connectionAxis();
      const changed = axis.connection !== lastConnection;
      lastConnection = axis.connection;
      const syncAxis = await sync.get(changed ? 0 : TERMINAL_STATUS_SYNC_POLL_MS);
      pushIfDue(buildSnapshot(axis, syncAxis));
    } finally {
      refreshing = false;
    }
  }

  return {
    async read() {
      const axis = connectionAxis();
      return buildSnapshot(axis, await sync.get(TERMINAL_STATUS_GET_CACHE_MS));
    },
    setSyncReader(reader) {
      if (!stopped) sync.set(reader);
    },
    refresh,
    start() {
      if (timer !== null || stopped) return;
      timer = schedule(() => {
        // A failed step is retried on the next tick; never an unhandled rejection.
        refresh().catch(() => undefined);
      }, TERMINAL_STATUS_REFRESH_MS);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      // Runs before the DB closes: a late `read()` gets the empty axis, not the DB.
      sync.set(null);
      if (timer === null) return;
      cancel(timer);
      timer = null;
    },
  };
}
