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
};

export const usePaymentStore = create<PaymentStore>((set) => ({
  ...INITIAL,
  mount: (envelope) => {
    // A different sale's envelope never inherits the previous attempt.
    set((s) => {
      const cardSafety =
        s.cardSafety?.handoffId === envelope.handoff_action_id ? s.cardSafety : null;
      return s.attemptHandoffId !== null && s.attemptHandoffId !== envelope.handoff_action_id
        ? {
            envelope: freezeEnvelope(envelope),
            paymentSlice: null,
            attemptHandoffId: null,
            cardSafety,
          }
        : { envelope: freezeEnvelope(envelope), cardSafety };
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
}));
