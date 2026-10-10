import type { OperatorBridgeAPI } from '../../shared/bridge-api';
import { useCartStore } from '../stores/cart-store';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../stores/operator-session-store';

/**
 * RT-352 (RT-116 §3.1, RT-115 D3.2) — enter a signed-in session with its cart.
 *
 * Main re-attaches the operator's held draft cart to the new session while
 * it creates that session. Here the renderer asks which cart the session
 * holds and adopts it BEFORE the session store turns `signedIn`, so the Sale
 * screen (which a cashier lands on at once) mounts with the cart already
 * active and reads its lines back through `cart.snapshot`. No cart is
 * created here.
 *
 * Both ways into `signedIn` go through here: a sign-in answer
 * ({@link completeSignIn}) and the boot hydration of a session main already
 * holds, e.g. after a renderer reload ({@link completeHydratedSignIn}).
 *
 * A failing or missing read enters with no cart. The draft then stays bound
 * to this session in main, and it re-attaches at the next sign-in after the
 * session ends. If the store refuses the transition (main ended a sign-in's
 * session before its answer arrived), the adopted cart is dropped with it.
 */

type ResumeReader = Pick<OperatorBridgeAPI, 'getResumeState'>;
type HydrationReader = Pick<OperatorBridgeAPI, 'getResumeState' | 'getCurrentSession'>;

function readResumeCartId(operator: ResumeReader): Promise<string | null> | null {
  const read = operator.getResumeState;
  if (read === undefined) return null;
  return read().then(
    (view) => view.cart_id,
    () => null,
  );
}

function adoptAndEnter(cart_id: string | null, enter: () => void): void {
  const cartStore = useCartStore.getState();
  const adopted = cart_id !== null && cartStore.activeCart === null;
  // Same shape as a confirmed create; the Sale screen's snapshot read sets the real state.
  if (adopted) cartStore.applyCartCreated(cart_id);
  enter();
  if (adopted && useOperatorSessionStore.getState().state.kind !== 'signedIn') {
    useCartStore.getState().reset();
  }
}

function enterWithResumedCart(operator: ResumeReader, enter: () => void): Promise<void> {
  const pending = readResumeCartId(operator);
  if (pending === null) {
    adoptAndEnter(null, enter);
    return Promise.resolve();
  }
  return pending.then((cart_id) => {
    adoptAndEnter(cart_id, enter);
  });
}

/** A sign-in answered `signed_in`. */
export function completeSignIn(
  operator: ResumeReader,
  session: OperatorSessionView,
  notice?: { closed_at: string },
): Promise<void> {
  return enterWithResumedCart(operator, () => {
    useOperatorSessionStore.getState().resolveSignedIn(session, notice);
  });
}

/** True while main still holds `session_id`; a failing read counts as gone. */
async function stillHeldByMain(operator: HydrationReader, session_id: string): Promise<boolean> {
  const current = await operator.getCurrentSession().catch(() => null);
  return current?.id === session_id;
}

/**
 * Boot hydration: main already holds `session` (dev bypass, renderer reload).
 * While signedOut the store ignores main's session-state pushes, so a session
 * that ends during the resume read is re-checked here; it is never hydrated.
 */
export async function completeHydratedSignIn(
  operator: HydrationReader,
  session: OperatorSessionView,
): Promise<void> {
  const hydrate = (): void => {
    useOperatorSessionStore.getState().hydrateSignedIn(session);
  };
  const pending = readResumeCartId(operator);
  if (pending === null) {
    adoptAndEnter(null, hydrate);
    return;
  }
  const cart_id = await pending;
  if (await stillHeldByMain(operator, session.id)) adoptAndEnter(cart_id, hydrate);
}
