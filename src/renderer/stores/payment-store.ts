import { create } from 'zustand';

import type { PaymentIntentEnvelope } from '../../shared/cart/handoff-envelope.js';
import { freezeEnvelope } from '../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../shared/payments/types.js';

/**
 * 006-payments-tender — payment store.
 *
 * Two independent slices:
 *   - **envelope** (Slice 1): the frozen `PaymentIntentEnvelope` received
 *     from the Sale cart controller after a successful handoff.
 *   - **paymentSlice** (S3d / T150): a read-only mirror of the
 *     main-process `PaymentAttemptRendererView` projection returned by
 *     `payments.read` / `payments.subscribe`. Components own the bridge
 *     calls and dispatch into the store on each response. The store
 *     does NOT call the bridge itself (AD-1: main owns FSM).
 *
 * SECURITY: The envelope reference is frozen on mount. The payment
 * attempt projection is the renderer-minimised view (FR-017) — voucher
 * tokens, attribution_operator_id, and last_action_id are absent by
 * construction at the main-process projection layer; nothing here can
 * accidentally leak them.
 */

export interface PaymentState {
  envelope: Readonly<PaymentIntentEnvelope> | null;
  /**
   * Latest snapshot returned by `payments.read` or `payments.subscribe`.
   * Null when no attempt is active (initial state, or after `clearAttempt`).
   */
  paymentSlice: Readonly<PaymentAttemptRendererView> | null;
  /**
   * The handoff the current attempt belongs to (the envelope mounted when the
   * snapshot was applied). Lets a remounted checkout keep a started attempt
   * for the same sale instead of forgetting it while main still holds it.
   */
  attemptHandoffId: string | null;
  /**
   * RT-256 — external-card facts for the mounted handoff that must outlive a
   * Checkout remount and `clearAttempt` (a cancel clears the attempt):
   *   - `appliedCardLineIds`: card lines main confirmed applying (kept even when
   *     the follow-up read failed and the projection does not show them);
   *   - `cardApplyAttempted`: a card apply was sent for this handoff, whatever
   *     its outcome (a lost response may still mean main committed it);
   *   - `voidRequired`: a cancel reversed one of them locally, so the charge may
   *     still stand on the terminal (M-P13).
   * Renderer memory only: lost on restart, like the Undo token (RT-245).
   * Cleared when a different handoff is mounted, or on reset.
   */
  cardSafety: CardSafety | null;
  /**
   * RT-298 — cancel recovery for the mounted handoff's attempt, kept across a
   * Checkout remount so a retry still replays the same idempotency key and a
   * hold still closes payment actions:
   *   - `key`: the cancel key, minted once per attempt;
   *   - `hold`: `unconfirmed` (a cancel whose outcome main could not confirm) or
   *     `live_tender` (force-failed with live tender: main refuses any payment).
   * Renderer memory only. Cleared when a different handoff is mounted, on
   * reset, or once a cancel outcome is applied.
   */
  cancelRecovery: CancelRecovery | null;
}

export type CancelHold = 'none' | 'unconfirmed' | 'live_tender';

export interface CancelRecovery {
  readonly handoffId: string;
  readonly attemptId: string;
  readonly key: string;
  readonly hold: CancelHold;
}

export interface CardSafety {
  readonly handoffId: string;
  readonly appliedCardLineIds: readonly string[];
  readonly cardApplyAttempted: boolean;
  readonly voidRequired: boolean;
}

export interface PaymentStore extends PaymentState {
  /** Freeze and store the envelope. Idempotent: re-mounting with a new envelope replaces the old one. */
  mount(envelope: PaymentIntentEnvelope): void;
  /**
   * Apply a fresh snapshot from `payments.read` or `payments.subscribe`.
   * Re-applying with a new snapshot replaces the prior one; this is how
   * state transitions (started → settled / cancelled / failed) reach
   * the renderer.
   */
  applyAttemptSnapshot(view: PaymentAttemptRendererView): void;
  /** Clear only the paymentSlice (leaves the Slice-1 envelope intact). */
  clearAttempt(): void;
  /** Clear both slices (e.g. on void or new cart). */
  reset(): void;
  /** RT-256 — a card apply was sent for the mounted handoff (outcome unknown yet). */
  recordCardApplyAttempted(): void;
  /** RT-256 — main confirmed a card line for the mounted handoff. */
  recordCardApplied(tenderLineId: string): void;
  /** RT-256 — a cancel reversed a card line of the mounted handoff (M-P13). */
  markCardVoidRequired(): void;
  /** RT-298 — the cancel key for `attemptId`: minted once, then reused by every retry. */
  cancelKeyFor(attemptId: string): string;
  /** RT-298 — set the hold on the recorded cancel (no-op when none is recorded). */
  setCancelHold(hold: CancelHold): void;
  /** RT-298 — a cancel outcome was applied: forget the key and any hold. */
  clearCancelRecovery(): void;
}

/** The card-safety record for `handoffId`, starting fresh for a different handoff. */
function cardSafetyFor(current: CardSafety | null, handoffId: string): CardSafety {
  return current?.handoffId === handoffId
    ? current
    : { handoffId, appliedCardLineIds: [], cardApplyAttempted: false, voidRequired: false };
}

const INITIAL: PaymentState = {
  envelope: null,
  paymentSlice: null,
  attemptHandoffId: null,
  cardSafety: null,
  cancelRecovery: null,
};

export const usePaymentStore = create<PaymentStore>((set, get) => ({
  ...INITIAL,
  mount: (envelope) => {
    // A different sale's envelope never inherits the previous attempt.
    set((s) => {
      const same = (handoffId: string | undefined): boolean =>
        handoffId === envelope.handoff_action_id;
      const cardSafety = same(s.cardSafety?.handoffId) ? s.cardSafety : null;
      const cancelRecovery = same(s.cancelRecovery?.handoffId) ? s.cancelRecovery : null;
      return s.attemptHandoffId !== null && s.attemptHandoffId !== envelope.handoff_action_id
        ? {
            envelope: freezeEnvelope(envelope),
            paymentSlice: null,
            attemptHandoffId: null,
            cardSafety,
            cancelRecovery,
          }
        : { envelope: freezeEnvelope(envelope), cardSafety, cancelRecovery };
    });
  },
  applyAttemptSnapshot: (view) => {
    set((s) => ({ paymentSlice: view, attemptHandoffId: s.envelope?.handoff_action_id ?? null }));
  },
  clearAttempt: () => {
    set({ paymentSlice: null, attemptHandoffId: null });
  },
  reset: () => {
    set({ ...INITIAL });
  },
  recordCardApplyAttempted: () => {
    set((s) => {
      const handoffId = s.envelope?.handoff_action_id;
      if (handoffId === undefined) return {};
      return {
        cardSafety: { ...cardSafetyFor(s.cardSafety, handoffId), cardApplyAttempted: true },
      };
    });
  },
  recordCardApplied: (tenderLineId) => {
    set((s) => {
      const handoffId = s.envelope?.handoff_action_id;
      if (handoffId === undefined) return {};
      const record = cardSafetyFor(s.cardSafety, handoffId);
      if (record.appliedCardLineIds.includes(tenderLineId)) return { cardSafety: record };
      return {
        cardSafety: { ...record, appliedCardLineIds: [...record.appliedCardLineIds, tenderLineId] },
      };
    });
  },
  markCardVoidRequired: () => {
    set((s) => {
      const handoffId = s.envelope?.handoff_action_id;
      if (handoffId === undefined) return {};
      return { cardSafety: { ...cardSafetyFor(s.cardSafety, handoffId), voidRequired: true } };
    });
  },
  cancelKeyFor: (attemptId) => {
    const s = get();
    const handoffId = s.envelope?.handoff_action_id;
    const held = s.cancelRecovery;
    if (held?.handoffId === handoffId && held?.attemptId === attemptId) return held.key;
    const key = crypto.randomUUID();
    if (handoffId !== undefined) {
      set({ cancelRecovery: { handoffId, attemptId, key, hold: 'none' } });
    }
    return key;
  },
  setCancelHold: (hold) => {
    set((s) =>
      s.cancelRecovery === null ? {} : { cancelRecovery: { ...s.cancelRecovery, hold } },
    );
  },
  clearCancelRecovery: () => {
    set({ cancelRecovery: null });
  },
}));
