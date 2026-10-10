import { useCartStore } from './cart-store.js';
import { useOperatorSessionStore } from './operator-session-store.js';
import { usePaymentStore } from './payment-store.js';

/**
 * 005-sales-cart S1 / Q3 — sign-out clears cartStore.
 *
 * Subscribes to `operator-session-store`; when the session FSM leaves
 * the `signedIn` state for any reason (sign-out, takeover-prompt,
 * forced-close, inactivity), the cart store is reset.
 *
 * The renderer forgets the cart; main does not discard it. RT-115 D3.2
 * (RT-352) superseded the 005 Q3 discard: main holds the draft for its
 * operator on this terminal and re-attaches it at that operator's next
 * sign-in, which the renderer adopts through `completeSignIn`.
 *
 * Returns the unsubscribe function so tests can detach the hook and
 * mounts can clean up on unmount.
 *
 * The hook is installed once at renderer boot (from `src/renderer/main.tsx`).
 */
export function installCartStoreSignOutHook(): () => void {
  let wasSignedIn = useOperatorSessionStore.getState().state.kind === 'signedIn';

  return useOperatorSessionStore.subscribe((newState) => {
    const isSignedIn = newState.state.kind === 'signedIn';
    if (wasSignedIn && !isSignedIn) {
      useCartStore.getState().reset();
      // The payment envelope and attempt belong to the ending session too:
      // the next operator must never resume or see the previous sale (#476).
      usePaymentStore.getState().reset();
    }
    wasSignedIn = isSignedIn;
  });
}
