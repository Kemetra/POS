import { beforeEach, describe, expect, it, vi } from 'vitest';

import { completeHydratedSignIn, completeSignIn } from '../complete-sign-in';
import { useCartStore } from '../../stores/cart-store';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../../stores/operator-session-store';
import type { LockStateView, ResumeStateView } from '../../../shared/bridge-api';

/**
 * RT-352 — the renderer adopts the draft main re-attached at sign-in BEFORE
 * the session store routes into the Sale screen, so the Sale screen's
 * existing `hydrateActiveCart` path reads its lines back.
 */

const SESSION = {
  id: 'session-1',
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
type StateListener = (event: { state: 'active' | 'locked' | 'ended' }) => void;

/** A main-side fake for boot hydration: lock state, its push, and the session re-read. */
function hydrationOperator(opts: { locked?: boolean; current?: () => Promise<unknown> } = {}) {
  let listener: StateListener | null = null;
  const getResumeState = vi.fn(() => Promise.resolve(resume({ cart_id: 'cart-9' })));
  return {
    getResumeState,
    getCurrentSession: (opts.current ??
      (() => Promise.resolve(SESSION))) as () => Promise<OperatorSessionView | null>,
    getLockState: () =>
      Promise.resolve({ state: opts.locked === true ? 'locked' : 'active' } as LockStateView),
    onSessionStateChanged: (cb: StateListener) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    push: (state: 'active' | 'locked' | 'ended') => listener?.({ state }),
  };
}

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
        return completeHydratedSignIn(hydrationOperator(), SESSION);
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
    await completeHydratedSignIn(hydrationOperator(), SESSION); // store is signingIn (beforeEach)
    expect(useOperatorSessionStore.getState().state.kind).toBe('signingIn');
    expect(useCartStore.getState().activeCart).toBeNull();
  });
});

describe('RT-352 completeHydratedSignIn — the session ends during the resume read', () => {
  beforeEach(() => {
    useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  });

  it.each([
    { name: 'main holds no session any more', current: () => Promise.resolve(null) },
    {
      name: 'main holds another session',
      current: () => Promise.resolve({ ...SESSION, id: 'session-2' }),
    },
    { name: 'the re-check fails', current: () => Promise.reject(new Error('ipc')) },
  ])('never hydrates when $name', async ({ current }) => {
    await completeHydratedSignIn(hydrationOperator({ current }), SESSION);

    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
    expect(useCartStore.getState().activeCart).toBeNull();
  });

  it('hydrates at once, without a re-check, when the bridge has no resume read', async () => {
    const getCurrentSession = vi.fn(() => Promise.resolve(null));
    const { getLockState, onSessionStateChanged } = hydrationOperator();
    await completeHydratedSignIn(
      { getCurrentSession, getLockState, onSessionStateChanged },
      SESSION,
    );
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    expect(getCurrentSession).not.toHaveBeenCalled();
  });
});

describe('RT-352 completeHydratedSignIn — reload while the session is locked', () => {
  beforeEach(() => {
    useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  });

  it('waits for the unlock, then reads and adopts the cart', async () => {
    const operator = hydrationOperator({ locked: true });
    const done = completeHydratedSignIn(operator, SESSION);
    await Promise.resolve();
    await Promise.resolve();
    expect(operator.getResumeState).not.toHaveBeenCalled();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');

    operator.push('active');
    await done;

    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    expect(useCartStore.getState().activeCart?.cart_id).toBe('cart-9');
  });

  it('never hydrates when the locked session ends instead of unlocking', async () => {
    const operator = hydrationOperator({ locked: true, current: () => Promise.resolve(null) });
    const done = completeHydratedSignIn(operator, SESSION);
    await Promise.resolve();
    operator.push('ended');
    await done;

    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
    expect(useCartStore.getState().activeCart).toBeNull();
  });
});
