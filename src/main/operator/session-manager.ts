import { randomUUID } from 'node:crypto';

import type { Role } from '../../shared/operator/role.js';
import type { OperatorSessionBridgeView } from '../../shared/bridge-api.js';
import type { SessionEndCause } from '../../shared/operator/session-end-cause.js';

/**
 * 004-operator-session T028 — main-process session manager (in-memory).
 *
 * S1 holds the active operator session entirely in memory. Crash =
 * session lost; the operator signs in again. Durable persistence is
 * S3/S4 territory under §A3 (the `operator_sessions` migration).
 *
 * The session is the source of truth for the renderer-side store; the
 * renderer mirrors the FSM but the visible session shape (no JWT, no
 * tokens) comes from this manager.
 */

/**
 * RT-113 (10763 §3) — where a cashier session's authority comes from.
 * P2 sets `online_confirmed` (a live Backend-Core cashier admission); P3 adds
 * sessions admitted offline from the sealed grant (`offline_grant`).
 */
export type SessionAuthority = 'online_confirmed' | 'offline_grant';

/** RT-113 P2 — the live cashier admission a session holds (main-only). */
export interface CashierAdmissionFields {
  admission_id: string;
  /** TTL from the LATEST `admitted` response; the heartbeat runs at ≤ half of it. */
  admission_ttl_seconds: number;
  offline_grace_seconds: number;
}

export interface OperatorSessionRecord {
  id: string;
  operator_id: string;
  display_name: string;
  role: Role;
  tenant_id: string;
  branch_id: string;
  started_at: string;
  /** Server-side session id minted by Data-Pulse-2. */
  backend_session_id: string;
  /** ISO timestamp of last genuine renderer-side activity (T028b). */
  last_activity_at: string;
  /**
   * RT-117 (RT-116 §2.1) — LOCKED is a state of THIS session, never an end.
   * In memory only, like the session itself; a restart loses it.
   */
  lock_state: 'active' | 'locked';
  /** ISO timestamp the session locked; null while active. */
  locked_at: string | null;
  /**
   * RT-113 P2 (10763 §3) — set only on an admitted cashier session. Main-only:
   * never in the bridge view (Constitution VII).
   */
  user_id?: string;
  authority?: SessionAuthority;
  admission_id?: string;
  admission_ttl_seconds?: number;
  offline_grace_seconds?: number;
}

export interface CreateSessionInput {
  operator_id: string;
  display_name: string;
  role: Role;
  tenant_id: string;
  branch_id: string;
  backend_session_id: string;
  started_at?: string;
  /** RT-113 P2 — the cashier's live online admission (sign-in or takeover). */
  cashier_admission?: CashierAdmissionFields & { user_id: string };
}

type SessionEndCallback = (
  record: OperatorSessionRecord,
  cause: SessionEndCause | undefined,
) => void;

/** #380 — fired after a new session is created (any sign-in role). */
type SessionStartCallback = (record: OperatorSessionRecord) => void;

/** RT-117 — fired after the current session locks or unlocks. */
type LockStateCallback = (record: OperatorSessionRecord) => void;

export class SessionManager {
  private current: OperatorSessionRecord | null = null;
  private lastEndCause: SessionEndCause | null = null;
  private readonly endCallbacks: SessionEndCallback[] = [];
  private readonly startCallbacks: SessionStartCallback[] = [];
  private readonly lockCallbacks: LockStateCallback[] = [];

  getCurrent(): OperatorSessionRecord | null {
    return this.current;
  }

  /**
   * Renderer-facing projection. Strips the backend session id and the
   * activity timestamp — the renderer never sees those.
   */
  getCurrentBridgeView(): OperatorSessionBridgeView | null {
    if (this.current === null) return null;
    return {
      id: this.current.id,
      operator_id: this.current.operator_id,
      display_name: this.current.display_name,
      role: this.current.role,
      tenant_id: this.current.tenant_id,
      branch_id: this.current.branch_id,
      started_at: this.current.started_at,
    };
  }

  create(input: CreateSessionInput): OperatorSessionRecord {
    const now = input.started_at ?? new Date().toISOString();
    const record: OperatorSessionRecord = {
      id: randomUUID(),
      operator_id: input.operator_id,
      display_name: input.display_name,
      role: input.role,
      tenant_id: input.tenant_id,
      branch_id: input.branch_id,
      backend_session_id: input.backend_session_id,
      started_at: now,
      last_activity_at: now,
      lock_state: 'active',
      locked_at: null,
    };
    if (input.cashier_admission !== undefined) {
      const a = input.cashier_admission;
      record.user_id = a.user_id;
      record.authority = 'online_confirmed';
      record.admission_id = a.admission_id;
      record.admission_ttl_seconds = a.admission_ttl_seconds;
      record.offline_grace_seconds = a.offline_grace_seconds;
    }
    this.current = record;
    // #380 — fire start subscribers (e.g. the orphan-attempt sweep). A
    // throwing subscriber must not break sign-in (mirrors end()).
    for (const cb of this.startCallbacks) {
      try {
        cb(record);
      } catch {
        // subscribers must not break create()
      }
    }
    return record;
  }

  /**
   * RT-113 P2 — record a heartbeat's `admitted` on the CURRENT session, only
   * when `session_id` still names it. Returns whether it was applied.
   */
  renewAdmission(session_id: string, admission: CashierAdmissionFields): boolean {
    if (this.current?.id !== session_id) return false;
    this.current.authority = 'online_confirmed';
    this.current.admission_id = admission.admission_id;
    this.current.admission_ttl_seconds = admission.admission_ttl_seconds;
    this.current.offline_grace_seconds = admission.offline_grace_seconds;
    return true;
  }

  /** Register a callback fired after each session ends. */
  onEnded(cb: SessionEndCallback): void {
    this.endCallbacks.push(cb);
  }

  /**
   * #380 — register a callback fired after each session is created. The
   * symmetric counterpart of onEnded; used to sweep a stuck `started` payment
   * attempt left by a crashed prior session (the clean-end case is handled by
   * the onEnded discard). Role-agnostic — both sign-in paths call create().
   */
  onStarted(cb: SessionStartCallback): void {
    this.startCallbacks.push(cb);
  }

  /**
   * End the active session. The optional `cause` is stored in-memory for
   * test inspection and will be written to the `operator_sessions` SQL row
   * once §A3 (T065) lands. Matches data-model.md §"Entity 2 — OperatorSession".
   */
  end(cause?: SessionEndCause): OperatorSessionRecord | null {
    const ending = this.current;
    if (ending !== null && cause !== undefined) {
      this.lastEndCause = cause;
    }
    this.current = null;
    if (ending !== null) {
      for (const cb of this.endCallbacks) {
        try {
          cb(ending, cause);
        } catch {
          // subscribers must not break end()
        }
      }
    }
    return ending;
  }

  /** Returns the end_cause recorded for the most recently ended session. */
  getLastEndCause(): SessionEndCause | null {
    return this.lastEndCause;
  }

  noteActivity(at: string): void {
    if (this.current === null) return;
    // RT-117 — activity never unlocks and never extends a locked session.
    if (this.current.lock_state === 'locked') return;
    this.current.last_activity_at = at;
  }

  isLocked(): boolean {
    return this.current?.lock_state === 'locked';
  }

  /** Register a callback fired after the current session locks or unlocks. */
  onLockStateChanged(cb: LockStateCallback): void {
    this.lockCallbacks.push(cb);
  }

  /**
   * RT-117 (RT-116 §2.2) — lock the CURRENT session in place. Same session id;
   * onEnded is NOT fired, so the session-end sweep cannot run on a lock.
   */
  lock(at: string): void {
    if (this.current === null || this.current.lock_state === 'locked') return;
    this.current.lock_state = 'locked';
    this.current.locked_at = at;
    this.notifyLockState(this.current);
  }

  /**
   * RT-117 — resume the SAME session after a verified same-operator unlock.
   * onStarted is NOT fired (the session never ended). Callers verify the
   * credential first; this method only flips the state.
   */
  unlock(at: string): void {
    if (this.current === null || this.current.lock_state !== 'locked') return;
    this.current.lock_state = 'active';
    this.current.locked_at = null;
    this.current.last_activity_at = at;
    this.notifyLockState(this.current);
  }

  private notifyLockState(record: OperatorSessionRecord): void {
    for (const cb of this.lockCallbacks) {
      try {
        cb(record);
      } catch {
        // subscribers must not break lock()/unlock()
      }
    }
  }
}
