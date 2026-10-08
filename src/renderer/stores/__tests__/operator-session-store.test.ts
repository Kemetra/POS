import { afterEach, describe, expect, it } from 'vitest';

import { useOperatorSessionStore, type OperatorSessionView } from '../operator-session-store.js';

/**
 * 004-operator-session T011 — operator-session FSM transitions
 * (research §3).
 *
 * Asserts the closed transition graph:
 *
 *   signedOut ─► signingIn ─► signedIn ─► signingOut ─► signedOut
 *                       │
 *                       └─► takeoverPrompt ─► signedOut (cancel)
 *                       └─► takeoverPrompt ─► signedIn   (confirm — S4)
 *                       └─► signedOut (with refusal category)
 *
 * Out-of-graph transitions MUST be no-ops (the store guards every
 * transition by checking the source state — defensive, since stale
 * promises can arrive after a state has already advanced).
 */

const SAMPLE_SESSION: OperatorSessionView = {
  id: 'sess-1',
  operator_id: 'op-1',
  display_name: 'Manager One',
  role: 'manager',
  tenant_id: 't1',
  branch_id: 'b1',
  started_at: '2026-05-06T00:00:00.000Z',
};

afterEach(() => {
  useOperatorSessionStore.getState().reset();
});

describe('operator-session-store FSM (T011)', () => {
  it('starts in signedOut', () => {
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
  });

  it('signedOut → signingIn → signedIn → signingOut → signedOut', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signingIn');

    store.resolveSignedIn(SAMPLE_SESSION);
    const signedIn = useOperatorSessionStore.getState().state;
    expect(signedIn.kind).toBe('signedIn');
    if (signedIn.kind === 'signedIn') {
      expect(signedIn.session.operator_id).toBe('op-1');
    }

    store.beginSignOut();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signingOut');

    store.resolveSignedOut();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
  });

  it('signingIn → takeoverPrompt → signedOut (cancel branch)', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.promptTakeover('pending-test-id');
    expect(useOperatorSessionStore.getState().state.kind).toBe('takeoverPrompt');
    store.cancelTakeover();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');
  });

  it('signingIn → takeoverPrompt → signedIn (confirm branch reachable)', () => {
    // Confirm UX wires in S4; the FSM transition itself is reachable now.
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.promptTakeover('pending-test-id');
    store.resolveSignedIn(SAMPLE_SESSION);
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
  });

  it('signingIn → signedOut on refusal (carries category)', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.refuseSignIn('invalid_input');
    const state = useOperatorSessionStore.getState().state;
    expect(state.kind).toBe('signedOut');
    if (state.kind === 'signedOut') {
      expect(state.lastRefusal).toBe('invalid_input');
    }
  });

  it('clearRefusal removes the carried category (Note 1 — first keystroke)', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.refuseSignIn('no_connection');
    store.clearRefusal();
    const state = useOperatorSessionStore.getState().state;
    expect(state.kind).toBe('signedOut');
    if (state.kind === 'signedOut') {
      expect(state.lastRefusal).toBeUndefined();
    }
  });

  it('hydrateSignedIn: signedOut → signedIn with the given session', () => {
    const store = useOperatorSessionStore.getState();
    store.hydrateSignedIn(SAMPLE_SESSION);
    const state = useOperatorSessionStore.getState().state;
    expect(state.kind).toBe('signedIn');
    if (state.kind === 'signedIn') {
      expect(state.session.operator_id).toBe(SAMPLE_SESSION.operator_id);
    }
  });

  it('hydrateSignedIn: no-op when already signingIn', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.hydrateSignedIn(SAMPLE_SESSION);
    expect(useOperatorSessionStore.getState().state.kind).toBe('signingIn');
  });

  it('hydrateSignedIn: no-op when already signedIn (does not overwrite live session)', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.resolveSignedIn(SAMPLE_SESSION);
    const replacement = { ...SAMPLE_SESSION, operator_id: 'op-replaced' };
    store.hydrateSignedIn(replacement);
    const state = useOperatorSessionStore.getState().state;
    expect(state.kind).toBe('signedIn');
    if (state.kind === 'signedIn') {
      expect(state.session.operator_id).toBe(SAMPLE_SESSION.operator_id);
    }
  });

  it('out-of-graph transitions are no-ops (stale promise after state advanced)', () => {
    const store = useOperatorSessionStore.getState();
    // Calling resolveSignedIn while still in signedOut MUST be a no-op.
    store.resolveSignedIn(SAMPLE_SESSION);
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');

    store.beginSignOut(); // signedOut → ... is invalid
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');

    store.cancelTakeover(); // signedOut → ... is invalid
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedOut');

    store.beginSignIn();
    store.promptTakeover('pending-test-id');
    // Now in takeoverPrompt; another beginSignIn MUST be a no-op.
    store.beginSignIn();
    expect(useOperatorSessionStore.getState().state.kind).toBe('takeoverPrompt');
  });
});

/**
 * RT-113 P2 (Codex P2 4179701431, renderer side) — main can END a session on
 * its own (the cashier admission heartbeat). An `ended` push that arrives while
 * a sign-in or takeover confirm is in flight belongs to that attempt: its late
 * `signed_in` must not route the renderer into a session main no longer holds.
 * Each sign-in attempt has its own generation, so the mark never leaks into
 * the next attempt.
 */
describe('sessionEndedByMain — an ended push during an in-flight sign-in', () => {
  it('signedIn → signedOut (main ended the session itself)', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.resolveSignedIn(SAMPLE_SESSION);
    store.sessionEndedByMain();
    expect(useOperatorSessionStore.getState().state).toEqual({ kind: 'signedOut' });
  });

  it('ended during signingIn: the late signed_in for that attempt is discarded', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.sessionEndedByMain();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signingIn');
    store.resolveSignedIn(SAMPLE_SESSION, { closed_at: '2026-10-01T00:00:00.000Z' });
    expect(useOperatorSessionStore.getState().state).toEqual({
      kind: 'signedOut',
      lastRefusal: 'state_invalid',
    });
  });

  it('ended during a takeover confirm: the late signed_in is discarded', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.promptTakeover('pending-test-id');
    store.sessionEndedByMain();
    expect(useOperatorSessionStore.getState().state.kind).toBe('takeoverPrompt');
    store.resolveSignedIn(SAMPLE_SESSION);
    expect(useOperatorSessionStore.getState().state).toEqual({
      kind: 'signedOut',
      lastRefusal: 'state_invalid',
    });
  });

  it('the mark belongs to its attempt only: the next attempt signs in normally', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.sessionEndedByMain();
    store.refuseSignIn('invalid_input');
    store.beginSignIn();
    store.resolveSignedIn(SAMPLE_SESSION);
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
  });

  it('a refusal after an ended push still lands as that refusal', () => {
    const store = useOperatorSessionStore.getState();
    store.beginSignIn();
    store.sessionEndedByMain();
    store.refuseSignIn('state_invalid');
    expect(useOperatorSessionStore.getState().state).toEqual({
      kind: 'signedOut',
      lastRefusal: 'state_invalid',
    });
  });

  it('signedOut and signingOut: an ended push is a no-op', () => {
    const store = useOperatorSessionStore.getState();
    store.sessionEndedByMain();
    expect(useOperatorSessionStore.getState().state).toEqual({ kind: 'signedOut' });
    store.beginSignIn();
    store.resolveSignedIn(SAMPLE_SESSION);
    store.beginSignOut();
    store.sessionEndedByMain();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signingOut');
    // A later attempt is unaffected.
    store.resolveSignedOut();
    store.beginSignIn();
    store.resolveSignedIn(SAMPLE_SESSION);
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
  });
});
