import type { Logger } from 'pino';

import type {
  CashierAdmissionAdmitted,
  CashierAdmissionResult,
} from './cashier-admission-client.js';
import {
  captureSendMark,
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
 * Losing authority (Codex P1 #1, review F1/F2/F3): `active_elsewhere`, a 403
 * and two CONSECUTIVE device 401s (the second a confirmation call 30 s after
 * the first) LATCH the session (`SessionManager.latchAuthority`). While
 * latched no new sale may start (`cart.create`, and adding a line to an empty
 * cart, refuse `authority_conflict`) and the heartbeat stops. The session ends with its own cause
 * (`superseded_by_takeover` / `account_disabled_mid_session` /
 * `terminal_session_terminated`) at its FIRST safe point (no open sale with
 * lines and no live tender). The safe point is checked at once, after EVERY
 * sale IPC call (`recheckSafePoint`, wired at the `sale-boundary-guard.ts`
 * choke point), on every lock-state change, and every
 * {@link SAFE_POINT_RECHECK_MS} as a backstop. Nothing is
 * reversed or discarded. A 403, `active_elsewhere` (OD6) or the FIRST device
 * 401 (OD5) invalidates the P1 grant at once (D4).
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
 * normal cadence; a first device 401 is confirmed after 30 s (F3). Each of
 * these is ALSO capped by the deadline. A late `admitted` for a session that
 * is gone ends that admission unless the live session holds it (review F7).
 *
 * RT-219 (contract 1.1.0-draft): every `end` echoes the `admission_generation`
 * of the LATEST `admitted` for that admission. Sign-in and takeover set it, and
 * EVERY heartbeat `admitted` replaces it, even when the id is unchanged. A late
 * `end` is then a server-side no-op once the admission has been renewed after
 * it. An orphan release echoes the generation of the orphan response itself.
 *
 * Logs carry the outcome kind only: no admission id, user id, key, name or
 * generation.
 */

/** How often a latched session re-checks for its next safe point (backstop). */
export const SAFE_POINT_RECHECK_MS = 5_000;
/** Review F3: the confirmation call after a first device 401 (at most TTL/2, Codex P2 4179701427). */
export const DEVICE_401_CONFIRM_MS = 30_000;
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
  /** RT-219: from the latest `admitted` for `admission_id`; echoed on `end`. */
  admission_generation: string;
  user_id: string | undefined;
}

interface Armed {
  session_id: string;
  user_id: string;
  operator_id: string;
  admission_id: string;
  /** RT-219: replaced by every `admitted`; the `end` echoes it. */
  admission_generation: string;
  ttl_seconds: number;
  deadline: AdmissionDeadline;
  /** When the in-flight (or last) heartbeat was sent; heartbeats never overlap. */
  last_sent_at_ms: number;
  /** When the scheduled admission call fires (monotonic ms); null when none is scheduled. */
  next_call_at_ms: number | null;
  /** Heartbeats sent by this session so far (the latest one's sequence number). */
  sent_seq: number;
  /**
   * RT-219 review F1 / Codex P2 4181547527: an orphan answer renewed this
   * admission, so the generation held may be stale. Set until an `admitted`
   * for a heartbeat sent AFTER that answer (`sent_seq > stale_upto_seq`)
   * refreshes it; a non-admitted outcome keeps it. `early_scheduled`: the one
   * early verification call has been scheduled (no 5 s retry loop).
   */
  reverify: { stale_upto_seq: number; early_scheduled: boolean } | null;
  timer: ReturnType<typeof setTimeout> | null;
  latched: boolean;
  /** Consecutive failed ticks (backoff). */
  failures: number;
  /** Consecutive device 401s (debounce). */
  device401s: number;
  /** Codex P1 4181552524: the pairing the in-flight (or last) heartbeat was sent under. */
  pairing_generation?: number | undefined;
  /** rev545 F-2: the grant seam's invalidation sequence when that heartbeat was sent. */
  invalidation_seq?: number | undefined;
}

/** Outcomes that invalidate offline grants (D4, OD5, OD6), even for an orphaned heartbeat. */
const INVALIDATING_KINDS: ReadonlySet<CashierAdmissionResult['kind']> = new Set([
  'refused',
  'active_elsewhere',
  'device_unauthorized',
]);

/** True when the record holds a live online cashier admission to keep alive. */
function isOnlineAdmitted(
  record: OperatorSessionRecord,
): record is OperatorSessionRecord &
  Required<
    Pick<
      OperatorSessionRecord,
      'user_id' | 'admission_id' | 'admission_generation' | 'admission_ttl_seconds'
    >
  > {
  const fieldsPresent = [
    record.admission_id,
    record.admission_generation,
    record.user_id,
    record.admission_ttl_seconds,
  ].every((f) => f !== undefined);
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
    admission_generation: record.admission_generation,
    ttl_seconds: record.admission_ttl_seconds,
    deadline: { requested_at_ms: sentAt, ttl_ms: record.admission_ttl_seconds * 1000 },
    last_sent_at_ms: sentAt,
    next_call_at_ms: null,
    sent_seq: 0,
    reverify: null,
    timer: null,
    latched: false,
    failures: 0,
    device401s: 0,
  };
}

/** Review F3 + Codex P2 4179701427: the 401 confirmation, min(30 s, TTL/2), before the deadline. */
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
  }

  /**
   * A sale boundary happened (sale settled, voided or cancelled, or a new sale
   * was refused): end a latched session now if it is at its safe point.
   */
  recheckSafePoint(): void {
    const armed = this.armed;
    if (armed === null || !armed.latched) return;
    this.endAtSafePoint(armed);
  }

  private onSessionStarted(record: OperatorSessionRecord): void {
    if (this.stopped) return;
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
    return takeUncertainEnd(this.deps.admission, armed.user_id)
      ? this.earlyVerifyCapMs(armed)
      : heartbeatIntervalMs(armed.ttl_seconds);
  }

  private onSessionEnded(record: OperatorSessionRecord): void {
    if (this.stopped) return;
    const armed = this.armed;
    if (armed !== null && armed.session_id === record.id) {
      this.disarm();
      this.endAdmission(armed);
      return;
    }
    if (record.admission_id !== undefined && record.admission_generation !== undefined) {
      this.endAdmission({
        admission_id: record.admission_id,
        admission_generation: record.admission_generation,
        user_id: record.user_id,
      });
    }
  }

  private schedule(armed: Armed, ms: number, run: () => void): void {
    if (armed.timer !== null) clearTimeout(armed.timer);
    armed.next_call_at_ms = null; // only scheduleNext schedules an admission call
    armed.timer = setTimeout(() => {
      armed.timer = null;
      armed.next_call_at_ms = null;
      run();
    }, ms);
  }

  /** The ONE way to schedule the next admission call: `capMs`, bounded by the deadline. */
  private scheduleNext(armed: Armed, capMs: number): void {
    const delay = nextCallDelayMs(capMs, armed.deadline, this.nowMs());
    this.schedule(armed, delay, () => {
      void this.heartbeat(armed);
    });
    armed.next_call_at_ms = this.nowMs() + delay;
  }

  /** The early-verification cap: {@link EARLY_VERIFY_MS}, never above TTL/2. */
  private earlyVerifyCapMs(armed: Armed): number {
    return Math.min(heartbeatIntervalMs(armed.ttl_seconds), EARLY_VERIFY_MS);
  }

  /**
   * RT-219 review F1: the live admission was renewed by a request this session
   * did not send, so the generation it holds may be stale and its `end` a
   * server-side no-op. Verify early: the next heartbeat returns the current
   * generation. The orphan's generation is never adopted (answers can arrive
   * out of order, so it may be the older one). A heartbeat in flight defers
   * the verification to its answer; a call already due sooner is not
   * postponed. A latched session has no call scheduled and never heartbeats
   * again, so nothing is sent for it.
   */
  private reverifySoon(live: Armed): void {
    // Every heartbeat sent so far may hold a stale answer.
    live.reverify = { stale_upto_seq: live.sent_seq, early_scheduled: false };
    if (live.next_call_at_ms === null) return; // in flight: its outcome schedules the early call
    live.reverify.early_scheduled = true; // the scheduled call is the verification
    const earlyAt =
      this.nowMs() + nextCallDelayMs(this.earlyVerifyCapMs(live), live.deadline, this.nowMs());
    if (live.next_call_at_ms <= earlyAt) return;
    this.scheduleNext(live, this.earlyVerifyCapMs(live));
  }

  /**
   * The cap for the next call after an outcome: `normalCapMs`, or, once per
   * stale period (review F1 / Codex P2 4181547527), the early verification,
   * never below `floorMs` (a `rate_limited` backoff is honoured, no hammering).
   */
  private nextCapMs(armed: Armed, normalCapMs: number, floorMs = 0): number {
    const r = armed.reverify;
    if (r === null || r.early_scheduled) return normalCapMs;
    r.early_scheduled = true;
    return Math.min(normalCapMs, Math.max(this.earlyVerifyCapMs(armed), floorMs));
  }

  private nowMs(): number {
    return monotonicNowMs(this.deps.admission);
  }

  private disarm(): void {
    if (this.armed?.timer != null) clearTimeout(this.armed.timer);
    this.armed = null;
  }

  /** True while `armed` is still the live, current session and the keeper runs. */
  private stillCurrent(armed: Armed): boolean {
    return (
      !this.stopped &&
      this.armed === armed &&
      this.deps.sessionManager.getCurrent()?.id === armed.session_id
    );
  }

  private async heartbeat(armed: Armed): Promise<void> {
    if (!this.stillCurrent(armed) || armed.latched) return;
    // Stamped before the request goes out: a renewal's deadline runs from here.
    armed.last_sent_at_ms = this.nowMs();
    const mark = captureSendMark(this.deps.admission);
    armed.pairing_generation = mark.pairing_generation;
    armed.invalidation_seq = mark.invalidation_seq;
    const seq = ++armed.sent_seq;
    const result = await this.requestHeartbeat(armed);
    // RT-198 latch + session identity: re-checked after the await.
    if (this.stopped) return;
    if (!this.stillCurrent(armed)) {
      this.releaseOrphan(result, armed);
      return;
    }
    this.log(result.kind);
    this.handleOutcome(armed, result, seq);
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
   *
   * RT-219 (closes RT-219 10869 item 2): the `end` echoes THIS response's
   * generation. If a re-sign-in renews the admission before the `end` lands,
   * the server ignores it instead of ending the renewed admission.
   *
   * RT-219 review F1: an orphan answer for the id the live session holds means
   * the orphan request renewed the LIVE admission, so verify it early.
   */
  private releaseOrphan(result: CashierAdmissionResult, orphanOf: Armed): void {
    // rev545 F-1: a 403, `active_elsewhere` or device 401 for a session that is
    // gone still invalidates the offline grant (fail closed; D4, OD5).
    if (INVALIDATING_KINDS.has(result.kind)) notifyGrantSeam(this.deps.admission, result, orphanOf);
    if (result.kind !== 'admitted') return;
    const live = this.armed;
    if (live?.admission_id === result.admission_id) {
      this.reverifySoon(live);
      return;
    }
    this.endAdmission({
      admission_id: result.admission_id,
      admission_generation: result.admission_generation,
      user_id: orphanOf.user_id,
    });
  }

  private handleOutcome(armed: Armed, result: CashierAdmissionResult, seq: number): void {
    if (result.kind !== 'device_unauthorized') armed.device401s = 0;
    switch (result.kind) {
      case 'admitted':
        this.onAdmitted(armed, result, seq);
        return;
      case 'active_elsewhere':
        notifyGrantSeam(this.deps.admission, result, armed);
        this.latch(armed, 'superseded_by_takeover');
        return;
      case 'refused':
        notifyGrantSeam(this.deps.admission, result, armed);
        this.latch(armed, 'account_disabled_mid_session');
        return;
      case 'device_unauthorized':
        this.onDeviceUnauthorized(armed, result);
        return;
      default:
        this.onNotAnswered(armed, result);
    }
  }

  private onAdmitted(armed: Armed, result: CashierAdmissionAdmitted, seq: number): void {
    armed.failures = 0;
    notifyGrantSeam(this.deps.admission, result, armed);
    if (result.admission_id !== armed.admission_id) {
      this.deps.logger?.warn(
        { event: 'operator.cashier_admission.heartbeat.rotated' },
        'cashier admission re-issued after expiry',
      );
      armed.admission_id = result.admission_id;
    }
    // RT-219: every renewal changes the generation, even with the same id.
    armed.admission_generation = result.admission_generation;
    armed.ttl_seconds = result.admission_ttl_seconds;
    armed.deadline = {
      requested_at_ms: armed.last_sent_at_ms,
      ttl_ms: result.admission_ttl_seconds * 1000,
    };
    this.deps.sessionManager.renewAdmission(armed.session_id, {
      admission_id: result.admission_id,
      admission_ttl_seconds: result.admission_ttl_seconds,
      offline_grace_seconds: result.offline_grace_seconds,
      admission_generation: result.admission_generation,
      admission_requested_at_ms: armed.last_sent_at_ms,
    });
    // Review F1: an answer to a heartbeat sent after the orphan answer is
    // current; one sent before it may be older, so verify early once.
    if (armed.reverify !== null && seq > armed.reverify.stale_upto_seq) armed.reverify = null;
    this.scheduleNext(armed, this.nextCapMs(armed, heartbeatIntervalMs(armed.ttl_seconds)));
  }

  /**
   * Review F3: act only on the second consecutive 401, confirmed 30 s later,
   * or sooner: never later than TTL/2 (Codex P2 4179701427) nor than half the
   * time left before the deadline (4179771036), or the admission lapses while
   * this till still treats the cashier as admitted.
   */
  private onDeviceUnauthorized(armed: Armed, result: CashierAdmissionResult): void {
    armed.device401s += 1;
    // RT-113 OD5: the FIRST 401 already invalidates every offline grant (fail
    // closed); only the session waits for the confirming 401.
    if (armed.device401s === 1) notifyGrantSeam(this.deps.admission, result, armed);
    if (armed.device401s < 2) {
      this.scheduleNext(armed, deviceConfirmCapMs(armed));
      return;
    }
    this.latch(armed, 'terminal_session_terminated');
  }

  /**
   * Unanswered or not applied: keep the session; failed ticks back off (F6).
   * Either way the retry lands before the deadline (Codex P2 4179771036).
   */
  private onNotAnswered(armed: Armed, result: CashierAdmissionResult): void {
    if (!BACKOFF_KINDS.has(result.kind)) {
      armed.failures = 0;
      this.scheduleNext(armed, this.nextCapMs(armed, heartbeatIntervalMs(armed.ttl_seconds)));
      return;
    }
    armed.failures += 1;
    // A `rate_limited` answer's backoff is a floor for the early verification.
    const floor = result.kind === 'rate_limited' ? backoffCapMs(armed) : 0;
    this.scheduleNext(armed, this.nextCapMs(armed, backoffCapMs(armed), floor));
  }

  /** Lose authority: no new sale, no more heartbeats; end at the first safe point. */
  private latch(armed: Armed, cause: AuthorityLatchCause): void {
    armed.latched = true;
    this.deps.sessionManager.latchAuthority(armed.session_id, cause);
    this.endAtSafePoint(armed);
  }

  private endAtSafePoint(armed: Armed): void {
    if (!this.stillCurrent(armed)) return;
    if (this.atSafePoint()) {
      const cause = this.deps.sessionManager.getCurrent()?.authority_latch;
      this.deps.sessionManager.end(cause ?? 'superseded_by_takeover');
      return;
    }
    this.schedule(armed, this.deps.safePointRecheckMs ?? SAFE_POINT_RECHECK_MS, () => {
      this.endAtSafePoint(armed);
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
    void endAdmissionTracked(
      this.deps.admission,
      ending.admission_id,
      ending.admission_generation,
      ending.user_id,
    ).then((res) => {
      this.logEnd(res.kind);
    });
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
