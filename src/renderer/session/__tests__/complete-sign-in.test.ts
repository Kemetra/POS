import { beforeEach, describe, expect, it, vi } from 'vitest';

import { completeHydratedSignIn, completeSignIn } from '../complete-sign-in';
import { useCartStore } from '../../stores/cart-store';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../../stores/operator-session-store';
import type { ResumeStateView } from '../../../shared/bridge-api';

/**
 * RT-352 — the renderer adopts the draft main re-attached at sign-in BEFORE
 * the session store routes into the Sale screen, so the Sale screen's
 * existing `hydrateActiveCart` path reads its lines back.
 */

const SESSION = {
  operator_id: 'cashier-1',
  display_name: 'Cashier One',
  role: 'cashier',
} as unknown as OperatorSessionView;

function resume(view: Partial<ResumeStateView>): ResumeStateView {
  return { cart_id: null, payment_attempt_id: null, other_held_cart_count: 0, ...view };
}

beforeEach(() => {
  useCartStore.getState().reset();
  useOperatorSessionStore.setState({
    state: { kind: 'signedOut' },
    signInAttempt: 0,
    endedAttempt: null,
  });
  useOperatorSessionStore.getState().beginSignIn();
});

const RESUME_CART_9 = { getResumeState: () => Promise.resolve(resume({ cart_id: 'cart-9' })) };

describe('RT-352 — the cart is adopted before the session turns signedIn', () => {
  it.each([
    {
      name: 'a sign-in answer',
      enter: () => completeSignIn(RESUME_CART_9, SESSION),
    },
    {
      name: 'a boot hydration (renderer reload, dev bypass)',
      enter: () => {
        useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
        return completeHydratedSignIn(RESUME_CART_9, SESSION);
      },
    },
  ])('on $name', async ({ enter }) => {
    let cartWhenSignedIn: string | null | undefined;
    const unsubscribe = useOperatorSessionStore.subscribe((s) => {
      if (s.state.kind === 'signedIn') {
        cartWhenSignedIn = useCartStore.getState().activeCart?.cart_id;
      }
    });

    await enter();
    unsubscribe();

    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    expect(cartWhenSignedIn).toBe('cart-9');
  });
});

describe('RT-352 completeSignIn', () => {
  it.each([
    { name: 'nothing to resume', operator: { getResumeState: () => Promise.resolve(resume({})) } },
    {
      name: 'a failing read',
      operator: { getResumeState: () => Promise.reject(new Error('ipc')) },
    },
  ])('signs in with no cart on $name', async ({ operator }) => {
    await completeSignIn(operator, SESSION);

    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    expect(useCartStore.getState().activeCart).toBeNull();
  });

  it('signs in synchronously when the bridge has no resume read', () => {
    void completeSignIn({}, SESSION);
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
  });

  it('forwards the forced-close notice', async () => {
    await completeSignIn({}, SESSION, { closed_at: '2026-10-10T10:00:00.000Z' });
    const state = useOperatorSessionStore.getState().state;
    expect(state.kind === 'signedIn' && state.forced_close_notice).toEqual({
      closed_at: '2026-10-10T10:00:00.000Z',
    });
  });

  it('drops the adopted cart when main ended the session before the answer arrived', async () => {
    useOperatorSessionStore.setState({
      endedAttempt: useOperatorSessionStore.getState().signInAttempt,
    });
    const getResumeState = vi.fn(() => Promise.resolve(resume({ cart_id: 'cart-9' })));

    await completeSignIn({ getResumeState }, SESSION);

    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
    expect(useCartStore.getState().activeCart).toBeNull();
  });

  it('never replaces a cart the renderer already holds', async () => {
    useCartStore.getState().applyCartCreated('cart-current');
    await completeSignIn(
      { getResumeState: () => Promise.resolve(resume({ cart_id: 'cart-9' })) },
      SESSION,
    );
    expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-current');
  });
});

describe('RT-352 completeHydratedSignIn', () => {
  it('drops the adopted cart when the store is no longer signedOut', async () => {
    await completeHydratedSignIn(RESUME_CART_9, SESSION); // store is signingIn (beforeEach)
    expect(useOperatorSessionStore.getState().state.kind).toBe('signingIn');
    expect(useCartStore.getState().activeCart).toBeNull();
  });
});
