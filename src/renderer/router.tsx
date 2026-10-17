import { useEffect, useState, type ReactNode, type JSX } from 'react';
import {
  createMemoryRouter,
  createHashRouter,
  Navigate,
  Outlet,
  RouterProvider,
  type RouteObject,
} from 'react-router-dom';

import {
  PairingRecoveryListener,
  PairingRoute,
  usePairingPushRelay,
} from './routes/pairing/PairingRecoveryListener';
import { PairedScreen } from './routes/paired/PairedScreen';
import { DashboardRoute } from './routes/app/DashboardRoute';
import { AppIndexRedirect } from './routes/app/AppIndexRedirect';
import { SalesWorkspace } from './routes/app/SalesWorkspace';
import { ReturnsRoute } from './returns/ReturnsRoute';
import { AuditPlaceholder } from './routes/app/AuditPlaceholder';
import { InventoryPlaceholder } from './routes/app/InventoryPlaceholder';
import { CatalogueDiagnostics } from './routes/app/CatalogueDiagnostics';
import { SettingsHelpPlaceholder } from './routes/app/SettingsHelpPlaceholder';
import { CheckoutRoute } from './routes/app/checkout/CheckoutRoute';
import { CashiersScreen } from './v5/cashiers/CashiersScreen';
import { RecoveryRoute } from './v5/recovery/RecoveryRoute';
import { VoidRoute } from './v5/void/VoidRoute';
import { StuckShiftSurface } from './ui/operator/ForcedCloseSurface';
import { SignInRoute } from './routes/sign-in';
import { OperatorRouteGuard } from './routes/operator-route-guard';
import { V5AppLayout } from './v5/frame/V5AppLayout';
import { V5SaleRoute } from './v5/sale/V5SaleRoute';
import { V5ShiftRoute } from './v5/shift/V5ShiftRoute';
import { V5ShiftManagerRoute } from './v5/shift/V5ShiftManagerRoute';
import { ErrorScreen } from './v5/foundation/ErrorScreen';
import { RouteLoading } from './v5/foundation/RouteLoading';
import { SupportedViewport } from './v5/foundation/SupportedViewport';
import { ScreenSection } from './v5/foundation/ScreenSection';
import { ForceFailNotice } from './v5/manager/honest/ForceFailNotice';
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

/**
 * The /app screens outside the per-surface guards: Inventory (and its
 * diagnostics) and Settings admit manager and admin only (RT-597, RT-505 O1,
 * OD-6: a cashier sees the Sale, so a typed URL leaves the screen too). And —
 * RT-530 — «إلغاء بيع», a void of a finalized sale with another manager's PIN.
 * Any signed-in operator reaches the last one; the route leaves for /app while
 * POS_PULSE_FEATURE_SALE_VOID is off, and main re-checks the flag and the
 * session on every call.
 */
const SECONDARY_ROUTES: RouteObject[] = [
  {
    path: 'inventory',
    element: (
      <OperatorRouteGuard allow={['manager', 'admin']}>
        <InventoryPlaceholder />
      </OperatorRouteGuard>
    ),
  },
  {
    path: 'inventory/diagnostics',
    element: (
      <OperatorRouteGuard allow={['manager', 'admin']}>
        <CatalogueDiagnostics />
      </OperatorRouteGuard>
    ),
  },
  {
    path: 'settings',
    element: (
      <OperatorRouteGuard allow={['manager', 'admin']}>
        <SettingsHelpPlaceholder />
      </OperatorRouteGuard>
    ),
  },
  { path: 'void', element: <VoidRoute /> },
];

/**
 * RT-546 (RT-534 F3, OD-534-1) — «المبيعات» admits cashier, manager and admin
 * only. Secondary UX defence: main gates every sales.* / receipts.* call on role
 * and, for a cashier, on sale ownership (sale-access-policy.ts, AD-1).
 */
const SALES_ROUTE: RouteObject = {
  path: 'sales',
  element: (
    <OperatorRouteGuard allow={['cashier', 'manager', 'admin']}>
      <SalesWorkspace />
    </OperatorRouteGuard>
  ),
};

/** «المبيعات» (guarded) first, then the unguarded secondary screens. */
const SALES_AND_SECONDARY_ROUTES: RouteObject[] = [SALES_ROUTE, ...SECONDARY_ROUTES];

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

export function AppRouter(props: Readonly<AppRouterProps>): JSX.Element {
  const [boot, setBoot] = useState<BootStatus>({ phase: 'loading' });
  // RT-215 / Codex P2 4186254473: the one pairing-push subscription. Its
  // effect is declared BEFORE the boot read's, so it is registered first and
  // no push is lost while the read is pending.
  const relay = usePairingPushRelay(props.pairing);

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
    // RT-241 (VN-S2): never blank while the start route is decided.
    return <RouteLoading />;
  }

  // T034: routes are purely path-based after the initial decision.
  // PairingForm.navigate('/paired') on success lands on PairedScreen,
  // which self-fetches and shows the fresh assignment. PairedScreen
  // redirects back to /pairing on its own if the status it reads is
  // not 'paired' — so a stale boot state cannot strand the operator.
  // RT-215: a reason pushed at runtime (device revoked) wins over the boot one.
  // RT-241 (VN-S2): pairing, Ready and sign-in render outside the frame, so
  // they carry their own supported-viewport guard (the route element only; the
  // boot read above is unchanged).
  const pairingScreenElement = (
    <SupportedViewport>
      {boot.invalidReason !== undefined ? (
        <PairingRoute pairing={props.pairing} bootReason={boot.invalidReason} />
      ) : (
        <PairingRoute pairing={props.pairing} />
      )}
    </SupportedViewport>
  );
  // T035 — /app/* parent route wired per contracts/shell-routes.ts.
  // Existing /pairing and /paired routes are unchanged.
  // Pairing-bypass guard (T007) stays green: unpaired/invalid terminals
  // still route to /pairing and cannot reach /app/* directly.
  // 004-operator-session T032: `/sign-in` mounts above `/app/*`. The
  // app is wrapped in `<OperatorRouteGuard>` (no `allow` filter at
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
      <SupportedViewport>
        <SignInRoute operator={props.operator} pairing={props.pairing} />
      </SupportedViewport>
    ) : (
      <Navigate to={boot.startPath} replace />
    );

  // 023 Slice G — one operator guard for all of /app. RT-498 (VN-S10 S10-1):
  // under it, one layout — the v5 frame — for every /app screen. RT-504
  // (S10-Z) deleted the legacy AppShell; `shell-retirement.test.ts` keeps it gone.
  const guardedApp =
    props.operator !== undefined ? (
      <OperatorRouteGuard>
        <Outlet />
      </OperatorRouteGuard>
    ) : (
      <Outlet />
    );

  const appRoutes: RouteObject[] = [
    { path: '/', element: <Navigate to={boot.startPath} replace /> },
    { path: '/pairing', element: pairingScreenElement },
    {
      path: '/paired',
      element: (
        <SupportedViewport>
          <PairedScreen pairing={props.pairing} />
        </SupportedViewport>
      ),
    },
    { path: '/sign-in', element: signInElement },
    {
      path: '/app',
      element: guardedApp,
      children: [
        {
          element: <V5AppLayout />,
          children: [
            { path: 'cart', element: <V5SaleRoute /> },
            { path: 'checkout', element: <CheckoutRoute /> },
            // RT-17 slice 4 part 3 — the shift cash-up screens. Each leaves for
            // /app (before any call) while POS_PULSE_FEATURE_SHIFT_CASHUP is
            // off; main registers no shift handler then either.
            // The cashier screen records device-path facts (cashier only); a
            // manager or admin is turned away before any call.
            {
              path: 'shift',
              element: (
                <OperatorRouteGuard allow={['cashier']}>
                  <V5ShiftRoute />
                </OperatorRouteGuard>
              ),
            },
            {
              path: 'shift/manager',
              element: (
                <OperatorRouteGuard allow={['manager', 'admin']}>
                  <V5ShiftManagerRoute />
                </OperatorRouteGuard>
              ),
            },
            // RT-424 (RT-251 doc 19, G-3) — Manager → Cashiers in the v5 manager
            // frame (UX-09). Opened from the Dashboard link; manager/admin only
            // here (secondary) and in main (`requireRole`, AD-1).
            {
              path: 'manager/cashiers',
              element: (
                <OperatorRouteGuard allow={['manager', 'admin']}>
                  {props.operator !== undefined ? (
                    <CashiersScreen operator={props.operator} pairing={props.pairing} />
                  ) : (
                    <Navigate to="/app/dashboard" replace />
                  )}
                </OperatorRouteGuard>
              ),
            },
            // RT-441 (RT-116 §5) — Manager → المبيعات المعلقة: the stuck payment
            // and other operators' held sales. Manager/admin only here and in main.
            {
              path: 'manager/recovery',
              element: (
                <OperatorRouteGuard allow={['manager', 'admin']}>
                  <RecoveryRoute />
                </OperatorRouteGuard>
              ),
            },
            // RT-498 (VN-S10 S10-1, D-10-1) — the screens below rendered in the
            // legacy shell until then. They render in the same v5 frame with
            // their content unchanged; S10-2 … S10-6 recomposed each surface.
            //
            // 022 US1 / FR-44 — role-aware landing. A cashier lands on the till
            // (/app/cart) instead of /app/dashboard, which rejects the cashier
            // role and made an ERROR STATE the first screen of a shift.
            // Navigation only: DashboardRoute's role check, OperatorRouteGuard,
            // every allow list and every flag are untouched (FR-45/FR-47).
            { index: true, element: <AppIndexRedirect /> },
            { path: 'dashboard', element: <DashboardRoute /> },
            ...SALES_AND_SECONDARY_ROUTES,
            // PR #434 FIX 1 — gate BOTH to manager/admin (owner decision). The
            // role-visibility-matrix marks the Audit surface ⛔ cashier, and a
            // signed-in cashier must NOT reach either. Same nested guard
            // pattern as the `/app/manager/*` routes.
            //
            // RT-15 S3 — Returns is the manager/admin return flow (D-b; main
            // re-checks flag, session and role on every `returns.*` call).
            // Audit is still a later display slice (navigation-only placeholder).
            {
              path: 'returns',
              element: (
                <OperatorRouteGuard allow={['manager', 'admin']}>
                  <ReturnsRoute />
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
            {
              path: 'manager/stuck-shifts',
              element: (
                <OperatorRouteGuard allow={['manager', 'admin']}>
                  {props.operator !== undefined ? (
                    <ScreenSection title="الورديات العالقة">
                      <StuckShiftSurface operator={props.operator} />
                    </ScreenSection>
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
      ],
    },
  ];
  // RT-215 — one pathless layout over every route: it listens for the
  // `pairing:status-changed` push and moves a revoked terminal to /pairing.
  // RT-241 (VN-S2): its errorElement is the one route error boundary, so a
  // render failure shows the Arabic ErrorScreen instead of the router default.
  const routes: RouteObject[] = [
    {
      element: <PairingRecoveryListener relay={relay} />,
      errorElement: <ErrorScreen />,
      children: appRoutes,
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
  // RT-503 (VN-S10 S10-6): a section inside the v5 frame, which owns the one
  // <main>, with the G-6 neutral notice and the way to «المبيعات المعلقة».
  return (
    <ScreenSection title="إنهاء دفع معلّق">
      <ForceFailNotice />
    </ScreenSection>
  );
}

/**
 * happy-dom + memory router: the test asserts on
 * `window.location.pathname`. createMemoryRouter does not touch the
 * browser URL, so we mirror its current location into the DOM history
 * via `replaceState` whenever it changes. Keeps the router test
 * DOM-based without coupling to memory-router internals.
 */
function PathMirrorBridge(
  props: Readonly<{
    router: ReturnType<typeof createMemoryRouter>;
    children: ReactNode;
  }>,
): JSX.Element {
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
