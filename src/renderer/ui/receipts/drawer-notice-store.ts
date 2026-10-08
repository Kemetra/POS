import { create } from 'zustand';

import { useOperatorSessionStore } from '../../stores/operator-session-store';
import type { DrawerFailureState } from './useDrawerBannerState';

/**
 * RT-241 — D-B1 drawer notice lifetime (freeze 15 §7 Lane C, owner-approved
 * with the freeze package, 2026-10-07).
 *
 * Main projects a drawer failure (`banner_state.drawer_failure`) until a later
 * successful drawer event on the terminal, across sessions and restarts. That
 * projection, and every drawer and audit event behind it, is unchanged. What
 * changes is only how long the renderer SHOWS it:
 *
 * - shown for a failure that appears during this session;
 * - cleared on acknowledgement («تم» or «بيع جديد»), on the next successful
 *   drawer event (the projection clears), on sign-out, and on restart.
 *
 * The renderer cannot tie a finalized sale to the payment on screen (X-4: no
 * correlation key), so "during this session" means "not in this session's
 * first known projection". The first `ok` read is the baseline; a failure
 * already in it belongs to an earlier session or run and stays hidden. Module
 * memory is the session: a restart (or a renderer reload) starts empty, and
 * sign-out resets it explicitly.
 *
 * A finalization that fails its drawer kick just after «بيع جديد» is a new
 * failure and shows until its own acknowledgement — the kick did just fail.
 */

export type DrawerNoticeFailure = DrawerFailureState;

interface DrawerNoticeState {
  /** The failure to show now, or null. */
  active: DrawerNoticeFailure | null;
  /** The first known projection's failure id; `undefined` until it is known. */
  baseline: string | null | undefined;
  acknowledged: ReadonlyArray<string>;
  /** Feed every KNOWN projection (`ok` reads only). */
  observe(failure: DrawerNoticeFailure | null): void;
  /** «تم» or «بيع جديد»: the shown failure is acknowledged. */
  acknowledge(): void;
  /** Sign-out: forget everything and re-take the baseline. */
  reset(): void;
}

const INITIAL = { active: null, baseline: undefined, acknowledged: [] } as const;

export const useDrawerNoticeStore = create<DrawerNoticeState>((set, get) => ({
  ...INITIAL,
  observe: (failure) => {
    const { baseline, acknowledged } = get();
    if (baseline === undefined) {
      set({ baseline: failure?.sale_id ?? null, active: null });
      return;
    }
    const hidden =
      failure === null || failure.sale_id === baseline || acknowledged.includes(failure.sale_id);
    set({ active: hidden ? null : failure });
  },
  acknowledge: () => {
    const { active, acknowledged } = get();
    if (active === null) return;
    set({ active: null, acknowledged: [...acknowledged, active.sale_id] });
  },
  reset: () => {
    set({ ...INITIAL });
  },
}));

/** «تم» / «بيع جديد». */
export function acknowledgeDrawerNotice(): void {
  useDrawerNoticeStore.getState().acknowledge();
}

/**
 * Sign-out clears the notice: the same transition the cart hook treats as the
 * end of a session (leaving `signedIn` for any reason). Lock is not a sign-out;
 * the session, and the notice, survive it. Installed once at renderer boot.
 */
export function installDrawerNoticeSignOutHook(): () => void {
  let wasSignedIn = useOperatorSessionStore.getState().state.kind === 'signedIn';
  return useOperatorSessionStore.subscribe((next) => {
    const isSignedIn = next.state.kind === 'signedIn';
    if (wasSignedIn && !isSignedIn) useDrawerNoticeStore.getState().reset();
    wasSignedIn = isSignedIn;
  });
}
