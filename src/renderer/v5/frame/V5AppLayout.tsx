import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';
import { V5Frame } from './V5Frame';
import { V5OperationalNotices } from './V5OperationalNotices';

/**
 * 023 Slice G — the layout route for the cashier's sale loop: `/app/cart` and
 * `/app/checkout` render inside one v5 frame, so the chrome never changes
 * mid-sale. RT-498 (VN-S10 S10-1): it is the one layout for every `/app/*`
 * screen; RT-504 (S10-Z) deleted the legacy AppShell.
 */
export function V5AppLayout(): JSX.Element {
  return (
    <V5Frame notices={<V5OperationalNotices />}>
      <Outlet />
    </V5Frame>
  );
}
