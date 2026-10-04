import type { Logger } from 'pino';

import type {
  CashierAdmissionAdmitted,
  CashierAdmissionResult,
} from './cashier-admission-client.js';
import {
  nextIdempotencyKey,
  reportAdmissionOutcome,
  type CashierAdmissionDeps,
} from './cashier-admission.js';
import type { OperatorSessionRecord, SessionManager } from './session-manager.js';

/**
 * RT-113 P2 — keeps an online cashier admission live, and ends it.
 *
 * Contract (`posCreateCashierAdmission`, Heartbeat): an online-confirmed
 * session MUST re-call the admission with `mode: online`, `takeover: false`
 * and a FRESH `idempotency_key` at an interval of at most half of
 * `admission_ttl_seconds` from the latest `admitted` response.
 *
 * The keeper observes the SessionManager:
 *  - a session that starts with an online admission is armed: its first
 *    heartbeat fires TTL/2 after sign-in, each next one TTL/2 after the latest
 *    answer (a `setTimeout` chain, so a request never overlaps the next);
 *  - any session end (sign-out, cascade, superseded) disarms it and fires a
 *    best-effort, fire-and-forget `end` for its admission. `end` is idempotent
 *    server-side and its failure never blocks sign-out;
 *  - `stop()` is the shutdown latch (RT-198 pattern): it clears every timer,
 *    and nothing — no heartbeat, no `end`, no session change, no seam call —
 *    happens afterwards, even when an in-flight request settles later.
 *
 * Heartbeat outcomes (10763 D8 / contract):
 *  - `admitted` → renew (record the latest TTL and grace; refresh the P1
 *    grant seam). A different `admission_id` means the old one expired and the
 *    server admitted this device afresh: the new id is adopted and logged.
 *  - `active_elsewhere` → stop heartbeating; end the session
 *    `superseded_by_takeover` at its next safe point (no open sale with lines
 *    and no live tender), re-checked every {@link SAFE_POINT_RECHECK_MS}.
 *    Nothing is reversed or discarded.
 *  - `refused` (403) → invalidate the grant (P1 seam) and end the session
 *    `account_disabled_mid_session` (LifecycleCascade).
 *  - `device_unauthorized` (401) → the device-revoked handling
 *    (`terminal_session_terminated`).
 *  - anything else (unreachable, 5xx, 400/409/429) → keep the session and try
 *    again on the next tick.
 *
 * Every outcome is checked against the stop latch and against the session the
 * request was made for, AFTER the await: a response for an ended session never
 * touches the next one.
 *
 * Logs carry the outcome kind only — no admission id, user id, key or name.
 */

/** How often a superseded session re-checks for its next safe point. */
export const SAFE_POINT_RECHECK_MS = 5_000;

/** The heartbeat interval: half the TTL, in ms (never below 1 ms). */
export function heartbeatIntervalMs(ttlSeconds: number): number {
  return Math.max(1, Math.floor((ttlSeconds * 1000) / 2));
}

export interface CashierAdmissionKeeperDeps {
  sessionManager: SessionManager;
  admission: CashierAdmissionDeps;
  /** 403 on a heartbeat: production wires `LifecycleCascade.notifyAccountDisabled()`. */
  onAccountDisabled: () => void;
  /**
   * True when ending the session now preserves everything: no open sale with
   * lines and no live tender. Production wires the RT-117 lock-state summary.
   */
  isAtSafePoint: () => boolean;
  safePointRecheckMs?: number;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

interface Armed {
  session_id: string;
  user_id: string;
  operator_id: string;
  admission_id: string;
  ttl_seconds: number;
  timer: ReturnType<typeof setTimeout> | null;
  superseded: boolean;
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

/** The heartbeat state for a session, or null when it holds no online admission. */
function armedFor(record: OperatorSessionRecord): Armed | null {
  if (!isOnlineAdmitted(record)) return null;
  return {
    session_id: record.id,
    user_id: record.user_id,
    operator_id: record.operator_id,
    admission_id: record.admission_id,
    ttl_seconds: record.admission_ttl_seconds,
    timer: null,
    superseded: false,
  };
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
  }

  /** Shutdown latch: idempotent; clears every timer; nothing runs afterwards. */
  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  private onSessionStarted(record: OperatorSessionRecord): void {
    if (this.stopped) return;
    const previous = this.armed;
    if (previous !== null && previous.session_id !== record.id) {
      // A new session replaced the old one without an end: release the old admission.
      this.disarm();
      this.endAdmission(previous.admission_id);
    }
    const armed = armedFor(record);
    if (armed === null) return;
    this.armed = armed;
    this.scheduleHeartbeat(armed);
  }

  private onSessionEnded(record: OperatorSessionRecord): void {
    if (this.stopped) return;
    const armed = this.armed;
    if (armed !== null && armed.session_id === record.id) {
      this.disarm();
      this.endAdmission(armed.admission_id);
      return;
    }
    if (record.admission_id !== undefined) this.endAdmission(record.admission_id);
  }

  private schedule(ms: number, run: () => void): void {
    const armed = this.armed;
    if (armed === null) return;
    if (armed.timer !== null) clearTimeout(armed.timer);
    armed.timer = setTimeout(() => {
      armed.timer = null;
      run();
    }, ms);
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

  private scheduleHeartbeat(armed: Armed): void {
    this.schedule(heartbeatIntervalMs(armed.ttl_seconds), () => {
      void this.heartbeat();
    });
  }

  /** The armed session may heartbeat now: running, armed, not superseded. */
  private beatable(): Armed | null {
    const armed = this.armed;
    if (this.stopped || armed === null) return null;
    return armed.superseded ? null : armed;
  }

  private async heartbeat(): Promise<void> {
    const armed = this.beatable();
    if (armed === null) return;
    const result = await this.requestHeartbeat(armed);
    // RT-198 latch + session identity: re-checked after the await.
    if (!this.stillCurrent(armed)) return;
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

  private handleOutcome(armed: Armed, result: CashierAdmissionResult): void {
    switch (result.kind) {
      case 'admitted':
        this.onAdmitted(armed, result);
        return;
      case 'active_elsewhere':
        this.onActiveElsewhere(armed);
        return;
      case 'refused':
        this.onRefused(armed, result);
        return;
      case 'device_unauthorized':
        this.onDeviceRevoked(armed, result);
        return;
      default:
        // Unreachable / 5xx / 400 / 409 / 429: keep the session, retry next tick.
        this.scheduleHeartbeat(armed);
    }
  }

  private onAdmitted(armed: Armed, result: CashierAdmissionAdmitted): void {
    reportAdmissionOutcome(this.deps.admission, result, armed);
    if (result.admission_id !== armed.admission_id) {
      this.deps.logger?.warn(
        { event: 'operator.cashier_admission.heartbeat.rotated' },
        'cashier admission re-issued after expiry',
      );
      armed.admission_id = result.admission_id;
    }
    armed.ttl_seconds = result.admission_ttl_seconds;
    this.deps.sessionManager.renewAdmission(armed.session_id, {
      admission_id: result.admission_id,
      admission_ttl_seconds: result.admission_ttl_seconds,
      offline_grace_seconds: result.offline_grace_seconds,
    });
    this.scheduleHeartbeat(armed);
  }

  private onActiveElsewhere(armed: Armed): void {
    armed.superseded = true;
    this.endAtSafePoint(armed);
  }

  private onRefused(armed: Armed, result: CashierAdmissionResult): void {
    reportAdmissionOutcome(this.deps.admission, result, armed);
    this.disarm();
    this.safely(this.deps.onAccountDisabled);
  }

  private onDeviceRevoked(armed: Armed, result: CashierAdmissionResult): void {
    this.disarm();
    reportAdmissionOutcome(this.deps.admission, result, armed);
  }

  private endAtSafePoint(armed: Armed): void {
    if (!this.stillCurrent(armed)) return;
    let safe = false;
    try {
      safe = this.deps.isAtSafePoint();
    } catch {
      safe = false; // never end over a sale we could not inspect
    }
    if (safe) {
      this.deps.sessionManager.end('superseded_by_takeover');
      return;
    }
    this.schedule(this.deps.safePointRecheckMs ?? SAFE_POINT_RECHECK_MS, () => {
      this.endAtSafePoint(armed);
    });
  }

  private endAdmission(admissionId: string): void {
    void this.deps.admission.client
      .end(admissionId)
      .then((res) => {
        this.deps.logger?.info(
          { event: 'operator.cashier_admission.end', outcome: res.kind },
          'cashier admission end',
        );
      })
      .catch(() => {
        this.deps.logger?.info(
          { event: 'operator.cashier_admission.end', outcome: 'threw' },
          'cashier admission end',
        );
      });
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // A failing cascade must not break the keeper.
    }
  }

  private log(outcome: string): void {
    this.deps.logger?.info(
      { event: 'operator.cashier_admission.heartbeat', outcome },
      'cashier admission heartbeat',
    );
  }
}
