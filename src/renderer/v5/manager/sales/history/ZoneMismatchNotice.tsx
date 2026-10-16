import { useEffect, useState, type JSX } from 'react';

import type {
  SaleHistoryBridgeAPI,
  SaleHistoryZoneStatus,
} from '../../../../../shared/sale-history/types';
import { Notice } from '../../../foundation/Notice';
import { HISTORY_COPY as C } from './history-copy';
import type { HistoryView } from './useSaleHistory';

/**
 * RT-553 (RT-545 S4) — the store's time zone differs from this terminal's.
 * Main decides (`saleHistory.zoneStatus`); this only asks and shows. The notice
 * never blocks selling or changes the zone in use. It is read on mount and after
 * every history answer, and it is absent while the status is unknown or matches.
 */
function useZoneStatus(
  bridge: SaleHistoryBridgeAPI | null,
  view: HistoryView,
): SaleHistoryZoneStatus | null {
  const [status, setStatus] = useState<SaleHistoryZoneStatus | null>(null);
  const loading = view.phase === 'loading';

  useEffect(() => {
    if (bridge === null || loading) return;
    let current = true;
    // A refusal or a failed call keeps what is shown: it says nothing about the zone.
    bridge
      .zoneStatus({})
      .then((answer) => {
        if (current && answer.kind === 'ok') setStatus(answer);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bridge, loading, view]);

  return status;
}

export function ZoneMismatchNotice({
  bridge,
  view,
}: Readonly<{ bridge: SaleHistoryBridgeAPI | null; view: HistoryView }>): JSX.Element | null {
  const status = useZoneStatus(bridge, view);
  if (status?.status !== 'mismatch') return null;
  return (
    <Notice tone="warning" testId="history-zone-mismatch">
      <strong>{C.zoneMismatchTitle}</strong>{' '}
      <span>
        {C.zoneStore} <bdi dir="ltr">{status.reported ?? C.zoneUnreadable}</bdi>
        {' — '}
        {C.zoneTerminal} <bdi dir="ltr">{status.expected}</bdi>.
      </span>{' '}
      {C.zoneMismatchBody}
    </Notice>
  );
}
