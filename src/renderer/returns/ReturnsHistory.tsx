import type { JSX } from 'react';

import type { ReturnJournalView } from '../../shared/returns/types.js';
import { ReturnNotice } from './ReturnNotice';
import { formatReturnMoney, formatReturnTime } from './returns-format.js';
import { OUTCOME_COPY, refusalMessage, stateLabel } from './returns-messages.js';
import type { HistoryState, ReturnHistory } from './useReturnHistory.js';

/**
 * RT-15 S3 — this terminal's recent returns, straight from `returns.list`
 * (H1..H3). It is where the true state of an unconfirmed or session-changed
 * submit is read. "Check again" re-sends unresolved returns through main's
 * resolver (same request, same key; never a second return).
 */
const UNRESOLVED: ReadonlySet<ReturnJournalView['state']> = new Set(['pending', 'unknown']);

function amountOf(row: ReturnJournalView): string {
  const minor = row.returnTotalMinor ?? row.quotedTotalMinor;
  return formatReturnMoney(minor, row.currencyCode);
}

function Row({ row }: { row: ReturnJournalView }): JSX.Element {
  return (
    <tr data-state={row.state}>
      <td>
        <bdi className="rt-num">{row.saleNumber}</bdi>
      </td>
      <td>
        <time dateTime={row.createdAt}>{formatReturnTime(row.createdAt)}</time>
      </td>
      <td>
        <span className={`rt-state rt-state--${row.state}`}>{stateLabel(row.state)}</span>
        {row.refusalReason !== null && (
          <span className="rt-state__reason">{refusalMessage(row.refusalReason)}</span>
        )}
      </td>
      <td>
        <bdi className="rt-num">{amountOf(row)}</bdi>
      </td>
      <td>
        <bdi className="rt-num rt-ref">{row.returnRef ?? '—'}</bdi>
      </td>
    </tr>
  );
}

function Rows({ rows }: { rows: readonly ReturnJournalView[] }): JSX.Element {
  if (rows.length === 0) return <p className="rt-returns__meta">{OUTCOME_COPY.historyEmpty}</p>;
  return (
    <table className="rt-table" aria-labelledby="rt-returns-history">
      <thead>
        <tr>
          <th scope="col">رقم البيع</th>
          <th scope="col">الوقت</th>
          <th scope="col">الحالة</th>
          <th scope="col">المبلغ</th>
          <th scope="col">مرجع الخادم</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Row key={row.returnId} row={row} />
        ))}
      </tbody>
    </table>
  );
}

function Body({ state }: { state: HistoryState }): JSX.Element {
  switch (state.status) {
    case 'loading':
      return <p className="rt-returns__meta">جارٍ تحميل السجل…</p>;
    case 'ok':
      return <Rows rows={state.rows} />;
    case 'refused':
      return <ReturnNotice notice={{ kind: 'refused', reason: state.reason }} />;
    case 'failed':
      return <ReturnNotice notice={{ kind: 'failed' }} />;
  }
}

function hasUnresolved(state: HistoryState): boolean {
  return state.status === 'ok' && state.rows.some((r) => UNRESOLVED.has(r.state));
}

export function ReturnsHistory({ history }: { history: ReturnHistory }): JSX.Element {
  return (
    <section className="rt-returns__panel" aria-labelledby="rt-returns-history">
      <div className="rt-returns__bar">
        <h2 id="rt-returns-history" className="rt-returns__heading">
          سجل المرتجعات على هذا الجهاز
        </h2>
        {hasUnresolved(history.state) && (
          <button
            type="button"
            className="rt-btn rt-btn--secondary"
            disabled={history.checking}
            aria-busy={history.checking}
            onClick={() => void history.checkUnresolved()}
          >
            تحقّق من غير المؤكدة
          </button>
        )}
      </div>
      <ReturnNotice notice={history.checkNotice} />
      <Body state={history.state} />
    </section>
  );
}
