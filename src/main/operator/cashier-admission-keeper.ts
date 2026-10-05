import type { Logger } from 'pino';

import { DEVICE_401_CONFIRM_MS } from '../pairing/device-auth-detector.js';

import type {
  CashierAdmissionAdmitted,
  CashierAdmissionResult,
} from './cashier-admission-client.js';
import {
  endAdmissionTracked,
  monotonicNowMs,
  takeUncertainEnd,
  nextIdempotencyKey,
  notifyGrantSeam,
  type CashierAdmissionDeps,
} from './cashier-admission.js';
import type {
  AuthorityLatchCause,
  OperatorSessionRecord,
  SessionManager,
} from './session-manager.js';

/**
 * RT-113 P2 — keeps an online cashier admission live, and ends it.
 *
 * Contract (`posCreateCashierAdmission`, Heartbeat): an online-confirmed
 * session MUST re-call the admission with `mode: online`, `takeover: false`
 * and a FRESH `idempotency_key` at an interval of at most half of
 * `admission_ttl_seconds` from the latest `admitted` response.
 *
 * The keeper observes the SessionManager:
 *  - a session that starts with an online admission is armed: the first
 *    heartbeat fires TTL/2 after sign-in, each next one TTL/2 after the latest
 *    answer, and never later than half the time left before the admission's
 *    DEADLINE (below). It is a `setTimeout` chain scheduled only AFTER the
 *    answer, so requests never overlap. The interval is capped at 2^31-1 ms
 *    (review F5);
 *  - any session end disarms it and fires a best-effort, fire-and-forget
 *    `end` for its admission, never blocking sign-out. A replacing session
 *    that holds the SAME admission_id does not end it (review F4);
 *  - `stop()` is the shutdown latch (RT-198 pattern): it clears every timer,
 *    and nothing runs afterwards, even when an in-flight request settles.
 *
 * Losing authority (Codex P1 #1, review F1/F2/F3): `active_elsewhere` and a
 * 403 LATCH the session (`SessionManager.latchAuthority`). A confirmed device
 * revocation latches it too, through {@link CashierAdmissionKeeper.latchCurrentSession}:
 * since RT-215 the keeper no longer counts device 401s itself — the shared
 * device-401 detector (`pairing/device-auth-detector.ts`) sees every
 * device-bearer answer, the heartbeat's included, and decides. While
 * latched no new sale may start (`cart.create`, and adding a line to an empty
 * cart, refuse `authority_conflict`) and the heartbeat stops. The session ends with its own cause
 * (`superseded_by_takeover` / `account_disabled_mid_session` /
 * `terminal_session_terminated`) at its FIRST safe point (no open sale with
 * lines and no live tender). The safe point is checked at once, after EVERY
 * sale IPC call (`recheckSafePoint`, wired at the `sale-boundary-guard.ts`
 * choke point), on every lock-state change, and every
 * {@link SAFE_POINT_RECHECK_MS} as a backstop. Nothing is
 * reversed or discarded. A 403 invalidates the P1 grant at once (D4); a
 * confirmed revocation invalidates every grant through the same seam (RT-215).
 *
 * The deadline (Codex P2 4179771036): the server admission lapses at most TTL
 * after the request that got the latest `admitted` was SENT (monotonic clock;
 * sign-in and takeover stamp it on the session, the keeper on each renewal).
 * Every next call, renewal or retry, is scheduled by {@link nextCallDelayMs}:
 * at most half the time left, never sooner than {@link MIN_RETRY_MS}, so
 * several attempts land before the deadline and none after it. Once too little
 * time is left (≤ MIN_RETRY_MS) the admission is treated as LAPSED: the
 * session stays (P2 keeps today's behaviour; offline authority is P1/P3) and
 * retries at the plain cadence below until a renewal sets a new deadline.
 *
 * Other outcomes: `admitted` renews (a re-issued id is adopted and logged);
 * network, 5xx and 429 retry after min(TTL/2, 60 s), backing off
 * exponentially up to TTL/2 (review F6); 400, 409 and `no_token` keep the
 * normal cadence; a device 401 is retried after min(30 s, TTL/2) (F3), so a
 * transient one renews the admission before it lapses. Each of
 * these is ALSO capped by the deadline. A late `admitted` for a session that
 * is gone ends that admission unless the live session holds it (review F7).
 *
 * Logs carry the outcome kind only: no admission id, user id, key or name.
 */

/** How often a latched session re-checks for its next safe point (backstop). */
export const SAFE_POINT_RECHECK_MS = 5_000;
/**
 * Review F3: the retry after a device 401 (at most TTL/2, Codex P2 4179701427).
 * RT-215: the same constant as the shared detector's confirmation delay.
 */
export { DEVICE_401_CONFIRM_MS };
/** Review F6: the first retry after a failed tick (network, 5xx, 429). */
export const FAILED_TICK_RETRY_MS = 60_000;

/**
 * Codex P2 4179771036 — the shortest wait before a retry. Half the smallest
 * legal heartbeat interval (TTL 1 s → 500 ms), so even a 1 s admission gets a
 * retry inside its window; it only applies in the last 500 ms before the
 * deadline, so it adds at most one call there and can never form a tight loop
 * (at or below it, the admission counts as lapsed).
 */
export const MIN_RETRY_MS = 250;

/**
 * Codex P1 4180025698 — after an `end` with an unknown outcome (aborted or
 * timed out; the server may still apply it), the user's next session sends
 * its first heartbeat this soon instead of TTL/2, to verify that the admission
 * is still live.
 */
export const EARLY_VERIFY_MS = 5_000;

/** The largest delay `setTimeout` honours (a larger one fires at once). */
const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * The heartbeat interval: half the TTL in ms, capped at the setTimeout maximum
 * (review F5). No floor beyond the contract's own (Codex P2 4179617259): the
 * client rejects a TTL below 1 s or a non-integer, so this is at least 500 ms.
 */
export function heartbeatIntervalMs(ttlSeconds: number): number {
  return Math.min(MAX_INTERVAL_MS, Math.floor((ttlSeconds * 1000) / 2));
}

/** Failed ticks that retry sooner (review F6). */
const BACKOFF_KINDS: ReadonlySet<CashierAdmissionResult['kind']> = new Set([
  'no_connection',
  'unavailable',
  'rate_limited',
]);

export interface CashierAdmissionKeeperDeps {
  sessionManager: SessionManager;
  admission: CashierAdmissionDeps;
  /**
   * True when ending the session now preserves everything: no open sale with
   * lines and no live tender. Production wires the RT-117 lock-state summary.
   */
  isAtSafePoint: () => boolean;
  safePointRecheckMs?: number;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

/**
 * Codex P2 4179771036 — when the server admission lapses at the latest: the
 * SEND time (monotonic ms) of the request that got the latest `admitted`, plus
 * its TTL.
 */
export interface AdmissionDeadline {
  requested_at_ms: number;
  ttl_ms: number;
}

/** An admission to end, and the user whose re-admission must wait for it. */
interface AdmissionToEnd {
  admission_id: string;
  user_id: string | undefined;
}

/** A session the keeper may end at its safe point. */
interface Tracked {
  session_id: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Armed extends Tracked {
  user_id: string;
  operator_id: string;
  admission_id: string;
  ttl_seconds: number;
  deadline: AdmissionDeadline;
  /** When the in-flight (or last) heartbeat was sent; heartbeats never overlap. */
  last_sent_at_ms: number;
  latched: boolean;
  /** Consecutive failed ticks (backoff). */
  failures: number;
}

/** True when the record holds a live online cashier admission to keep alive. */
function isOnlineAdmitted(
  record: OperatorSessionRecord,
): record is OperatorSessionRecord &
  Required<Pick<OperatorSessionRecord, 'user_id' | 'admission_id' | 'admission_ttl_seconds'>> {
  const fieldsPresent = [record.admission_id, record.user_id, record.admission_ttl_seconds].every(
    (f) => f !== undefined,
  );
  return record.authority === 'online_confirmed' && fieldsPresent;
}

/**
 * The heartbeat state for a session, or null when it holds no online admission.
 * The first deadline runs from when the sign-in/takeover admission was SENT;
 * without that stamp, from now (`clock`).
 */
function armedFor(record: OperatorSessionRecord, clock: () => number): Armed | null {
  if (!isOnlineAdmitted(record)) return null;
  const sentAt = record.admission_requested_at_ms ?? clock();
  return {
    session_id: record.id,
    user_id: record.user_id,
    operator_id: record.operator_id,
    admission_id: record.admission_id,
    ttl_seconds: record.admission_ttl_seconds,
    deadline: { requested_at_ms: sentAt, ttl_ms: record.admission_ttl_seconds * 1000 },
    last_sent_at_ms: sentAt,
    timer: null,
    latched: false,
    failures: 0,
  };
}

/** Review F3 + Codex P2 4179701427: the retry after a 401, min(30 s, TTL/2), before the deadline. */
function deviceConfirmCapMs(armed: Armed): number {
  return Math.min(DEVICE_401_CONFIRM_MS, heartbeatIntervalMs(armed.ttl_seconds));
}

/** Review F6: min(TTL/2, 60 s), doubling per consecutive failure, capped at TTL/2. */
function backoffCapMs(armed: Armed): number {
  const interval = heartbeatIntervalMs(armed.ttl_seconds);
  const backoff = FAILED_TICK_RETRY_MS * 2 ** Math.min(armed.failures - 1, 20);
  return Math.min(interval, backoff);
}

/**
 * Codex P2 4179771036 — the delay before the next admission call. `capMs` is
 * that outcome's own cadence (TTL/2, the F6 backoff, the F3 confirmation); the
 * deadline caps it at half the time left, floored at {@link MIN_RETRY_MS}, so
 * the call always lands strictly before the deadline.
 *
 * LAPSED (explicit): with MIN_RETRY_MS or less left, no call can land before
 * the deadline. P2 keeps today's behaviour: the session stays and the plain
 * `capMs` applies until a renewal sets a new deadline (offline authority is
 * P1/P3).
 */
export function nextCallDelayMs(capMs: number, deadline: AdmissionDeadline, nowMs: number): number {
  const leftMs = deadline.requested_at_ms + deadline.ttl_ms - nowMs;
  if (leftMs <= MIN_RETRY_MS) return capMs; // lapsed
  return Math.min(capMs, Math.max(MIN_RETRY_MS, Math.floor(leftMs / 2)));
}

export class CashierAdmissionKeeper {
  private armed: Armed | null = null;
  /**
   * RT-215 — a latched session WITHOUT an online admission (a manager, or a
   * cashier whose admission is not armed): only its safe-point wait.
   */
  private latchOnly: Tracked | null = null;
  private stopped = false;

  constructor(private readonly deps: CashierAdmissionKeeperDeps) {
    deps.sessionManager.onStarted((record) => {
      this.onSessionStarted(record);
    });
    deps.sessionManager.onEnded((record) => {
      this.onSessionEnded(record);
    });
    deps.sessionManager.onLockStateChanged(() => {
      this.recheckSafePoint();
    });
  }

  /** Shutdown latch: idempotent; clears every timer; nothing runs afterwards. */
  stop(): void {
    this.stopped = true;
    this.disarm();
    this.releaseLatchOnly();
  }

  /**
   * A sale boundary happened (sale settled, voided or cancelled, or a new sale
   * was refused): end a latched session now if it is at its safe point.
   */
  recheckSafePoint(): void {
    const armed = this.armed;
    if (armed !== null && armed.latched) this.endAtSafePoint(armed);
    if (this.latchOnly !== null) this.endAtSafePoint(this.latchOnly);
  }

  /**
   * RT-215 — the device was confirmed revoked: latch the CURRENT session at
   * once (no new sale may start) and end it with `cause` at its first safe
   * point (no open sale with lines, no live tender), with the same machinery
   * as a lost admission. Works for any session, with or without an online
   * cashier admission. A session already latched keeps its own cause. No-op
   * without a session or after {@link stop}. Nothing is reversed or discarded.
   */
  latchCurrentSession(cause: AuthorityLatchCause): void {
    if (this.stopped) return;
    const current = this.deps.sessionManager.getCurrent();
    if (current === null) return;
    const armed = this.armed;
    if (armed !== null && armed.session_id === current.id) {
      if (!armed.latched) this.latch(armed, cause);
      return;
    }
    if (this.latchOnly?.session_id === current.id) return;
    this.releaseLatchOnly();
    const tracked: Tracked = { session_id: current.id, timer: null };
    this.latchOnly = tracked;
    this.deps.sessionManager.latchAuthority(current.id, cause);
    this.endAtSafePoint(tracked);
  }

  private onSessionStarted(record: OperatorSessionRecord): void {
    if (this.stopped) return;
    if (this.latchOnly !== null && this.latchOnly.session_id !== record.id) {
      this.releaseLatchOnly();
    }
    const previous = this.armed;
    if (previous !== null && previous.session_id !== record.id) {
      // A new session replaced the old one without an end: release the old
      // admission unless the new session holds the same one (F4).
      this.disarm();
      if (previous.admission_id !== record.admission_id) {
        this.endAdmission(previous);
      }
    }
    const armed = armedFor(record, () => this.nowMs());
    if (armed === null) return;
    this.armed = armed;
    this.scheduleNext(armed, this.firstHeartbeatCapMs(armed));
  }

  /**
   * TTL/2, or {@link EARLY_VERIFY_MS} when this user's previous `end` has an
   * unknown outcome (Codex P1 4180025698). Either way, bounded by the deadline.
   */
  private firstHeartbeatCapMs(armed: Armed): number {
    const interval = heartbeatIntervalMs(armed.ttl_seconds);
    return takeUncertainEnd(this.deps.admission, armed.user_id)
      ? Math.min(interval, EARLY_VERIFY_MS)
      : interval;
  }

  private onSessionEnded(record: OperatorSessionRecord): void {
    if (this.stopped) return;
    if (this.latchOnly?.session_id === record.id) this.releaseLatchOnly();
    const armed = this.armed;
    if (armed !== null && armed.session_id === record.id) {
      this.disarm();
      this.endAdmission(armed);
      return;
    }
    if (record.admission_id !== undefined) {
      this.endAdmission({ admission_id: record.admission_id, user_id: record.user_id });
    }
  }

  private schedule(target: Tracked, ms: number, run: () => void): void {
    if (target.timer !== null) clearTimeout(target.timer);
    target.timer = setTimeout(() => {
      target.timer = null;
      run();
    }, ms);
  }

  /** The ONE way to schedule the next admission call: `capMs`, bounded by the deadline. */
  private scheduleNext(armed: Armed, capMs: number): void {
    this.schedule(armed, nextCallDelayMs(capMs, armed.deadline, this.nowMs()), () => {
      void this.heartbeat(armed);
    });
  }

  private nowMs(): number {
    return monotonicNowMs(this.deps.admission);
  }

  private disarm(): void {
    if (this.armed?.timer != null) clearTimeout(this.armed.timer);
    this.armed = null;
  }

  private releaseLatchOnly(): void {
    if (this.latchOnly?.timer != null) clearTimeout(this.latchOnly.timer);
    this.latchOnly = null;
  }

  /** True while `target` is still the tracked, current session and the keeper runs. */
  private stillCurrent(target: Tracked): boolean {
    return (
      !this.stopped &&
      (this.armed === target || this.latchOnly === target) &&
      this.deps.sessionManager.getCurrent()?.id === target.session_id
    );
  }

  private async heartbeat(armed: Armed): Promise<void> {
    if (!this.stillCurrent(armed) || armed.latched) return;
    // Stamped before the request goes out: a renewal's deadline runs from here.
    armed.last_sent_at_ms = this.nowMs();
    const result = await this.requestHeartbeat(armed);
    // RT-198 latch + session identity: re-checked after the await.
    if (this.stopped) return;
    if (!this.stillCurrent(armed)) {
      this.releaseOrphan(result, armed);
      return;
    }
    this.log(result.kind);
    this.handleOutcome(armed, result);
  }

  private async requestHeartbeat(armed: Armed): Promise<CashierAdmissionResult> {
    try {
      return await this.deps.admission.client.admit({
        mode: 'online',
        user_id: armed.user_id,
        takeover: false,
        idempotency_key: nextIdempotencyKey(this.deps.admission),
      });
    } catch {
      return { kind: 'no_connection' };
    }
  }

  /**
   * Review F7: an `admitted` for a session that is gone leaves a live server
   * admission behind. End it, unless the live session holds that same id
   * (same-device re-admission returns the same `admission_id`).
   */
  private releaseOrphan(result: CashierAdmissionResult, orphanOf: Armed): void {
    if (result.kind !== 'admitted') return;
    if (this.armed?.admission_id === result.admission_id) return;
    this.endAdmission({ admission_id: result.admission_id, user_id: orphanOf.user_id });
  }

  private handleOutcome(armed: Armed, result: CashierAdmissionResult): void {
    switch (result.kind) {
      case 'admitted':
        this.onAdmitted(armed, result);
        return;
      case 'active_elsewhere':
        this.latch(armed, 'superseded_by_takeover');
        return;
      case 'refused':
        notifyGrantSeam(this.deps.admission, result, armed);
        this.latch(armed, 'account_disabled_mid_session');
        return;
      case 'device_unauthorized':
        this.onDeviceUnauthorized(armed);
        return;
      default:
        this.onNotAnswered(armed, result);
    }
  }

  private onAdmitted(armed: Armed, result: CashierAdmissionAdmitted): void {
    armed.failures = 0;
    notifyGrantSeam(this.deps.admission, result, armed);
    if (result.admission_id !== armed.admission_id) {
      this.deps.logger?.warn(
        { event: 'operator.cashier_admission.heartbeat.rotated' },
        'cashier admission re-issued after expiry',
      );
      armed.admission_id = result.admission_id;
    }
    armed.ttl_seconds = result.admission_ttl_seconds;
    armed.deadline = {
      requested_at_ms: armed.last_sent_at_ms,
      ttl_ms: result.admission_ttl_seconds * 1000,
    };
    this.deps.sessionManager.renewAdmission(armed.session_id, {
      admission_id: result.admission_id,
      admission_ttl_seconds: result.admission_ttl_seconds,
      offline_grace_seconds: result.offline_grace_seconds,
      admission_requested_at_ms: armed.last_sent_at_ms,
    });
    this.scheduleNext(armed, heartbeatIntervalMs(armed.ttl_seconds));
  }

  /**
   * RT-215: the keeper does not count device 401s — the shared detector saw
   * this one (the client's fetch is observed) and decides whether the device
   * is revoked; when it is, it latches this session through
   * {@link latchCurrentSession}. Here the heartbeat only retries soon (review
   * F3): never later than TTL/2 (Codex P2 4179701427) nor than half the time
   * left before the deadline (4179771036), so a transient 401 still renews the
   * admission before it lapses.
   */
  private onDeviceUnauthorized(armed: Armed): void {
    this.scheduleNext(armed, deviceConfirmCapMs(armed));
  }

  /**
   * Unanswered or not applied: keep the session; failed ticks back off (F6).
   * Either way the retry lands before the deadline (Codex P2 4179771036).
   */
  private onNotAnswered(armed: Armed, result: CashierAdmissionResult): void {
    if (!BACKOFF_KINDS.has(result.kind)) {
      armed.failures = 0;
      this.scheduleNext(armed, heartbeatIntervalMs(armed.ttl_seconds));
      return;
    }
    armed.failures += 1;
    this.scheduleNext(armed, backoffCapMs(armed));
  }

  /** Lose authority: no new sale, no more heartbeats; end at the first safe point. */
  private latch(armed: Armed, cause: AuthorityLatchCause): void {
    armed.latched = true;
    this.deps.sessionManager.latchAuthority(armed.session_id, cause);
    this.endAtSafePoint(armed);
  }

  private endAtSafePoint(target: Tracked): void {
    if (!this.stillCurrent(target)) return;
    if (this.atSafePoint()) {
      const cause = this.deps.sessionManager.getCurrent()?.authority_latch;
      this.deps.sessionManager.end(cause ?? 'superseded_by_takeover');
      return;
    }
    this.schedule(target, this.deps.safePointRecheckMs ?? SAFE_POINT_RECHECK_MS, () => {
      this.endAtSafePoint(target);
    });
  }

  private atSafePoint(): boolean {
    try {
      return this.deps.isAtSafePoint();
    } catch {
      return false; // never end over a sale we could not inspect
    }
  }

  /**
   * Best-effort, fire-and-forget; never blocks sign-out. Tracked per user so a
   * re-admission of the same user waits for it (review of 024f07c, item 3).
   */
  private endAdmission(ending: AdmissionToEnd): void {
    void endAdmissionTracked(this.deps.admission, ending.admission_id, ending.user_id).then(
      (res) => {
        this.logEnd(res.kind);
      },
    );
  }

  private logEnd(outcome: string): void {
    this.deps.logger?.info(
      { event: 'operator.cashier_admission.end', outcome },
      'cashier admission end',
    );
  }

  private log(outcome: string): void {
    this.deps.logger?.info(
      { event: 'operator.cashier_admission.heartbeat', outcome },
      'cashier admission heartbeat',
    );
  }
}
