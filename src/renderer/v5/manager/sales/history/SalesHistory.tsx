import { useId, useMemo, useState, type JSX, type ReactNode, type SyntheticEvent } from 'react';

import type {
  ReceiptsBridgeAPI,
  SaleListItem,
  SalesBridgeAPI,
} from '../../../../../shared/bridge-api';
import { format as formatMoney, of as moneyOf } from '../../../../../shared/money';
import type {
  SaleHistoryBridgeAPI,
  SaleHistoryRow,
  SaleHistoryUnsyncedRow,
} from '../../../../../shared/sale-history/types';
import type { SaleId } from '../../../../../shared/sales/types';
import { businessDayOf } from '../../../../../shared/time/business-day';
import { Notice } from '../../../foundation/Notice';
import { HISTORY_COPY as C, refusalCopy, syncCopy } from './history-copy';
import { NameCell, StatusCell, stamp } from './history-cells';
import { HistoryDetail } from './HistoryDetail';
import { LocalSaleDetail } from './LocalSaleDetail';
import { useSaleHistory, type HistoryView } from './useSaleHistory';

/**
 * RT-542 (RT-534 S6) — «سجل مبيعات المتجر»: the store's sales by business day
 * (Africa/Cairo, from/to inclusive, at most 31 days), through Backend-Core.
 *
 * Honest, distinct states (RT-534 comment 12047): online "received by the
 * server up to HH:MM" (never "complete"), with this device's unsent sales
 * listed apart; offline "this device only / incomplete store view"; empty;
 * no permission; legacy names "not recorded"; ERP state operational only.
 * Who sees what (OD-534-1: a cashier their own sales across all tills) is
 * decided in the main process, not here.
 */

export interface SalesHistoryProps {
  _testBridge?: SaleHistoryBridgeAPI;
  _testSalesBridge?: SalesBridgeAPI;
  _testReceiptsBridge?: ReceiptsBridgeAPI;
  /** Injected clock for tests. */
  _now?: () => Date;
}

interface Api {
  saleHistory?: SaleHistoryBridgeAPI;
  sales?: SalesBridgeAPI;
}

function windowApi(): Api {
  return (window as unknown as { api?: Api }).api ?? {};
}

type Selection = { kind: 'server'; saleRef: string } | { kind: 'local'; saleId: SaleId } | null;

interface Range {
  from_day: string;
  to_day: string;
}

type LocalRow = SaleListItem | SaleHistoryUnsyncedRow;

function egp(minor: number): string {
  return formatMoney(moneyOf(minor, 'EGP'));
}

/** The business day before `day` (`YYYY-MM-DD`), by calendar arithmetic. */
function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function StatusNotice({ view }: { view: HistoryView }): JSX.Element | null {
  if (view.phase === 'server') {
    return (
      <Notice tone="info" testId="history-coverage">
        {C.receivedUpTo(stamp(view.meta.as_of))}
        {view.meta.visibility === 'own_sales' && <> {C.ownSalesOnly}</>}
      </Notice>
    );
  }
  if (view.phase === 'local') {
    const why = view.reason === 'no_connection' ? C.offlineNoConnection : C.offlineNoCredential;
    return (
      <Notice tone="warning" testId="history-coverage">
        {C.deviceOnly} {why}
      </Notice>
    );
  }
  if (view.phase !== 'refused') return null;
  return (
    <Notice tone="warning" testId="history-refused">
      {refusalCopy(view.reason)}
    </Notice>
  );
}

const serverCells = (row: SaleHistoryRow): ReactNode[] => [
  <bdi key="n" dir="ltr">
    {row.sale_number ?? C.notRecorded}
  </bdi>,
  stamp(row.occurred_at),
  <NameCell key="o" value={row.operator_display_name} source={row.operator_name_source} />,
  <NameCell key="d" value={row.device_label} source={row.device_label_source} />,
  egp(row.total_minor),
  <StatusCell key="s" row={row} />,
];

const localCells = (row: LocalRow): ReactNode[] => [
  <bdi key="n" dir="ltr">
    {row.sale_number}
  </bdi>,
  stamp(row.finalized_at),
  <bdi key="o">{row.selling_operator_display_name}</bdi>,
  <bdi key="d" dir="ltr">
    {row.terminal_label}
  </bdi>,
  egp(row.subtotal_minor),
  'sync' in row ? syncCopy(row.sync) : '',
];

const HEADS = [
  C.columns.number,
  C.columns.time,
  C.columns.operator,
  C.columns.device,
  C.columns.total,
  C.columns.status,
  C.open,
];

/** One history table: the shared columns, one "details" button per row. */
function HistoryTable<T>({
  rows,
  keyOf,
  cells,
  onOpen,
  testId,
}: {
  rows: T[];
  keyOf: (row: T) => string;
  cells: (row: T) => ReactNode[];
  onOpen: (row: T) => void;
  testId?: string;
}): JSX.Element {
  return (
    <table className="v5-history-table" data-testid={testId}>
      <thead>
        <tr>
          {HEADS.map((head) => (
            <th key={head} scope="col">
              {head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={keyOf(row)}>
            {cells(row).map((cell, index) => (
              <td key={String(index)}>{cell}</td>
            ))}
            <td>
              <button
                type="button"
                className="v5-sales-btn"
                onClick={() => {
                  onOpen(row);
                }}
              >
                {C.open}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MoreControl({
  view,
  onMore,
}: {
  view: HistoryView;
  onMore: () => void;
}): JSX.Element | null {
  if (view.phase !== 'server' && view.phase !== 'local') return null;
  if (view.more.kind === 'failed') {
    return (
      <div className="v5-sales-notice-row">
        <Notice tone="warning" testId="history-more-failed">
          {refusalCopy(view.more.reason)}
        </Notice>
        <button type="button" className="v5-sales-btn" onClick={onMore}>
          {C.retry}
        </button>
      </div>
    );
  }
  if (view.cursor === null) return null;
  const loading = view.more.kind === 'loading';
  return (
    <button type="button" className="v5-sales-btn" disabled={loading} onClick={onMore}>
      {loading ? C.loading : C.loadMore}
    </button>
  );
}

function Unsynced({
  rows,
  truncated,
  onOpen,
}: {
  rows: SaleHistoryUnsyncedRow[];
  truncated: boolean;
  onOpen: (row: LocalRow) => void;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <section aria-label={C.unsyncedHeading} data-testid="history-unsynced">
      <h3>{C.unsyncedHeading}</h3>
      {truncated && <p className="v5-history-note">{C.unsyncedTruncated}</p>}
      <HistoryTable rows={rows} keyOf={(r) => r.sale_id} cells={localCells} onOpen={onOpen} />
    </section>
  );
}

function EmptyNotice(): JSX.Element {
  return (
    <Notice tone="info" testId="history-empty">
      {C.empty}
    </Notice>
  );
}

function Results({
  view,
  onSelect,
}: {
  view: HistoryView;
  onSelect: (s: Selection) => void;
}): JSX.Element | null {
  const openLocal = (row: LocalRow): void => {
    onSelect({ kind: 'local', saleId: row.sale_id });
  };
  if (view.phase === 'local') {
    if (view.rows.length === 0) return <EmptyNotice />;
    return (
      <HistoryTable
        rows={view.rows}
        keyOf={(r) => r.sale_id}
        cells={localCells}
        onOpen={openLocal}
        testId="history-rows"
      />
    );
  }
  if (view.phase !== 'server') return null;
  const { unsynced, unsynced_truncated: truncated } = view.meta;
  return (
    <>
      <Unsynced rows={unsynced} truncated={truncated} onOpen={openLocal} />
      {view.rows.length === 0 && unsynced.length === 0 && <EmptyNotice />}
      {view.rows.length > 0 && (
        <HistoryTable
          rows={view.rows}
          keyOf={(r) => r.sale_ref}
          cells={serverCells}
          onOpen={(row) => {
            onSelect({ kind: 'server', saleRef: row.sale_ref });
          }}
          testId="history-rows"
        />
      )}
    </>
  );
}

function DayField({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: string;
  max: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="v5-sales-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="v5-sales-input"
        type="date"
        dir="ltr"
        value={value}
        max={max}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </div>
  );
}

function RangeForm({
  today,
  busy,
  onRun,
}: {
  today: string;
  busy: boolean;
  onRun: (range: Range) => void;
}): JSX.Element {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const run = (range: Range): void => {
    setFrom(range.from_day);
    setTo(range.to_day);
    onRun(range);
  };
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    run({ from_day: from, to_day: to });
  };
  const yesterday = dayBefore(today);
  return (
    <form className="v5-sales-lookup" onSubmit={onSubmit} noValidate>
      <DayField label={C.from} value={from} max={today} onChange={setFrom} />
      <DayField label={C.to} value={to} max={today} onChange={setTo} />
      <button type="submit" className="v5-sales-btn v5-sales-btn--primary" disabled={busy}>
        {C.show}
      </button>
      <button
        type="button"
        className="v5-sales-btn"
        disabled={busy}
        onClick={() => {
          run({ from_day: today, to_day: today });
        }}
      >
        {C.today}
      </button>
      <button
        type="button"
        className="v5-sales-btn"
        disabled={busy}
        onClick={() => {
          run({ from_day: yesterday, to_day: yesterday });
        }}
      >
        {C.yesterday}
      </button>
    </form>
  );
}

function SelectedDetail({
  selected,
  bridge,
  sales,
  receipts,
  onClose,
}: {
  selected: Selection;
  bridge: SaleHistoryBridgeAPI | null;
  sales: SalesBridgeAPI | null;
  receipts: ReceiptsBridgeAPI | undefined;
  onClose: () => void;
}): JSX.Element | null {
  if (selected?.kind === 'server' && bridge !== null) {
    return <HistoryDetail saleRef={selected.saleRef} bridge={bridge} onClose={onClose} />;
  }
  if (selected?.kind !== 'local' || sales === null) return null;
  return (
    <LocalSaleDetail
      saleId={selected.saleId}
      sales={sales}
      {...(receipts === undefined ? {} : { receipts })}
      onClose={onClose}
    />
  );
}

export function SalesHistory({
  _testBridge,
  _testSalesBridge,
  _testReceiptsBridge,
  _now,
}: SalesHistoryProps): JSX.Element {
  const headingId = useId();
  const api = windowApi();
  const bridge = _testBridge ?? api.saleHistory ?? null;
  const sales = _testSalesBridge ?? api.sales ?? null;
  const today = useMemo(() => businessDayOf(_now === undefined ? new Date() : _now()), [_now]);
  const [selected, setSelected] = useState<Selection>(null);
  const history = useSaleHistory(bridge);
  const loading = history.view.phase === 'loading';

  return (
    <section className="v5-sales-panel" aria-labelledby={headingId} data-testid="sales-history">
      <div className="v5-sales-panel-head">
        <h2 id={headingId}>{C.heading}</h2>
      </div>
      <div className="v5-sales-panel-body">
        <RangeForm
          today={today}
          busy={loading || bridge === null}
          onRun={(range) => {
            setSelected(null);
            void history.search(range);
          }}
        />
        {loading && <p role="status">{C.loading}</p>}
        <StatusNotice view={history.view} />
        <Results view={history.view} onSelect={setSelected} />
        <MoreControl view={history.view} onMore={() => void history.loadMore()} />
        <SelectedDetail
          selected={selected}
          bridge={bridge}
          sales={sales}
          receipts={_testReceiptsBridge}
          onClose={() => {
            setSelected(null);
          }}
        />
      </div>
    </section>
  );
}
