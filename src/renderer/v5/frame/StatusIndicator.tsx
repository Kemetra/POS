import { useEffect, useState, type JSX } from 'react';
import {
  mapTerminalStatus,
  printerRow,
  syncAttentionDueAt,
  type IndicatorRow,
  type IndicatorTone,
} from '../../terminal-status/status-mapping';
import {
  connectTerminalStatus,
  terminalStatusBridge,
  useTerminalStatusStore,
} from '../../terminal-status/terminal-status-store';
import type { TerminalStatusSnapshot } from '../../../shared/terminal-status/types';
import { useBannerState } from '../../ui/receipts/useBannerState';
import { V5Icon, type V5IconName } from '../foundation/V5Icon';
import './status-indicator.css';

/** Each tone has its own glyph shape, so a row is never told by colour alone. */
const MARK: Readonly<Record<IndicatorTone, V5IconName>> = {
  success: 'status-success',
  warning: 'status-warning',
  info: 'status-info',
  danger: 'status-danger',
  neutral: 'dash',
};

/**
 * Re-renders once when the oldest pending sale passes the 24 h attention line
 * (D-6-5). One timer for that moment, never a poll; a new snapshot re-arms it.
 */
function useAttentionDeadline(snapshot: TerminalStatusSnapshot | null): void {
  const [, setPassed] = useState(0);
  useEffect(() => {
    const due = syncAttentionDueAt(snapshot);
    if (due === null) return;
    const wait = due - Date.now() + 1;
    if (wait <= 0) return;
    const handle = setTimeout(() => {
      setPassed((n) => n + 1);
    }, wait);
    return () => {
      clearTimeout(handle);
    };
  }, [snapshot]);
}

function RowContent({ row }: Readonly<{ row: IndicatorRow }>): JSX.Element {
  return (
    <>
      <span className="v5-status__mark">
        <V5Icon name={MARK[row.tone]} size={16} />
      </span>
      <span className="v5-status__text">
        {row.before}
        {row.count !== null && (
          <span className="v5-status__num" dir="ltr">
            {String(row.count)}
          </span>
        )}
        {row.after}
      </span>
    </>
  );
}

/**
 * RT-604 (VN-S6 S6-3, doc 24 §4.2) — the nav footer's status indicator
 * (DESIGN.md §Navigation): connection, sale sync and printer, each a glyph
 * plus text. Fed by the `terminalStatus` push; the printer row reads the
 * existing `banner_state` feed and appears only while the last print failed.
 *
 * Only the connection row is a polite live region, so a connection change is
 * announced and a count change is not. In the slim rail the rows collapse to
 * their glyphs; the text stays in the accessibility tree.
 */
export function StatusIndicator(): JSX.Element {
  const snapshot = useTerminalStatusStore((s) => s.snapshot);
  useEffect(() => connectTerminalStatus(terminalStatusBridge()), []);
  useAttentionDeadline(snapshot);
  const printFailure = useBannerState();

  const view = mapTerminalStatus(snapshot, Date.now());
  const printer = printerRow(printFailure !== null);

  return (
    <div className="v5-status" data-testid="v5-status-indicator">
      <p
        className="v5-status__row"
        data-row="connection"
        data-tone={view.connection.tone}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <RowContent row={view.connection} />
      </p>
      {view.sync !== null && (
        <p className="v5-status__row" data-row="sync" data-tone={view.sync.tone}>
          <RowContent row={view.sync} />
        </p>
      )}
      {printer !== null && (
        <p className="v5-status__row" data-row="printer" data-tone={printer.tone}>
          <RowContent row={printer} />
        </p>
      )}
    </div>
  );
}
