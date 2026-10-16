import type { JSX } from 'react';

import type {
  SaleHistoryNameSource,
  SaleHistoryRow,
} from '../../../../../shared/sale-history/types';
import { businessDateTimeOf } from '../../../../../shared/time/business-day';
import { HISTORY_COPY as C, erpCopy } from './history-copy';

/** The store-zone (Africa/Cairo) `YYYY-MM-DD HH:MM` of an instant; the raw value if unreadable. */
export function stamp(instant: string): string {
  try {
    return businessDateTimeOf(instant);
  } catch {
    return instant;
  }
}

/**
 * A recorded name (OD-534-6): a snapshot as is, a current name labelled as
 * current, an absent one "not recorded" — never a guess, never an email.
 */
export function NameCell({
  value,
  source,
}: Readonly<{
  value: string | null;
  source: SaleHistoryNameSource;
}>): JSX.Element {
  if (value === null || source === 'unavailable') return <span>{C.notRecorded}</span>;
  return (
    <span>
      <bdi>{value}</bdi>
      {source === 'current' && <> {C.currentName}</>}
    </span>
  );
}

/** The reversal marks and the operational ERP state of a server row. */
export function StatusCell({ row }: Readonly<{ row: SaleHistoryRow }>): JSX.Element {
  const marks: string[] = [];
  if (row.voided) marks.push(C.voided);
  if (row.return_state === 'partial') marks.push(C.returnedPartial);
  if (row.return_state === 'full') marks.push(C.returnedFull);
  marks.push(erpCopy(row.erp_state));
  return <span>{marks.join(' · ')}</span>;
}
