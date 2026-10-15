/**
 * RT-500 (VN-S10 S10-3) — `/app/sales`, recomposed on the G-6 references: the
 * «المبيعات» screen in the one v5 frame, holding the find-a-sale-by-number
 * lookup with its receipt preview and reprint. The English dev `?state=`
 * gallery went with the legacy layout.
 */
import type { JSX } from 'react';
import { ScreenSection } from '../../v5/foundation/ScreenSection';
import { SALES_COPY } from '../../v5/manager/sales/sales-copy';
import { SalesLookup } from '../../v5/manager/sales/SalesLookup';

export function SalesWorkspace(): JSX.Element {
  return (
    <ScreenSection title={SALES_COPY.title}>
      <SalesLookup />
    </ScreenSection>
  );
}
