import { useEffect, useState, type ReactNode, type JSX } from 'react';
import {
  createMemoryRouter,
  createHashRouter,
  Navigate,
  RouterProvider,
  type RouteObject,
} from 'react-router-dom';

import { PairingScreen } from './routes/pairing/PairingScreen';
import { PairedScreen } from './routes/paired/PairedScreen';
import { AppShell } from './shell/AppShell';
import { DashboardRoute } from './routes/app/DashboardRoute';
import { AppIndexRedirect } from './routes/app/AppIndexRedirect';
import { SalesWorkspace } from './routes/app/SalesWorkspace';
import { CartWorkspace } from './routes/app/CartWorkspace';
import { ReturnsPlaceholder } from './routes/app/ReturnsPlaceholder';
import { AuditPlaceholder } from './routes/app/AuditPlaceholder';
import { InventoryPlaceholder } from './routes/app/InventoryPlaceholder';
import { CatalogueDiagnostics } from './routes/app/CatalogueDiagnostics';
import { SettingsHelpPlaceholder } from './routes/app/SettingsHelpPlaceholder';
import { CheckoutRoute } from './routes/app/checkout/CheckoutRoute';
import { CashierManagement } from './routes/app/manager/CashierManagement';
import { StuckShiftSurface } from './ui/operator/ForcedCloseSurface';
import { SignInRoute } from './routes/sign-in';
import { OperatorRouteGuard } from './routes/operator-route-guard';
import type { OperatorBridgeAPI, PairingBridgeAPI } from '../shared/bridge-api';
import type { PairingStatus } from '../shared/pairing-types';

/**
 * 002-terminal-pairing T016 + T034 — boot router.
 *
 * Calls the injected `pairing.getStatus()` exactly once on mount to
 * decide the START route, then routes are purely path-based:
 *
 *   getStatus() → 'unpaired'              → start at /pairing
 *   getStatus() → 'paired' (with fields)  → start at /paired
 *   getStatus() → 'invalid'               → start at /pairing with reason flag
 *   getStatus() rejects                   → start at /pairing with reason='decrypt_failed'
 *                                            (defensive — bridge failure
 *                                            is most likely an unhealthy
 *                                            SecretStore; operator action
 *                                            is the same: re-pair)
 *
 * After the initial routing decision, navigation is path-driven. The
 * `/paired` route mounts PairedScreen which self-fetches via
 * `getStatus()` and redirects back to `/pairing` on a non-paired
 * status — so a stale boot state cannot strand the operator. T034:
 * after a successful submit, PairingForm calls `navigate('/paired')`,
 * PairedScreen mounts, re-fetches, and shows the fresh assignment.
 *
 * The pairing bridge is INJECTED so tests can render against a fake
 * bridge without touching `window.api`. The application entry point
 * (`src/renderer/main.tsx`) wires the real bridge.
 *
 * `createMemoryRouter` lets unit tests start at a known initial entry;
 * the application uses createHashRouter to avoid file:// → server-side
 * routing conflicts in packaged builds.
 */

export interface AppRouterProps {
  pairing: PairingBridgeAPI;
  /**
   * 004-operator-session T032 — operator bridge for the `/sign-in`
   * route. Optional so existing 002 / 003 callers (and tests rooted
   * at /pairing or /paired) keep their current shape; production
   * (`src/renderer/App.tsx`) wires the real bridge.
   */
  operator?: OperatorBridgeAPI;
  /**
   * Test-only: render with a memory router rooted at this initial
   * entry. When omitted (production), a hash router is used so the
   * packaged file:// renderer can navigate without backend rewrite
   * rules.
   */
  initialEntry?: string;
}

type BootStatus =
  | { phase: 'loading' }
  | {
      phase: 'ready';
      startPath: '/pairing' | '/paired';
      invalidReason?: Extract<PairingStatus, { kind: 'invalid' }>['reason'];
    };

export function AppRouter(props: AppRouterProps): JSX.Element {
  const [boot, setBoot] = useState<BootStatus>({ phase: 'loading' });

  useEffect(() => {
    // Box the cancellation flag so eslint's flow analysis doesn't
    // narrow `cancelled` to `false` after the synchronous read; the
    // cleanup function flips it after the surrounding `await`.
    const guard = { cancelled: false };
    void (async () => {
      let resolved: BootStatus;
      try {
        const status = await props.pairing.getStatus();
        if (status.kind === 'paired') {
          resolved = { phase: 'ready', startPath: '/paired' };
        } else if (status.kind === 'invalid') {
          resolved = { phase: 'ready', startPath: '/pairing', invalidReason: status.reason };
        } else {
          resolved = { phase: 'ready', startPath: '/pairing' };
        }
      } catch {
        // Defensive fallback: any rejection from the bridge lands the
        // operator on /pairing with the most actionable diagnostic.
        // We deliberately do NOT include the rejection's value in any
        // log emission here — Constitution VII (no secret-shaped data
        // through the logger from a typed error path).
        resolved = { phase: 'ready', startPath: '/pairing', invalidReason: 'decrypt_failed' };
      }
      if (!guard.cancelled) setBoot(resolved);
    })();
    return () => {
      guard.cancelled = true;
    };
  }, [props.pairing]);

  if (boot.phase === 'loading') {
    return <main data-testid="route-loading" />;
  }

  // T034: routes are purely path-based after the initial decision.
  // PairingForm.navigate('/paired') on success lands on PairedScreen,
  // which self-fetches and shows the fresh assignment. PairedScreen
  // redirects back to /pairing on its own if the status it reads is
  // not 'paired' — so a stale boot state cannot strand the operator.
  const pairingScreenElement =
    boot.invalidReason !== undefined ? (
      <PairingScreen pairing={props.pairing} invalidReason={boot.invalidReason} />
    ) : (
      <PairingScreen pairing={props.pairing} />
    );
  // T035 — /app/* parent route wired per contracts/shell-routes.ts.
  // Existing /pairing and /paired routes are unchanged.
  // Pairing-bypass guard (T007) stays green: unpaired/invalid terminals
  // still route to /pairing and cannot reach /app/* directly.
  // 004-operator-session T032: `/sign-in` mounts above `/app/*`. The
  // shell is wrapped in `<OperatorRouteGuard>` (no `allow` filter at
  // S1 — any signed-in role passes; per-route role gating lands with
  // the manager-only surfaces in S4 / S5). Any deep-link to `/app/*`
  // without an operator session redirects to `/sign-in` (FR-005).
  //
  // The operator bridge is optional on AppRouterProps so existing 002
  // / 003 callers keep working. When it's present, `/sign-in` is
  // mounted; when absent, the route falls back to a redirect to the
  // start path (test scenarios that don't exercise sign-in stay
  // green).
  const signInElement =
    props.operator !== undefined ? (
      <SignInRoute operator={props.operator} />
    ) : (
      <Navigate to={boot.startPath} replace />
    );

  const guardedShell =
    props.operator !== undefined ? (
      <OperatorRouteGuard>
        <AppShell />
      </OperatorRouteGuard>
    ) : (
      <AppShell />
    );

  const routes: RouteObject[] = [
    { path: '/', element: <Navigate to={boot.startPath} replace /> },
    { path: '/pairing', element: pairingScreenElement },
    { path: '/paired', element: <PairedScreen pairing={props.pairing} /> },
    { path: '/sign-in', element: signInElement },
    {
      path: '/app',
      element: guardedShell,
      children: [
        // 022 US1 / FR-44 — role-aware landing. A cashier lands on the till
        // (/app/cart) instead of /app/dashboard, which rejects the cashier
        // role and made an ERROR STATE the first screen of a shift.
        // Navigation only: DashboardRoute's role check, OperatorRouteGuard,
        // every allow list and every flag are untouched (FR-45/FR-47).
        { index: true, element: <AppIndexRedirect /> },
        { path: 'dashboard', element: <DashboardRoute /> },
        { path: 'sales', element: <SalesWorkspace /> },
        { path: 'cart', element: <CartWorkspace /> },
        { path: 'checkout', element: <CheckoutRoute /> },
        // POS v3.5 Slice 1 — new nav entries route to thin "coming soon"
        // placeholders. Returns is Phase-7 blocked; Audit is a later display
        // slice. Both are navigation-only (no data, no IPC).
        //
        // PR #434 FIX 1 — gate BOTH to manager/admin (owner decision). The
        // role-visibility-matrix marks the Audit surface ⛔ cashier, and
        // Returns is Phase-7 blocked; a signed-in cashier must NOT reach
        // either. Same nested guard pattern as the `/app/manager/*` routes.
        {
          path: 'returns',
          element: (
            <OperatorRouteGuard allow={['manager', 'admin']}>
              <ReturnsPlaceholder />
            </OperatorRouteGuard>
          ),
        },
        {
          path: 'audit',
          element: (
            <OperatorRouteGuard allow={['manager', 'admin']}>
              <AuditPlaceholder />
            </OperatorRouteGuard>
          ),
        },
        { path: 'inventory', element: <InventoryPlaceholder /> },
        { path: 'inventory/diagnostics', element: <CatalogueDiagnostics /> },
        { path: 'settings', element: <SettingsHelpPlaceholder /> },
        {
          path: 'manager/cashiers',
          element: (
            <OperatorRouteGuard allow={['manager', 'admin']}>
              {props.operator !== undefined ? (
                <CashierManagement operator={props.operator} />
              ) : (
                <Navigate to="dashboard" replace />
              )}
            </OperatorRouteGuard>
          ),
        },
        {
          path: 'manager/stuck-shifts',
          element: (
            <OperatorRouteGuard allow={['manager', 'admin']}>
              {props.operator !== undefined ? (
                <StuckShiftSurface operator={props.operator} />
              ) : (
                <Navigate to="dashboard" replace />
              )}
            </OperatorRouteGuard>
          ),
        },
        {
          // T282 — Wave 5b-renderer manager-only force-fail surface
          // (FR-021 / plan AD-5). Secondary UX defence; the load-
          // bearing role check lives in the main-process bridge
          // handler. The placeholder is rendered without props when
          // `props.payments` isn't injected — production wires
          // `window.api.payments` upstream; future "list of stuck
          // attempts" feature will navigate users here with the
          // payment_attempt_id in route state.
          path: 'manager/force-fail',
          element: (
            <OperatorRouteGuard allow={['manager', 'admin']}>
              <ManagerForceFailRoutePlaceholder />
            </OperatorRouteGuard>
          ),
        },
      ],
    },
  ];

  // Tests use a memory router so window.location.pathname remains
  // controllable; production uses hash-routing to survive file://.
  if (typeof props.initialEntry === 'string' || isUnderTestEnvironment()) {
    const initialEntry = props.initialEntry ?? '/';
    const router = createMemoryRouter(routes, {
      initialEntries: [initialEntry],
    });
    // The memory router does NOT update window.location, so we mirror
    // the path back into history for tests that assert on
    // window.location.pathname (per the data-model + the router test).
    return (
      <PathMirrorBridge router={router}>
        <RouterProvider router={router} />
      </PathMirrorBridge>
    );
  }
  // Production-only branch — covered by the manual Electron smoke (T035)
  // and by the CI package:dir build. Vitest always returns true from
  // isUnderTestEnvironment(), so this branch is never exercised in unit
  // tests; v8-ignore to keep coverage honest about what unit tests
  // actually cover.
  /* v8 ignore start */
  const router = createHashRouter(routes);
  return <RouterProvider router={router} />;
  /* v8 ignore stop */
}

/**
 * T282 — Wave 5b-renderer manager-only force-fail route placeholder.
 *
 * The actual `<ForceFailSurface>` component takes a payment_attempt_id
 * + idempotency_key + bridge ref. Until a "list of stuck attempts"
 * surface lands (future Slice 5+ work), this route is a placeholder
 * that the manager reaches by navigating with route state, or — in
 * tests — by mounting `<ForceFailSurface>` directly with the right
 * props. The placeholder itself simply confirms the route + the
 * guard are wired.
 *
 * The COMPONENT (`<ForceFailSurface>`) lives at
 * `src/renderer/ui/payments/ForceFailSurface.tsx` and is unit-tested
 * via `tests/unit/renderer/payments/ForceFailSurface.manager-only.test.tsx`.
 * The route GUARD is exercised by the existing router-level role-
 * guard test (precedent: `manager/cashiers` + `manager/stuck-shifts`).
 */
function ManagerForceFailRoutePlaceholder(): JSX.Element {
  return (
    <main data-testid="manager-force-fail-route-placeholder">
      Navigate here with a payment attempt to force-fail.
    </main>
  );
}

/**
 * happy-dom + memory router: the test asserts on
 * `window.location.pathname`. createMemoryRouter does not touch the
 * browser URL, so we mirror its current location into the DOM history
 * via `replaceState` whenever it changes. Keeps the router test
 * DOM-based without coupling to memory-router internals.
 */
function PathMirrorBridge(props: {
  router: ReturnType<typeof createMemoryRouter>;
  children: ReactNode;
}): JSX.Element {
  useEffect(() => {
    const sync = (): void => {
      const current = props.router.state.location.pathname;
      // Guard against an infinite update loop if the memory router and
      // the DOM history are already in sync (e.g., on the very first
      // sync call after mount).
      /* v8 ignore next 3 */
      if (current === window.location.pathname) {
        return;
      }
      window.history.replaceState(null, '', current);
    };
    sync();
    const unsubscribe = props.router.subscribe(sync);
    return () => {
      unsubscribe();
    };
  }, [props.router]);
  return <>{props.children}</>;
}

/**
 * Detect the Vitest / happy-dom test environment. Vitest sets
 * `import.meta.env.MODE === 'test'` and `process.env.NODE_ENV === 'test'`
 * (latter only when run via `vitest`). We check both so a future runner
 * change does not silently flip production into memory-routing.
 */
function isUnderTestEnvironment(): boolean {
  // import.meta.env is provided by Vite-side tooling; read it defensively.
  // The `?? process.env.NODE_ENV` fallback is a production-only safety
  // net — under Vitest, `import.meta.env.MODE` is always set, so the
  // right side of the `??` never executes in tests.
  /* v8 ignore next 4 */
  const mode =
    (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE ??
    (typeof process !== 'undefined' ? process.env['NODE_ENV'] : undefined);
  return mode === 'test';
}
