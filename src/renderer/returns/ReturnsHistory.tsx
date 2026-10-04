import type { JSX } from 'react';

import type { ReturnJournalView } from '../../shared/returns/types.js';
import { ReturnNotice } from './ReturnNotice';
import { formatReturnMoney, formatReturnTime } from './returns-format.js';
import {
  OUTCOME_COPY,
  PAYOUT_COPY,
  refusalMessage,
  reprintMessage,
  stateLabel,
} from './returns-messages.js';
import type { HistoryReprint } from './useHistoryReprint.js';
import type { HistoryState, ReturnHistory } from './useReturnHistory.js';

/**
 * RT-15 S3 — this terminal's recent returns, straight from `returns.list`
 * (H1..H3). It is where the true state of an unconfirmed or session-changed
 * submit is read. "Check again" re-sends unresolved returns through main's
 * resolver (same request, same key; never a second return).
 *
 * RT-15 S4 (R5): each row offers the one payout action it allows: a
 * confirmed return "pay out", a started-but-unpaid payout "complete" (never a
 * fresh start), a paid-out return "print a copy" of its slip.
 */
const UNRESOLVED: ReadonlySet<ReturnJournalView['state']> = new Set(['pending', 'unknown']);

function amountOf(row: ReturnJournalView): string {
  const minor = row.returnTotalMinor ?? row.quotedTotalMinor;
  return formatReturnMoney(minor, row.currencyCode);
}

/** RT-15 S4: what the journal can do with a row. */
export interface HistoryActions {
  /** Show a confirmed return's payout (start or complete). */
  readonly pay: (row: ReturnJournalView) => void;
  readonly reprint: HistoryReprint;
}

type RowAction = 'pay' | 'complete' | 'reprint' | null;

function rowAction(row: ReturnJournalView): RowAction {
  if (row.state === 'paid_out') return 'reprint';
  if (row.state !== 'confirmed') return null;
  return row.payout === null ? 'pay' : 'complete';
}

const ACTION_LABEL: Readonly<Record<Exclude<RowAction, null>, string>> = {
  pay: PAYOUT_COPY.historyPay,
  complete: PAYOUT_COPY.historyComplete,
  reprint: PAYOUT_COPY.historyReprint,
};

function RowActionButton({ row, actions }: { row: ReturnJournalView; actions: HistoryActions }) {
  const action = rowAction(row);
  if (action === null) return null;
  const { reprint } = actions;
  const printing = reprint.printing === row.returnId;
  const onClick = (): void => {
    if (action === 'reprint') void reprint.run(row.returnId);
    else actions.pay(row);
  };
  return (
    <button
      type="button"
      className="rt-btn"
      aria-label={`${ACTION_LABEL[action]} ${row.saleNumber}`}
      disabled={reprint.printing !== null && action === 'reprint'}
      aria-busy={printing}
      onClick={onClick}
    >
      {ACTION_LABEL[action]}
    </button>
  );
}

function Row({ row, actions }: { row: ReturnJournalView; actions: HistoryActions }): JSX.Element {
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
      <td>
        <RowActionButton row={row} actions={actions} />
      </td>
    </tr>
  );
}

function Rows({
  rows,
  actions,
}: {
  rows: readonly ReturnJournalView[];
  actions: HistoryActions;
}): JSX.Element {
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
          <th scope="col">{PAYOUT_COPY.historyAction}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Row key={row.returnId} row={row} actions={actions} />
        ))}
      </tbody>
    </table>
  );
}

/** H4: a list main did not give is never a dead end. */
function Reload({ history }: { history: ReturnHistory }): JSX.Element | null {
  const { status } = history.state;
  if (status !== 'failed' && status !== 'refused') return null;
  return (
    <button
      type="button"
      className="rt-btn rt-btn--secondary"
      onClick={() => void history.reload()}
    >
      إعادة تحميل السجل
    </button>
  );
}

function Body({ state, actions }: { state: HistoryState; actions: HistoryActions }): JSX.Element {
  switch (state.status) {
    case 'loading':
      return <p className="rt-returns__meta">جارٍ تحميل السجل…</p>;
    case 'ok':
      return <Rows rows={state.rows} actions={actions} />;
    case 'refused':
      return <ReturnNotice notice={{ kind: 'refused', reason: state.reason }} />;
    case 'failed':
      return <ReturnNotice notice={{ kind: 'failed' }} />;
  }
}

function hasUnresolved(state: HistoryState): boolean {
  return state.status === 'ok' && state.rows.some((r) => UNRESOLVED.has(r.state));
}

/** The last journal reprint's result, announced politely. */
function ReprintNotice({ reprint }: { reprint: HistoryReprint }): JSX.Element | null {
  if (reprint.result === null) return null;
  const printed = reprint.result.kind === 'printed';
  return (
    <p className={printed ? 'rt-returns__meta' : 'rt-returns__notice'} role="status">
      {reprintMessage(reprint.result)}
    </p>
  );
}

export function ReturnsHistory({
  history,
  actions,
}: {
  history: ReturnHistory;
  actions: HistoryActions;
}): JSX.Element {
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
      <ReprintNotice reprint={actions.reprint} />
      <Body state={history.state} actions={actions} />
      <Reload history={history} />
    </section>
  );
}
