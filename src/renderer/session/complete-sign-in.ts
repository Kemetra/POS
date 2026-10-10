import type { OperatorBridgeAPI } from '../../shared/bridge-api';
import { useCartStore } from '../stores/cart-store';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../stores/operator-session-store';

/**
 * RT-352 (RT-116 §3.1, RT-115 D3.2) — finish an admitted sign-in.
 *
 * Main re-attaches the operator's held draft cart to the new session while
 * it creates that session. Here the renderer asks which cart that was and
 * adopts it BEFORE the session store turns `signedIn`, so the Sale screen
 * (which a cashier lands on at once) mounts with the cart already active and
 * reads its lines back through `cart.snapshot`. No cart is created here.
 *
 * A failing or missing read signs in with nothing to resume; the cart stays
 * held in main for the next sign-in. If main ended the session before this
 * answer arrived, the store refuses the stale sign-in and the adopted cart
 * is dropped with it.
 */

type ResumeReader = Pick<OperatorBridgeAPI, 'getResumeState'>;

function readResumeCartId(operator: ResumeReader): Promise<string | null> | null {
  const read = operator.getResumeState;
  if (read === undefined) return null;
  return read().then(
    (view) => view.cart_id,
    () => null,
  );
}

function adoptAndSignIn(
  cart_id: string | null,
  session: OperatorSessionView,
  notice: { closed_at: string } | undefined,
): void {
  const cartStore = useCartStore.getState();
  const adopted = cart_id !== null && cartStore.activeCart === null;
  // Same shape as a confirmed create; the Sale screen's snapshot read sets the real state.
  if (adopted) cartStore.applyCartCreated(cart_id);
  useOperatorSessionStore.getState().resolveSignedIn(session, notice);
  if (adopted && useOperatorSessionStore.getState().state.kind !== 'signedIn') {
    useCartStore.getState().reset();
  }
}

export function completeSignIn(
  operator: ResumeReader,
  session: OperatorSessionView,
  notice?: { closed_at: string },
): Promise<void> {
  const pending = readResumeCartId(operator);
  if (pending === null) {
    adoptAndSignIn(null, session, notice);
    return Promise.resolve();
  }
  return pending.then((cart_id) => {
    adoptAndSignIn(cart_id, session, notice);
  });
}
