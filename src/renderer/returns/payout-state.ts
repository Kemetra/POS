import type {
  ReturnDrawerFailure,
  ReturnJournalView,
  ReturnPayoutMethod,
  ReturnSlipStatus,
  ReturnsPayoutResponse,
  ReturnsRefusalReason,
  ReturnsReprintResponse,
} from '../../shared/returns/types.js';
import { CALL_FAILED } from './returns-bridge.js';

/**
 * RT-15 S4 — the payout panel's state, as pure data and transitions.
 *
 * The renderer holds only what main answered (the journal row and the payout
 * outcome); it never computes an amount or decides that cash was paid.
 *
 *   ready         confirmed, no payout started: one action, "pay out".
 *   interrupted   a payout was started and not completed (a crash, a lock,
 *                 another window): never a fresh start; complete it after
 *                 checking the drawer and the customer.
 *   drawer_failed the drawer did not open just now; nothing was recorded.
 *   confirm_manual the explicit second step before recording a manual payout.
 *   paid          main recorded the payout (`slip` null when not known here).
 *   refused       main refused; nothing was done.
 *   unknown       the call was rejected: the result is not known.
 */
export type PayoutPhase =
  | { readonly kind: 'ready' }
  /** `retryable`: the last kick provably never reached the drawer (P1). */
  | { readonly kind: 'interrupted'; readonly retryable: boolean }
  | {
      readonly kind: 'drawer_failed';
      readonly reason: ReturnDrawerFailure;
      /** Only "no drawer configured" proves the kick never left (P1). */
      readonly retryable: boolean;
    }
  | { readonly kind: 'confirm_manual'; readonly back: ManualOrigin }
  | {
      readonly kind: 'paid';
      readonly slip: ReturnSlipStatus | null;
      readonly method: ReturnPayoutMethod | null;
    }
  | { readonly kind: 'refused'; readonly reason: ReturnsRefusalReason }
  /** Codex P2 (49e0277): refused for now (a kick in flight, a session change): refresh. */
  | { readonly kind: 'wait'; readonly reason: TransientRefusal }
  | { readonly kind: 'unknown' };

/**
 * Refusals that hold only for now: a drawer kick in flight (possibly in
 * another instance), another return's payout on this terminal, or a session that locked, ended or changed. Waiting and
 * refreshing re-derives the next step; every other refusal is final here.
 */
const TRANSIENT_REFUSALS = [
  'drawer_kick_in_progress',
  'another_payout_in_progress',
  'session_changed',
  'no_session',
  'offline',
] as const satisfies readonly ReturnsRefusalReason[];
export type TransientRefusal = (typeof TRANSIENT_REFUSALS)[number];

function isTransient(reason: ReturnsRefusalReason): reason is TransientRefusal {
  return (TRANSIENT_REFUSALS as readonly ReturnsRefusalReason[]).includes(reason);
}

/** Where a manual payout can be asked from (and returned to on cancel). */
export type ManualOrigin = Extract<PayoutPhase, { kind: 'drawer_failed' | 'interrupted' }>;

/**
 * What a reprint answered, each kept distinct: only `print_failed` is a
 * printer failure. A refusal may come after a copy printed (the session
 * changed during the print), and a rejected call has no known result.
 */
export type ReprintResult =
  | { readonly kind: 'printed' }
  | { readonly kind: 'print_failed' }
  | { readonly kind: 'refused'; readonly reason: ReturnsRefusalReason }
  | { readonly kind: 'unknown' };

export interface PayoutState {
  readonly ret: ReturnJournalView;
  readonly phase: PayoutPhase;
  /** The last reprint's result on this panel, if any. */
  readonly reprint: ReprintResult | null;
}

/** The phase a journal row implies on its own (no live call result). */
function phaseOf(ret: ReturnJournalView): PayoutPhase {
  if (ret.state === 'paid_out') {
    return { kind: 'paid', slip: null, method: ret.payout?.method ?? null };
  }
  if (ret.payout === null) return { kind: 'ready' };
  const { kick } = ret.payout;
  return { kind: 'interrupted', retryable: kick === 'none' || kick === 'failed_before_send' };
}

export function initialPayout(ret: ReturnJournalView): PayoutState {
  return { ret, phase: phaseOf(ret), reprint: null };
}

/**
 * How far a return's payout has moved, as a rank that only grows: not
 * started < started < paid out; within a started payout, each kick counts
 * twice (sent, then its outcome recorded). The journal only moves forward.
 */
export function payoutRevision(ret: ReturnJournalView): readonly [number, number] {
  const p = ret.payout;
  if (ret.state === 'paid_out') return [2, 0];
  if (p === null) return [0, 0];
  if (p.kickCount === 0) return [1, 0];
  return [1, p.kickCount * 2 - (p.kickPending ? 1 : 0)];
}

function isNewer(ret: ReturnJournalView, than: ReturnJournalView): boolean {
  const [a, b] = payoutRevision(ret);
  const [x, y] = payoutRevision(than);
  return a > x || (a === x && b > y);
}

/**
 * Codex P2 (c21d7e2) + reviewer P2 (49e0277): a strictly newer view of the
 * panel's return (another window or instance moved its payout) replaces the
 * panel's state, so a stale action (a fresh `start`) is never offered. The
 * same or an older view (a stale list, the original outcome) is ignored: a
 * panel never moves back.
 */
export function synced(s: PayoutState, ret: ReturnJournalView): PayoutState {
  return isNewer(ret, s.ret) ? initialPayout(ret) : s;
}

function afterRefusal(
  state: PayoutState,
  reason: ReturnsRefusalReason,
  ret: ReturnJournalView | null,
) {
  const row = ret ?? state.ret;
  // R3: a payout started elsewhere is completed, never started afresh; P1: a
  // drawer that may have opened is never kicked again (manual only).
  if (reason === 'payout_started' || reason === 'drawer_retry_unsafe') {
    return { ret: row, phase: phaseOf(row), reprint: null };
  }
  const phase: PayoutPhase = isTransient(reason)
    ? { kind: 'wait', reason }
    : { kind: 'refused', reason };
  return { ret: row, phase, reprint: null };
}

export function afterPayout(
  state: PayoutState,
  res: ReturnsPayoutResponse | typeof CALL_FAILED,
): PayoutState {
  if (res === CALL_FAILED) return { ...state, phase: { kind: 'unknown' } };
  switch (res.kind) {
    case 'paid_out':
      return {
        ret: res.ret,
        phase: { kind: 'paid', slip: res.slip, method: res.method },
        reprint: null,
      };
    case 'drawer_failed': {
      const retryable = res.reason === 'no_drawer_configured';
      return {
        ret: res.ret,
        phase: { kind: 'drawer_failed', reason: res.reason, retryable },
        reprint: null,
      };
    }
    case 'refused':
      return afterRefusal(state, res.reason, res.ret);
  }
}

/** R2: the explicit second step before a manual payout is recorded. */
export function askManual(state: PayoutState): PayoutState {
  const { phase } = state;
  if (phase.kind !== 'drawer_failed' && phase.kind !== 'interrupted') return state;
  return { ...state, phase: { kind: 'confirm_manual', back: phase } };
}

export function cancelManual(state: PayoutState): PayoutState {
  if (state.phase.kind !== 'confirm_manual') return state;
  return { ...state, phase: state.phase.back };
}

/**
 * After an unknown result or a wait: what the journal now says about this
 * return (never an older view than the panel already holds).
 */
export function refreshed(state: PayoutState, row: ReturnJournalView | undefined): PayoutState {
  if (row === undefined) return state;
  return initialPayout(isNewer(state.ret, row) ? state.ret : row);
}

/** A reprint answer (or a rejected call) as its own closed result. */
export function reprintResult(res: ReturnsReprintResponse | typeof CALL_FAILED): ReprintResult {
  if (res === CALL_FAILED) return { kind: 'unknown' };
  return res.kind === 'refused' ? { kind: 'refused', reason: res.reason } : { kind: res.kind };
}

export function afterReprint(
  state: PayoutState,
  res: ReturnsReprintResponse | typeof CALL_FAILED,
): PayoutState {
  return { ...state, reprint: reprintResult(res) };
}
