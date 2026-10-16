import { useId, useState, type JSX, type ReactNode, type SyntheticEvent } from 'react';

import type {
  ReceiptsBridgeAPI,
  SaleListItem,
  SalesBridgeAPI,
} from '../../../../../shared/bridge-api';
import { format as formatMoney, of as moneyOf } from '../../../../../shared/money';
import type {
  SaleHistoryBridgeAPI,
  SaleHistoryLocalPage,
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

const OFFLINE_COPY: Readonly<Record<SaleHistoryLocalPage['offline_reason'], string>> = {
  no_connection: C.offlineNoConnection,
  no_credential: C.offlineNoCredential,
  server_unavailable: C.offlineServerUnavailable,
};

function StatusNotice({ view }: Readonly<{ view: HistoryView }>): JSX.Element | null {
  if (view.phase === 'server') {
    return (
      <Notice tone="info" testId="history-coverage">
        {C.receivedUpTo(stamp(view.meta.as_of))}
        {view.meta.visibility === 'own_sales' && <> {C.ownSalesOnly}</>}
      </Notice>
    );
  }
  if (view.phase === 'local') {
    return (
      <Notice tone="warning" testId="history-coverage">
        {C.deviceOnly} {OFFLINE_COPY[view.reason]}
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

const COLUMNS = ['number', 'time', 'operator', 'device', 'total', 'status'] as const;

type Cells = Readonly<Record<(typeof COLUMNS)[number], ReactNode>>;

const serverCells = (row: SaleHistoryRow): Cells => ({
  number: <bdi dir="ltr">{row.sale_number ?? C.notRecorded}</bdi>,
  time: stamp(row.occurred_at),
  operator: <NameCell value={row.operator_display_name} source={row.operator_name_source} />,
  device: <NameCell value={row.device_label} source={row.device_label_source} />,
  total: egp(row.total_minor),
  status: <StatusCell row={row} />,
});

const localCells = (row: LocalRow): Cells => ({
  number: <bdi dir="ltr">{row.sale_number}</bdi>,
  time: stamp(row.finalized_at),
  operator: <bdi>{row.selling_operator_display_name}</bdi>,
  device: <bdi dir="ltr">{row.terminal_label}</bdi>,
  total: egp(row.subtotal_minor),
  status: 'sync' in row ? syncCopy(row.sync) : '',
});

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
}: Readonly<{
  rows: T[];
  keyOf: (row: T) => string;
  cells: (row: T) => Cells;
  onOpen: (row: T) => void;
  testId?: string;
}>): JSX.Element {
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
            {COLUMNS.map((column) => (
              <td key={column}>{cells(row)[column]}</td>
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
}: Readonly<{
  view: HistoryView;
  onMore: () => void;
}>): JSX.Element | null {
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
}: Readonly<{
  rows: SaleHistoryUnsyncedRow[];
  truncated: boolean;
  onOpen: (row: LocalRow) => void;
}>): JSX.Element | null {
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
}: Readonly<{
  view: HistoryView;
  onSelect: (s: Selection) => void;
}>): JSX.Element | null {
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
}: Readonly<{
  label: string;
  value: string;
  max: string;
  onChange: (value: string) => void;
}>): JSX.Element {
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
  currentDay,
  busy,
  onRun,
}: Readonly<{
  /** Read at render and at click time, so "today" moves past Cairo midnight. */
  currentDay: () => string;
  busy: boolean;
  onRun: (range: Range) => void;
}>): JSX.Element {
  const [from, setFrom] = useState(currentDay);
  const [to, setTo] = useState(currentDay);
  const today = currentDay();
  const run = (range: Range): void => {
    setFrom(range.from_day);
    setTo(range.to_day);
    onRun(range);
  };
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    run({ from_day: from, to_day: to });
  };
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
          const day = currentDay();
          run({ from_day: day, to_day: day });
        }}
      >
        {C.today}
      </button>
      <button
        type="button"
        className="v5-sales-btn"
        disabled={busy}
        onClick={() => {
          const day = dayBefore(currentDay());
          run({ from_day: day, to_day: day });
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
}: Readonly<{
  selected: Selection;
  bridge: SaleHistoryBridgeAPI | null;
  sales: SalesBridgeAPI | null;
  receipts: ReceiptsBridgeAPI | undefined;
  onClose: () => void;
}>): JSX.Element | null {
  if (selected?.kind === 'server' && bridge !== null) {
    // Keyed by sale: an in-flight reprint of one sale never reports on another.
    return (
      <HistoryDetail
        key={selected.saleRef}
        saleRef={selected.saleRef}
        bridge={bridge}
        onClose={onClose}
      />
    );
  }
  if (selected?.kind !== 'local' || sales === null) return null;
  return (
    <LocalSaleDetail
      key={selected.saleId}
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
}: Readonly<SalesHistoryProps>): JSX.Element {
  const headingId = useId();
  const api = windowApi();
  const bridge = _testBridge ?? api.saleHistory ?? null;
  const sales = _testSalesBridge ?? api.sales ?? null;
  const currentDay = (): string => businessDayOf(_now === undefined ? new Date() : _now());
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
          currentDay={currentDay}
          busy={loading || bridge === null}
          onRun={(range) => {
            setSelected(null);
            void history.search(range);
          }}
        />
        {loading && <output>{C.loading}</output>}
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
