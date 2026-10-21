import type { JSX } from 'react';

import type { ReturnJournalView } from '../../shared/returns/types.js';
import { ToneIcon } from '../v5/foundation/ToneIcon';
import type { IconName } from '../icons/registry';
import { ReturnNotice } from './ReturnNotice';
import { ReturnsPanel, StatePill } from './ReturnsPanel';
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
const HEADING_ID = 'v5-returns-history';

const UNRESOLVED: ReadonlySet<ReturnJournalView['state']> = new Set(['pending', 'unknown']);

/** RD-5: one glyph per state, so a state never rests on colour alone. */
const STATE_ICON: Readonly<Record<ReturnJournalView['state'], IconName>> = {
  pending: 'shift',
  confirmed: 'status.success',
  paid_out: 'cash',
  refused: 'status.danger',
  unknown: 'status.unknown',
};

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

function RowActionButton({
  row,
  actions,
}: Readonly<{ row: ReturnJournalView; actions: HistoryActions }>) {
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
      className="v5-manager-btn v5-btn"
      aria-label={`${ACTION_LABEL[action]} ${row.saleNumber}`}
      disabled={reprint.printing !== null && action === 'reprint'}
      aria-busy={printing}
      onClick={onClick}
    >
      {ACTION_LABEL[action]}
    </button>
  );
}

function Row({
  row,
  actions,
}: Readonly<{ row: ReturnJournalView; actions: HistoryActions }>): JSX.Element {
  return (
    <tr data-state={row.state}>
      <td>
        <bdi className="v5-manager-num v5-returns-code">{row.saleNumber}</bdi>
      </td>
      <td>
        <time dateTime={row.createdAt}>{formatReturnTime(row.createdAt)}</time>
      </td>
      <td>
        <StatePill state={row.state} icon={STATE_ICON[row.state]}>
          {stateLabel(row.state)}
        </StatePill>
        {row.refusalReason !== null && (
          <span className="v5-returns-state__reason">{refusalMessage(row.refusalReason)}</span>
        )}
      </td>
      <td>
        <bdi className="v5-manager-num">{amountOf(row)}</bdi>
      </td>
      <td>
        <bdi className="v5-manager-num v5-returns-code">{row.returnRef ?? '—'}</bdi>
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
}: Readonly<{
  rows: readonly ReturnJournalView[];
  actions: HistoryActions;
}>): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="v5-notice" data-tone="neutral">
        <ToneIcon tone="info" />
        <p className="v5-notice__text">{OUTCOME_COPY.historyEmpty}</p>
      </div>
    );
  }
  return (
    <table className="v5-returns-table v5-returns-table--journal" aria-labelledby={HEADING_ID}>
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
function Reload({ history }: Readonly<{ history: ReturnHistory }>): JSX.Element | null {
  const { status } = history.state;
  if (status !== 'failed' && status !== 'refused') return null;
  return (
    <button type="button" className="v5-manager-btn v5-btn" onClick={() => void history.reload()}>
      إعادة تحميل السجل
    </button>
  );
}

function Body({
  state,
  actions,
}: Readonly<{ state: HistoryState; actions: HistoryActions }>): JSX.Element {
  switch (state.status) {
    case 'loading':
      return <p className="v5-returns-meta">جارٍ تحميل السجل…</p>;
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
function ReprintNotice({ reprint }: Readonly<{ reprint: HistoryReprint }>): JSX.Element | null {
  if (reprint.result === null) return null;
  if (reprint.result.kind === 'printed') {
    return <output className="v5-returns-meta">{reprintMessage(reprint.result)}</output>;
  }
  return (
    <output className="v5-notice" data-tone="danger">
      <ToneIcon tone="danger" />
      <span className="v5-notice__text">{reprintMessage(reprint.result)}</span>
    </output>
  );
}

function hasNotice(history: ReturnHistory, actions: HistoryActions): boolean {
  return history.checkNotice !== null || actions.reprint.result !== null;
}

export function ReturnsHistory({
  history,
  actions,
}: Readonly<{
  history: ReturnHistory;
  actions: HistoryActions;
}>): JSX.Element {
  const { state } = history;
  const bar = hasUnresolved(state) ? (
    <button
      type="button"
      className="v5-manager-btn v5-btn"
      disabled={history.checking}
      aria-busy={history.checking}
      onClick={() => void history.checkUnresolved()}
    >
      تحقّق من غير المؤكدة
    </button>
  ) : null;
  return (
    <ReturnsPanel id={HEADING_ID} title="سجل المرتجعات على هذا الجهاز" bar={bar} journal>
      {hasNotice(history, actions) && (
        <div className="v5-manager-panel__body v5-returns-journal__notices">
          <ReturnNotice notice={history.checkNotice} />
          <ReprintNotice reprint={actions.reprint} />
        </div>
      )}
      {state.status === 'ok' && state.rows.length > 0 ? (
        // RD-3: the journal reaches the foot of the screen and only its table scrolls.
        <div className="v5-returns-table-scroll">
          <Rows rows={state.rows} actions={actions} />
        </div>
      ) : (
        <div className="v5-manager-panel__body">
          <Body state={state} actions={actions} />
          <Reload history={history} />
        </div>
      )}
    </ReturnsPanel>
  );
}
