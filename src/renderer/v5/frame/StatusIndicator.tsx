import { useEffect, type JSX } from 'react';
import {
  mapTerminalStatus,
  printerRow,
  type IndicatorRow,
  type IndicatorTone,
} from '../../terminal-status/status-mapping';
import {
  connectTerminalStatus,
  terminalStatusBridge,
  useTerminalStatusStore,
} from '../../terminal-status/terminal-status-store';
import { useAttentionDeadline } from '../../terminal-status/use-attention-deadline';
import { useBannerState } from '../../ui/receipts/useBannerState';
import { Icon } from '../../icons/Icon';
import type { IconName } from '../../icons/registry';
import './status-indicator.css';

/** Each tone has its own glyph shape, so a row is never told by colour alone. */
const MARK: Readonly<Record<IndicatorTone, IconName>> = {
  success: 'status.success',
  warning: 'status.warning',
  info: 'status.info',
  danger: 'status.danger',
  neutral: 'status.neutral',
};

function RowContent({ row }: Readonly<{ row: IndicatorRow }>): JSX.Element {
  return (
    <>
      <span className="v5-status__mark">
        <Icon name={MARK[row.tone]} size="sm" />
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
