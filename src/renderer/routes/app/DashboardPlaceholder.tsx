/**
 * DashboardPlaceholder — dev/production gate for the v3.5 dashboard.
 *
 * PRODUCTION / PILOT: renders the honest, value-free <DashboardSkeleton> — the
 * Phase-4 owner directive ("do NOT fabricate any metric") stands until the DP-2
 * POS-013 dashboard-metrics contract lands. No fabricated figure ships.
 *
 * DEV + OPT-IN (`?demo=1`, owner-approved 2026-06-22): lazy-loads the rich v3.5
 * <DashboardDemo> (DashboardView fed obviously-fake sample data behind a loud
 * "DEMO DATA (not real)" banner) — a deliberate visual preview, never a pilot
 * surface and never the default. Without `?demo=1` the dev render is the SAME
 * honest skeleton as production, so integration/route tests see the production
 * contract. The legacy `?state=` variant gallery is also kept.
 *
 * TREE-SHAKE: the demo + its sample data are pulled in ONLY via the dynamic
 * `import('./DashboardDemo')` below, so the bundler emits them as a SEPARATE
 * chunk a production build never fetches — the demo strings are physically
 * absent from the main production JS (verified by the bundle grep in the PR).
 * A static top-level import would NOT tree-shake (the eager import retains the
 * strings even behind a dead branch — that gap is why this is lazy).
 */
import { Suspense, lazy, type JSX } from 'react';

import { LoadingState, EmptyState, ErrorState } from '../../ui/states';
import { Workspace } from '../../shell/regions/Workspace';
import { DashboardSkeleton } from './DashboardSkeleton';
import { CashierManagementLink } from './CashierManagementLink';
import { ShiftManagerLink } from './ShiftManagerLink';

const DashboardDemo = lazy(() => import('./DashboardDemo'));

function isDevBuild(devOverride?: boolean): boolean {
  if (typeof devOverride === 'boolean') {
    return devOverride;
  }
  const metaEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  return Boolean(metaEnv?.DEV);
}

function readQueryParam(name: string): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return new URLSearchParams(window.location.search).get(name) ?? '';
}

function HonestDashboard(): JSX.Element {
  return (
    <Workspace title="Dashboard">
      <ShiftManagerLink />
      <CashierManagementLink />
      <DashboardSkeleton />
    </Workspace>
  );
}

export interface DashboardPlaceholderProps {
  /** Test/preview seam to force the dev (true) or production (false) branch. */
  devOverride?: boolean;
}

export function DashboardPlaceholder({ devOverride }: DashboardPlaceholderProps = {}): JSX.Element {
  const isDev = isDevBuild(devOverride);

  // DEV state-gallery variants (?state=…) — preserved, dev-only.
  if (isDev) {
    const devState = readQueryParam('state');
    if (devState === 'loading') {
      return <LoadingState message="Loading Dashboard…" />;
    }
    if (devState === 'empty') {
      return (
        <EmptyState
          heading="No dashboard data"
          description="There is nothing to display here yet. Check back later."
        />
      );
    }
    if (devState === 'error') {
      return (
        <ErrorState
          heading="Dashboard unavailable"
          description="Could not load the dashboard. Please try again."
        />
      );
    }

    // DEMO dashboard — opt-in (`?demo=1`) ONLY, never the default. Lazy-loaded so
    // the sample data is a separate chunk absent from the production bundle.
    if (readQueryParam('demo') === '1') {
      return (
        <Suspense fallback={<HonestDashboard />}>
          <DashboardDemo />
        </Suspense>
      );
    }
  }

  // DEFAULT (production/pilot AND dev-without-?demo) — honest skeleton only. No
  // fabricated metric ever renders by default anywhere.
  return <HonestDashboard />;
}
