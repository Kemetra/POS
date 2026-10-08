import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import {
  installDrawerNoticeSignOutHook,
  useDrawerNoticeStore,
  type DrawerNoticeFailure,
} from '../drawer-notice-store';

/**
 * RT-241 — D-B1 drawer notice lifetime (freeze 15 §7 Lane C, owner-approved).
 *
 * Main projects a drawer failure until a later successful drawer event on the
 * terminal, across sessions and restarts (N-08). D-B1 shows it only for a sale
 * completed now, and clears it on acknowledgement or the next successful drawer
 * event. The renderer cannot tie a finalized sale to the payment on screen
 * (X-4), so "now" is "appeared after this session's first known projection":
 * the first `ok` read is the baseline, and a failure already in it is old.
 */

const failure = (sale_id: string): DrawerNoticeFailure => ({
  sale_id,
  last_successful_open_at: null,
});

const store = (): ReturnType<typeof useDrawerNoticeStore.getState> =>
  useDrawerNoticeStore.getState();

beforeEach(() => {
  store().reset();
});

describe('drawer notice store', () => {
  it.each<[string, Array<DrawerNoticeFailure | null>, string | null]>([
    [
      'the first known projection is the baseline: an old failure is not shown',
      [failure('old')],
      null,
    ],
    ['no failure at baseline, then one appears: shown', [null, failure('s1')], 's1'],
    ['an old failure stays hidden on every later read', [failure('old'), failure('old')], null],
    ['a new failure after an old one: shown', [failure('old'), failure('s1')], 's1'],
    [
      'the next successful drawer event (projection clears): gone',
      [null, failure('s1'), null],
      null,
    ],
  ])('%s', (_label, snapshots, shown) => {
    for (const snapshot of snapshots) store().observe(snapshot);
    expect(store().active?.sale_id ?? null).toBe(shown);
  });

  it('acknowledgement hides it, and it stays hidden on later reads', () => {
    store().observe(null);
    store().observe(failure('s1'));
    store().acknowledge();
    expect(store().active).toBeNull();
    store().observe(failure('s1'));
    expect(store().active).toBeNull();
  });

  it('a second failure after an acknowledgement is shown', () => {
    store().observe(null);
    store().observe(failure('s1'));
    store().acknowledge();
    store().observe(failure('s2'));
    expect(store().active?.sale_id).toBe('s2');
  });

  it('acknowledging with nothing shown does nothing', () => {
    store().observe(null);
    store().acknowledge();
    store().observe(failure('s1'));
    expect(store().active?.sale_id).toBe('s1');
  });

  it('reset re-takes the baseline: the failure on screen before it is old after it', () => {
    store().observe(null);
    store().observe(failure('s1'));
    store().reset();
    store().observe(failure('s1'));
    expect(store().active).toBeNull();
  });
});

describe('sign-out resets the notice (no persistence across sessions)', () => {
  let detach: () => void = () => undefined;

  afterEach(() => {
    detach();
    useOperatorSessionStore.getState().reset();
  });

  function signIn(): void {
    useOperatorSessionStore.setState({
      state: {
        kind: 'signedIn',
        session: {
          session_id: 'sess-1',
          role: 'cashier',
          display_name: 'كاشير',
          signed_in_at: '2026-10-08T09:00:00.000Z',
          backend_session_id: '',
        },
      },
    } as never);
  }

  it('leaving signedIn clears the notice and re-takes the baseline', () => {
    signIn();
    detach = installDrawerNoticeSignOutHook();
    store().observe(null);
    store().observe(failure('s1'));
    expect(store().active).not.toBeNull();

    useOperatorSessionStore.getState().reset();
    expect(store().active).toBeNull();

    // The next session's first read still shows s1 in the projection: old now.
    store().observe(failure('s1'));
    expect(store().active).toBeNull();
  });

  it('a session-store update that stays signed in does not reset', () => {
    signIn();
    detach = installDrawerNoticeSignOutHook();
    store().observe(null);
    store().observe(failure('s1'));
    signIn();
    expect(store().active?.sale_id).toBe('s1');
  });
});
