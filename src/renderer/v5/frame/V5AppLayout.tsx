import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';
import { V5Frame } from './V5Frame';
import { V5OperationalNotices } from './V5OperationalNotices';

/**
 * 023 Slice G — the layout route for the cashier's sale loop. `/app/cart` and
 * `/app/checkout` render inside one v5 frame, so the chrome never changes
 * mid-sale. Every other `/app/*` screen keeps the legacy AppShell.
 */
export function V5AppLayout(): JSX.Element {
  return (
    <V5Frame notices={<V5OperationalNotices />}>
      <Outlet />
    </V5Frame>
  );
}
