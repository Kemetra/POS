import type { SessionManager } from './session-manager.js';

/**
 * 004-operator-session dev fixture — boot-time operator sign-in bypass
 * for local development without a live Clerk/backend stack.
 *
 * Activated ONLY when ALL of the following hold:
 *   1. `isPackaged === false`  (Electron dev build / CI)
 *   2. `POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN` is truthy in the environment
 *
 * When active, a fixture manager session is created directly via
 * SessionManager.create() so the renderer routes past the sign-in
 * surface on first load. No Clerk call is made, no backend call is
 * made, no JWT is minted, and jwtHolder is NOT populated.
 *
 * The tenant_id and branch_id match the PR #178 pairing fixture so
 * POS_PULSE_DEV_SKIP_PAIRING and POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN
 * work together as a combined dev launch shortcut.
 *
 * SECURITY:
 *   - `isPackaged === true` short-circuits unconditionally — the env var
 *     is never consulted in a packaged build; this cannot be activated
 *     in production by exporting the variable.
 *   - No Clerk JWT is created or held. jwtHolder is deliberately NOT
 *     wired here (sign-out's backend call will be a no-op for this
 *     fixture session, which is the correct dev behaviour).
 *   - The renderer never sees backend_session_id or any token field.
 *     SessionManager.getCurrentBridgeView() projects only the
 *     OperatorSessionBridgeView shape, which omits those fields.
 *   - The warn payload is intentionally restricted to non-sensitive
 *     fields: event, packaged, flag, role. No session id, backend id,
 *     JWT, password, PIN, token, or credential appears in the log.
 *   - If a session already exists (e.g., called twice), the function
 *     is a no-op and returns false.
 *   - This module MUST NOT be imported or called from any production
 *     path other than the single call site in `src/main/index.ts`.
 */

/** Fixture session values written to SessionManager when the bypass runs. */
export const DEV_OPERATOR_FIXTURE_SESSION_INPUT = {
  operator_id: 'dev-manager',
  display_name: 'Dev Manager',
  role: 'manager',
  tenant_id: 'dev-tenant',
  branch_id: 'dev-branch',
  backend_session_id: 'dev-backend-session',
} as const;

export interface DevSkipOperatorSignInDeps {
  /**
   * The shipped-app identity, `isShippedApp(...)` from `app/shipped-app.ts`:
   * NOT raw `app.isPackaged`, which a renamed copy of the shipped exe reports
   * as false (RT-165). Bypass runs ONLY when this is false.
   */
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  sessionManager: Pick<SessionManager, 'create' | 'getCurrent'>;
  logger: { warn(payload: object, msg: string): void };
  /** Injected for test determinism; defaults to `() => new Date()`. */
  clock?: () => Date;
}

/**
 * Truthy-value list shared across all POS-Pulse dev env flags.
 */
function isTruthy(value: string | undefined): boolean {
  return (
    typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  );
}

/**
 * If the bypass is enabled (unpackaged + env flag truthy) and no
 * operator session already exists, creates a fixture manager session
 * and returns `true`. Otherwise no-ops and returns `false`.
 */
export function applyDevSkipOperatorSignInIfRequested(deps: DevSkipOperatorSignInDeps): boolean {
  if (deps.isPackaged) return false;
  if (!isTruthy(deps.env['POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN'])) return false;
  if (deps.sessionManager.getCurrent() !== null) return false;

  const clock = deps.clock ?? (() => new Date());

  deps.logger.warn(
    {
      event: 'operator.dev_bypass.active',
      packaged: false,
      flag: 'POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN',
      role: DEV_OPERATOR_FIXTURE_SESSION_INPUT.role,
    },
    'DEV BYPASS: auto-signing-in with fixture manager session. Never enable in a packaged build.',
  );

  deps.sessionManager.create({
    ...DEV_OPERATOR_FIXTURE_SESSION_INPUT,
    started_at: clock().toISOString(),
  });

  return true;
}
