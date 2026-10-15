/**
 * T040 — Dev-only toggle slice (US3). RT-498 (VN-S10 S10-1): moved here from
 * `shell/dev/useDevToggles.ts` so the v5 frame reads `?conn=` without shell code.
 *
 * MUST be tree-shaken from production builds — the module is guarded by
 * `import.meta.env.DEV`. Callers import this module only inside
 * `if (import.meta.env.DEV)` blocks so Vite can eliminate it from the
 * production chunk graph (T041 prod-bundle assertion deferred to T076).
 *
 * Reads `?state=…` and `?conn=…` URL search params and exposes them to:
 *  - placeholder panes (`state`): 'default' | 'loading' | 'empty' | 'error'
 *  - connection-state wiring (`conn`): 'online' | 'degraded' | 'offline' | 'syncing'
 *
 * The `conn` value is parsed here for completeness of the hook's contract;
 * it is wired to `useConnectionState` in T045 (US4) — NOT in this file.
 * Wiring `conn` here would violate the strict-exclusions contract for US3.
 */

import type { ConnectionState } from '../ui/tokens/connection-state';

export type PaneState = 'default' | 'loading' | 'empty' | 'error';

const VALID_PANE_STATES = new Set<PaneState>(['default', 'loading', 'empty', 'error']);
const VALID_CONN_STATES = new Set<ConnectionState>(['online', 'degraded', 'offline', 'syncing']);

export interface DevToggles {
  /** Which state variant the placeholder panes should render. */
  state: PaneState;
  /**
   * Which connection state the ConnectionIndicator should render.
   * Wired to useConnectionState in T045 (US4). US3 only parses it.
   */
  conn: ConnectionState;
}

/**
 * Pure getter — reads URL search params synchronously.
 * Useful in tests where hook context is unavailable.
 */
export function getDevToggles(): DevToggles {
  const params = new URLSearchParams(window.location.search);

  const rawState = params.get('state') ?? '';
  const state: PaneState = VALID_PANE_STATES.has(rawState as PaneState)
    ? (rawState as PaneState)
    : 'default';

  const rawConn = params.get('conn') ?? '';
  const conn: ConnectionState = VALID_CONN_STATES.has(rawConn as ConnectionState)
    ? (rawConn as ConnectionState)
    : 'online';

  return { state, conn };
}

/**
 * React hook — returns the parsed dev toggles.
 * Must only be called in dev builds (`import.meta.env.DEV`).
 * The returned object is stable within the same URL; callers
 * are responsible for not calling this in production.
 */
export function useDevToggles(): DevToggles {
  return getDevToggles();
}
