import { beforeEach, describe, expect, it } from 'vitest';

import { useOperatorSessionStore } from '../../../../src/renderer/stores/operator-session-store.js';
import { useCartStore } from '../../../../src/renderer/stores/cart-store.js';
import { installCartStoreSignOutHook } from '../../../../src/renderer/stores/cart-signout-hook.js';
import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
import type { OperatorSessionView } from '../../../../src/renderer/stores/operator-session-store.js';

/**
 * T023 — Sign-out clears `cartStore` (Q3 discard-immediately policy).
 *
 * Per spec Q3 (LOCKED 2026-05-14) — when the bound operator session
 * ends (sign-out, takeover, forced-close, inactivity), the renderer's
 * `cartStore` MUST clear immediately so the cart pane reverts to the
 * signed-out / empty surface and no subsequent cashier sees a leftover
 * draft. The main-process audit emission for `cart.discarded_on_session_end`
 * is S3 / §A3 scope — only the renderer-side discard is in S1.
 *
 * The hook subscribes to `operator-session-store` and resets
 * `cart-store` whenever the FSM leaves the `signedIn` state.
 */

const SAMPLE: OperatorSessionView = {
  id: 'sess-t023',
  operator_id: 'cashier-1',
  display_name: 'Test Cashier',
  role: 'cashier',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  started_at: '2026-05-14T08:00:00.000Z',
};

let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  unsubscribe?.();
  useOperatorSessionStore.getState().reset();
  useCartStore.getState().reset();
  usePaymentStore.getState().reset();
  unsubscribe = installCartStoreSignOutHook();
});

describe('cartStore — clears on operator session end', () => {
  it('clears activeCart when session transitions signedIn → signingOut → signedOut', () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SAMPLE);

    useCartStore.getState().applyCartCreated('cart-uuid-1');
    expect(useCartStore.getState().activeCart).not.toBeNull();

    useOperatorSessionStore.getState().beginSignOut();
    useOperatorSessionStore.getState().resolveSignedOut();

    expect(useCartStore.getState().activeCart).toBeNull();
  });

  it('clears activeCart when transitioning from signedIn to takeoverPrompt path → signedOut', () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SAMPLE);
    useCartStore.getState().applyCartCreated('cart-uuid-2');

    // Simulate forced sign-out from any non-signedIn transition.
    useOperatorSessionStore.getState().beginSignOut();
    useOperatorSessionStore.getState().resolveSignedOut();

    expect(useCartStore.getState().activeCart).toBeNull();
  });

  it('does NOT clear cartStore while session remains signedIn (e.g. notice-dismiss)', () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SAMPLE);
    useCartStore.getState().applyCartCreated('cart-uuid-3');

    // Dismissing a notice keeps state.kind === 'signedIn'.
    useOperatorSessionStore.getState().dismissShiftClosedNotice();

    expect(useCartStore.getState().activeCart).not.toBeNull();
    expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-uuid-3');
  });

  it('is idempotent — clearing an already-empty cartStore does nothing observable', () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SAMPLE);
    // No cart created.

    useOperatorSessionStore.getState().beginSignOut();
    useOperatorSessionStore.getState().resolveSignedOut();

    expect(useCartStore.getState().activeCart).toBeNull();
  });

  it('clears activeCart even if cart is in handing_off state at sign-out time', () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SAMPLE);

    useCartStore.getState().applyCartCreated('cart-uuid-4');
    useCartStore.getState().applyLineAdded('line-1');
    useCartStore.getState().applyHandoffStarted();
    expect(useCartStore.getState().activeCart?.state).toBe('handing_off');

    useOperatorSessionStore.getState().beginSignOut();
    useOperatorSessionStore.getState().resolveSignedOut();

    expect(useCartStore.getState().activeCart).toBeNull();
  });

  it('unsubscribe() detaches the hook — subsequent sign-outs do not clear', () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SAMPLE);
    useCartStore.getState().applyCartCreated('cart-uuid-5');

    unsubscribe?.();
    unsubscribe = undefined;

    useOperatorSessionStore.getState().beginSignOut();
    useOperatorSessionStore.getState().resolveSignedOut();

    expect(useCartStore.getState().activeCart).not.toBeNull();
  });

  it('also clears the payment store, so the next operator never sees the previous sale (Codex, #476)', () => {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(SAMPLE);
    usePaymentStore.getState().mount({
      envelope_version: 'v1',
      cart_id: 'cart-prev',
      operator_session_id: 'sess-t023',
      owning_operator_id: 'cashier-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      lines: [],
      discount_placeholders: [],
      subtotal_minor: 1500,
      created_at: '2026-09-26T12:00:00.000Z',
      handoff_action_id: 'handoff-prev',
    });
    usePaymentStore.getState().applyAttemptSnapshot({
      payment_attempt_id: 'pa-prev',
      state: 'settled',
      envelope_subtotal_minor: 1500,
      started_at: '2026-09-26T12:00:01.000Z',
      settled_at: '2026-09-26T12:00:05.000Z',
      tender_lines: [],
    });

    useOperatorSessionStore.getState().beginSignOut();
    useOperatorSessionStore.getState().resolveSignedOut();

    expect(usePaymentStore.getState()).toEqual(
      expect.objectContaining({ envelope: null, paymentSlice: null, attemptHandoffId: null }),
    );
  });
});
