import { create } from 'zustand';

import type { PaymentIntentEnvelope } from '../../shared/cart/handoff-envelope.js';
import { freezeEnvelope } from '../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../shared/payments/types.js';

/**
 * 006-payments-tender — payment store.
 *
 * Two independent slices:
 *   - **envelope** (Slice 1): the frozen `PaymentIntentEnvelope` received
 *     from CartPane after a successful handoff.
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
}

const INITIAL: PaymentState = { envelope: null, paymentSlice: null, attemptHandoffId: null };

export const usePaymentStore = create<PaymentStore>((set) => ({
  ...INITIAL,
  mount: (envelope) => {
    // A different sale's envelope never inherits the previous attempt.
    set((s) =>
      s.attemptHandoffId !== null && s.attemptHandoffId !== envelope.handoff_action_id
        ? { envelope: freezeEnvelope(envelope), paymentSlice: null, attemptHandoffId: null }
        : { envelope: freezeEnvelope(envelope) },
    );
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
}));
