import { create } from 'zustand';

import type { Role } from '../../shared/operator/role.js';
import type { RefusalCategory } from '../../shared/audit/event-shape.js';

/**
 * 004-operator-session T016 — operator-session FSM (research §3).
 *
 * Five-state machine plus a `takeoverPrompt` branch:
 *
 *     signedOut ── signIn() ──► signingIn ──► signedIn
 *           ▲                       │            │
 *           │                       │            │
 *           │                       └─► takeoverPrompt
 *           │                                    │
 *           │ ◄─ signOut()      signingOut ◄─────┘
 *
 * The store is the renderer-side projection of the operator session.
 * The main-process is the source of truth (in-memory in S1; durable
 * in S3); this store mirrors the visible FSM to drive routing and UI.
 *
 * S1 wires only the manager/admin path. The cashier-PIN-driven
 * transitions land in S4 (and the takeover-confirm UX with them); the
 * `takeoverPrompt` state is reachable here so the FSM is shape-correct
 * end-to-end, but the prompt component itself is S4 territory.
 */

export interface OperatorSessionView {
  /** Operator session id (UUID v4). */
  id: string;
  /** Clerk user id. */
  operator_id: string;
  display_name: string;
  role: Role;
  tenant_id: string;
  branch_id: string;
  /** ISO 8601 UTC timestamp the session was issued. */
  started_at: string;
}

export type OperatorSessionState =
  | { kind: 'signedOut'; lastRefusal?: RefusalCategory }
  | { kind: 'signingIn' }
  | { kind: 'takeoverPrompt'; pending_takeover_id: string }
  | { kind: 'signedIn'; session: OperatorSessionView; forced_close_notice?: { closed_at: string } }
  | { kind: 'signingOut' };

export interface OperatorSessionStore {
  state: OperatorSessionState;
  /**
   * RT-113 P2 (Codex P2 4179701431) — the generation of the current sign-in
   * attempt; `beginSignIn` starts a new one. A takeover confirm belongs to the
   * attempt that prompted it.
   */
  signInAttempt: number;
  /** The attempt during which main pushed `ended`, if any (see `sessionEndedByMain`). */
  endedAttempt: number | null;
  /** Begin a sign-in attempt; FSM moves signedOut → signingIn. */
  beginSignIn(): void;
  /** Sign-in resolved with a session; FSM moves signingIn → signedIn. */
  resolveSignedIn(session: OperatorSessionView, notice?: { closed_at: string }): void;
  /** T091 — cashier dismisses the forced-close return banner. */
  dismissShiftClosedNotice(): void;
  /** Sign-in resolved with takeover-required; FSM moves signingIn → takeoverPrompt. */
  promptTakeover(pending_takeover_id: string): void;
  /**
   * Sign-in resolved with refusal; FSM moves signingIn OR takeoverPrompt → signedOut
   * (carrying the category). Used for both initial sign-in refusals and
   * confirmTakeover non-retriable refusals (invalid_input).
   */
  refuseSignIn(category: RefusalCategory): void;
  /** Operator clears the inline refusal (Note 1 — first new keystroke). */
  clearRefusal(): void;
  /** Begin sign-out; FSM moves signedIn → signingOut. */
  beginSignOut(): void;
  /** Sign-out resolved; FSM moves signingOut → signedOut. */
  resolveSignedOut(): void;
  /** Cancel a takeover prompt; FSM moves takeoverPrompt → signedOut. */
  cancelTakeover(): void;
  /**
   * RT-113 P2 — main ended the session on its own (`ended` push). signedIn →
   * signedOut. During an in-flight sign-in or takeover confirm (signingIn /
   * takeoverPrompt) the push is recorded against that attempt, so its late
   * `signed_in` is discarded (Codex P2 4179701431). Otherwise a no-op.
   */
  sessionEndedByMain(): void;
  /**
   * Boot-time hydration — seeds signedIn from signedOut without going through
   * the normal beginSignIn/resolveSignedIn sign-in flow. Only transitions from
   * signedOut; no-op from any other state so it cannot overwrite a live session.
   */
  hydrateSignedIn(session: OperatorSessionView): void;
  /** Test-only reset hook — restores the store to its initial state. */
  reset(): void;
}

const INITIAL_STATE: OperatorSessionState = { kind: 'signedOut' };

/** True while a sign-in attempt (or its takeover confirm) awaits main's answer. */
function isSignInInFlight(state: OperatorSessionState): boolean {
  return state.kind === 'signingIn' || state.kind === 'takeoverPrompt';
}

export const useOperatorSessionStore = create<OperatorSessionStore>((set) => ({
  state: INITIAL_STATE,
  signInAttempt: 0,
  endedAttempt: null,
  beginSignIn: () => {
    set((s) => {
      if (s.state.kind !== 'signedOut') return s;
      return { state: { kind: 'signingIn' }, signInAttempt: s.signInAttempt + 1 };
    });
  },
  resolveSignedIn: (session, notice) => {
    set((s) => {
      if (!isSignInInFlight(s.state)) return s;
      // Main ended this attempt's session before its answer arrived: the
      // `signed_in` is stale; never route into a session main does not hold.
      if (s.endedAttempt === s.signInAttempt) {
        return { state: { kind: 'signedOut', lastRefusal: 'state_invalid' } };
      }
      return {
        state: {
          kind: 'signedIn',
          session,
          ...(notice !== undefined ? { forced_close_notice: notice } : {}),
        },
      };
    });
  },
  dismissShiftClosedNotice: () => {
    set((s) => {
      if (s.state.kind !== 'signedIn') return s;
      return { state: { kind: 'signedIn', session: s.state.session } };
    });
    void (
      window as { api?: { operator?: { dismissShiftClosedNotice?(): Promise<void> } } }
    ).api?.operator
      ?.dismissShiftClosedNotice?.()
      .catch(() => undefined);
  },
  promptTakeover: (pending_takeover_id) => {
    set((s) => {
      if (s.state.kind !== 'signingIn') return s;
      return { state: { kind: 'takeoverPrompt', pending_takeover_id } };
    });
  },
  refuseSignIn: (category) => {
    set((s) => {
      if (s.state.kind !== 'signingIn' && s.state.kind !== 'takeoverPrompt') return s;
      return { state: { kind: 'signedOut', lastRefusal: category } };
    });
  },
  clearRefusal: () => {
    set((s) => {
      if (s.state.kind !== 'signedOut' || s.state.lastRefusal === undefined) return s;
      return { state: { kind: 'signedOut' } };
    });
  },
  beginSignOut: () => {
    set((s) => {
      if (s.state.kind !== 'signedIn') return s;
      return { state: { kind: 'signingOut' } };
    });
  },
  resolveSignedOut: () => {
    set((s) => {
      if (s.state.kind !== 'signingOut') return s;
      return { state: { kind: 'signedOut' } };
    });
  },
  cancelTakeover: () => {
    set((s) => {
      if (s.state.kind !== 'takeoverPrompt') return s;
      return { state: { kind: 'signedOut' } };
    });
  },
  sessionEndedByMain: () => {
    set((s) => {
      if (s.state.kind === 'signedIn') return { state: { kind: 'signedOut' } };
      if (isSignInInFlight(s.state)) return { endedAttempt: s.signInAttempt };
      return s;
    });
  },
  hydrateSignedIn: (session) => {
    set((s) => {
      if (s.state.kind !== 'signedOut') return s;
      return { state: { kind: 'signedIn', session } };
    });
  },
  reset: () => {
    set({ state: INITIAL_STATE, signInAttempt: 0, endedAttempt: null });
  },
}));
