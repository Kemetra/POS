/**
 * RT-442 (RT-116 S5, §3.1 / §3.3 / §6) — a payment attempt outlives its
 * operator session. No session end ever reverses a tender line.
 *
 * At a session end, for a frozen cart of that session:
 *   • a `settled` attempt → untouched: 008 finalization owns it (SETTLED ≠
 *     FINALIZED, I-7);
 *   • a `started` attempt holding live tender (`applying | applied |
 *     reversal_pending`, M7) → stays `started` as the terminal's STUCK attempt,
 *     audited `payment.held_on_session_end` with its tender types and amounts;
 *   • a `started` attempt without live tender (Z2) → `cancelled` through the
 *     payment FSM (nothing to reverse), audited `payment.cancelled` with
 *     `cause: 'session_ended_no_funds'`. This frees the terminal's one
 *     started-attempt slot (M6).
 *
 * A restart fires no session end (§6), so the zero-funds close also runs at
 * the next admitted sign-in, for any started attempt without live tender that
 * is not bound to the new session.
 *
 * At the owner's admitted sign-in, the owner's stuck attempt on this terminal
 * is re-bound to the new session (`payment.reattached`), whatever its age. The
 * payment ownership check (M5) is unchanged: re-binding is the mechanism.
 *
 * Everything here is local and synchronous; nothing calls a backend.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { SessionEndCause } from '../../shared/operator/session-end-cause.js';
import type { PaymentAttemptFsm } from './fsm/payment-attempt-fsm.js';
import type { PaymentAuditEmitter } from './audit-emitter.js';

/** The session fields this module reads (main-only). */
export interface HeldAttemptSession {
  id: string;
  operator_id: string;
}

export interface StuckAttempt {
  payment_attempt_id: string;
  cart_id: string;
  operator_session_id: string;
}

/** What a frozen cart's payment record says at its session's end. */
export type FrozenCartPayment = 'settled' | 'open';

export interface HeldAttempts {
  /** §3.3 rows 3–5 for one frozen cart of the ending session. */
  onFrozenCartSessionEnd(input: {
    cart_id: string;
    session: HeldAttemptSession;
    cause: SessionEndCause | undefined;
    terminal_id: string;
  }): FrozenCartPayment;
  /** §6 / Z2: close started attempts without live tender left by ended sessions. */
  closeZeroFunds(input: { terminal_id: string; session: HeldAttemptSession }): void;
  /** §3.1: the owner's stuck attempt on this terminal, bound to another session. */
  findStuck(input: { terminal_id: string; session: HeldAttemptSession }): StuckAttempt | undefined;
  /** Re-bind the stuck attempt to the new session. */
  reattach(stuck: StuckAttempt, session: HeldAttemptSession, terminal_id: string): void;
  /** The started attempt bound to this session, if any (`getResumeState`). */
  startedFor(session_id: string): string | null;
  /** True when the cart already has a settled attempt (a finished sale). */
  isSettled(cart_id: string): boolean;
}

export interface HeldAttemptsDeps {
  db: DatabaseHandle;
  paymentAttemptFsm: Pick<PaymentAttemptFsm, 'cancel'>;
  auditEmitter: Pick<PaymentAuditEmitter, 'emitPaymentCancelled' | 'emitRaw'>;
  uuid: () => string;
  clock: () => Date;
}

interface AttemptRow {
  payment_attempt_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  acting_operator_id: string;
  operator_session_id: string;
  envelope_handoff_action_id: string;
  envelope_cart_id: string;
}

interface LineRow {
  tender_type: string;
  amount_applied_minor: number;
  state: string;
}

type Get<T> = { get(...params: unknown[]): T | undefined };
type All<T> = { all(...params: unknown[]): T[] };
type Run = { run(...params: unknown[]): { changes: number } };

const LIVE = `('applying', 'applied', 'reversal_pending')`;
const ATTEMPT_COLUMNS = `a.payment_attempt_id, a.tenant_id, a.branch_id, a.terminal_id,
       a.acting_operator_id, a.operator_session_id, a.envelope_handoff_action_id,
       a.envelope_cart_id`;
const HAS_LIVE = `EXISTS (SELECT 1 FROM payment_tender_lines l
                    WHERE l.payment_attempt_id = a.payment_attempt_id AND l.state IN ${LIVE})`;

export function createHeldAttempts(deps: HeldAttemptsDeps): HeldAttempts {
  const { db, paymentAttemptFsm, auditEmitter, uuid } = deps;
  const now = (): string => deps.clock().toISOString();

  const startedForCart = (cart_id: string, session: { id: string }): AttemptRow | undefined =>
    (
      db.prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts a
          WHERE a.envelope_cart_id = ? AND a.operator_session_id = ? AND a.state = 'started'
          LIMIT 1`,
      ) as Get<AttemptRow>
    ).get(cart_id, session.id);

  const hasLive = (row: AttemptRow): boolean =>
    (
      db.prepare(
        `SELECT 1 AS live FROM payment_tender_lines
          WHERE payment_attempt_id = ? AND state IN ${LIVE} LIMIT 1`,
      ) as Get<{ live: 1 }>
    ).get(row.payment_attempt_id) !== undefined;

  const liveLines = (row: AttemptRow): LineRow[] =>
    (
      db.prepare(
        `SELECT tender_type, amount_applied_minor, state FROM payment_tender_lines
          WHERE payment_attempt_id = ? AND state IN ${LIVE} ORDER BY apply_order`,
      ) as All<LineRow>
    ).all(row.payment_attempt_id);

  /**
   * The attempt's own attribution: its scope, its session and the operator who
   * started it. Every caller holds the row as bound to that session.
   */
  function context(row: AttemptRow) {
    return {
      tenant_id: row.tenant_id,
      branch_id: row.branch_id,
      originating_terminal_id: row.terminal_id,
      session_id: row.operator_session_id,
      attribution_operator_id: row.acting_operator_id,
    };
  }

  /** Z2: nothing to reverse, so the attempt is simply closed. */
  function closeNoFunds(row: AttemptRow): void {
    const at = now();
    const outcome = paymentAttemptFsm.cancel({
      payment_attempt_id: row.payment_attempt_id,
      cancelled_at: at,
      action_id: `${row.payment_attempt_id}:session-ended-no-funds:${uuid()}`,
    });
    if (outcome.kind !== 'ok') return;
    auditEmitter.emitPaymentCancelled({
      ...context(row),
      payment_attempt_id: row.payment_attempt_id,
      cart_id: row.envelope_cart_id,
      handoff_action_id: row.envelope_handoff_action_id,
      cancelled_at: at,
      cause: 'session_ended_no_funds',
    });
  }

  function holdLive(row: AttemptRow, cause: SessionEndCause | undefined) {
    auditEmitter.emitRaw({
      ...context(row),
      created_at: now(),
      action_category: 'payment.held_on_session_end',
      payment_attempt_id: row.payment_attempt_id,
      payload: {
        payment_attempt_id: row.payment_attempt_id,
        cart_id: row.envelope_cart_id,
        end_cause: cause ?? null,
        tender: liveLines(row).map((l) => ({
          tender_type: l.tender_type,
          amount_applied_minor: l.amount_applied_minor,
          state: l.state,
        })),
      },
    });
  }

  function isSettled(cart_id: string): boolean {
    return (
      (
        db.prepare(
          `SELECT 1 AS done FROM payment_attempts
            WHERE envelope_cart_id = ? AND state = 'settled' LIMIT 1`,
        ) as Get<{ done: 1 }>
      ).get(cart_id) !== undefined
    );
  }

  return {
    onFrozenCartSessionEnd({ cart_id, session, cause }) {
      if (isSettled(cart_id)) return 'settled';
      const started = startedForCart(cart_id, session);
      if (started === undefined) return 'open';
      if (hasLive(started)) holdLive(started, cause);
      else closeNoFunds(started);
      return 'open';
    },

    closeZeroFunds({ terminal_id, session }) {
      const rows = (
        db.prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts a
            WHERE a.terminal_id = ? AND a.state = 'started' AND a.operator_session_id <> ?
              AND NOT ${HAS_LIVE}`,
        ) as All<AttemptRow>
      ).all(terminal_id, session.id);
      for (const row of rows) closeNoFunds(row);
    },

    findStuck({ terminal_id, session }) {
      const row = (
        db.prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts a
            WHERE a.terminal_id = ? AND a.state = 'started' AND a.acting_operator_id = ?
              AND a.operator_session_id <> ? AND ${HAS_LIVE}
            LIMIT 1`,
        ) as Get<AttemptRow>
      ).get(terminal_id, session.operator_id, session.id);
      if (row === undefined) return undefined;
      return {
        payment_attempt_id: row.payment_attempt_id,
        cart_id: row.envelope_cart_id,
        operator_session_id: row.operator_session_id,
      };
    },

    reattach(stuck, session, terminal_id) {
      const { changes } = (
        db.prepare(
          `UPDATE payment_attempts SET operator_session_id = ?
            WHERE payment_attempt_id = ? AND operator_session_id = ? AND state = 'started'
              AND terminal_id = ?`,
        ) as Run
      ).run(session.id, stuck.payment_attempt_id, stuck.operator_session_id, terminal_id);
      if (changes !== 1) return;
      const row = (
        db.prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts a WHERE a.payment_attempt_id = ?`,
        ) as Get<AttemptRow>
      ).get(stuck.payment_attempt_id);
      if (row === undefined) return;
      auditEmitter.emitRaw({
        ...context(row),
        created_at: now(),
        action_category: 'payment.reattached',
        payment_attempt_id: row.payment_attempt_id,
        payload: {
          payment_attempt_id: row.payment_attempt_id,
          cart_id: row.envelope_cart_id,
          from_operator_session_id: stuck.operator_session_id,
          to_operator_session_id: session.id,
        },
      });
    },

    startedFor(session_id) {
      const row = (
        db.prepare(
          `SELECT payment_attempt_id FROM payment_attempts
            WHERE operator_session_id = ? AND state = 'started' LIMIT 1`,
        ) as Get<{ payment_attempt_id: string }>
      ).get(session_id);
      return row?.payment_attempt_id ?? null;
    },

    isSettled,
  };
}
