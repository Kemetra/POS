import { useEffect, useId, useRef, useState, type JSX } from 'react';

import { format as formatMoney, of as moneyOf } from '../../../../../shared/money';
import type {
  SaleHistoryBridgeAPI,
  SaleHistoryDetail,
  SaleHistoryReprintKind,
  SaleHistoryReadResponse,
  SaleHistoryReprintResponse,
  SaleHistoryRefusalReason,
} from '../../../../../shared/sale-history/types';
import { Notice } from '../../../foundation/Notice';
import { HISTORY_COPY as C, erpCopy, refusalCopy } from './history-copy';
import { NameCell, stamp } from './history-cells';

/**
 * RT-542 — one sale from the store history: every recorded fact Backend-Core
 * holds (lines, tenders, change, void, returns, ERP state), each unrecorded
 * block labelled, and the reprint the server will allow (OD-534-3/8): a true
 * duplicate only when every receipt fact is recorded and the sale is not
 * voided; otherwise a labelled sale record. The main process enforces who may
 * open and reprint it (OD-534-1/2); this view only shows the answer.
 */

export interface HistoryDetailProps {
  saleRef: string;
  bridge: SaleHistoryBridgeAPI;
  onClose: () => void;
}

type Load =
  | { phase: 'loading' }
  | { phase: 'ok'; detail: SaleHistoryDetail }
  | { phase: 'refused'; reason: SaleHistoryRefusalReason };

type Print =
  | { phase: 'idle' }
  | { phase: 'printing' }
  | { phase: 'done'; res: SaleHistoryReprintResponse };

function egp(minor: number): string {
  return formatMoney(moneyOf(minor, 'EGP'));
}

function Lines({ detail }: Readonly<{ detail: SaleHistoryDetail }>): JSX.Element {
  return (
    <section aria-label={C.lines}>
      <h4>{C.lines}</h4>
      {detail.line_order === 'not_recorded' && (
        <p className="v5-history-note">{C.lineOrderNotRecorded}</p>
      )}
      <ul className="v5-history-lines">
        {detail.lines.map((line) => (
          <li key={line.line_ref}>
            <bdi>{line.name}</bdi> <bdi dir="ltr">× {line.quantity}</bdi>
            <span dir="ltr">{egp(line.line_minor)}</span>
          </li>
        ))}
      </ul>
      <p className="v5-history-total" dir="ltr">
        {egp(detail.summary.total_minor)}
      </p>
    </section>
  );
}

function Tenders({ detail }: Readonly<{ detail: SaleHistoryDetail }>): JSX.Element {
  return (
    <section aria-label={C.tenders}>
      <h4>{C.tenders}</h4>
      {detail.tender_state === 'unknown' ? (
        <p className="v5-history-note">{C.tenderUnknown}</p>
      ) : (
        <ul className="v5-history-lines">
          {detail.tenders.map((tender, index) => (
            <li key={`${tender.method}-${String(index)}`}>
              {tender.method === 'cash' ? C.cash : C.card}
              <span dir="ltr">{egp(tender.amount_minor)}</span>
            </li>
          ))}
          <li>
            {C.change}
            <span dir="ltr">
              {detail.change_minor === null ? C.notRecorded : egp(detail.change_minor)}
            </span>
          </li>
        </ul>
      )}
    </section>
  );
}

function Reversals({ detail }: Readonly<{ detail: SaleHistoryDetail }>): JSX.Element | null {
  if (detail.void === null && detail.returns.length === 0) return null;
  return (
    <section aria-label={C.returns}>
      {detail.void !== null && (
        <p className="v5-history-mark" data-testid="history-voided">
          {C.voided} — {C.voidedAt} <bdi dir="ltr">{stamp(detail.void.voided_at)}</bdi>
        </p>
      )}
      {detail.returns.length > 0 && (
        <>
          <h4>{C.returns}</h4>
          <ul className="v5-history-lines">
            {detail.returns.map((entry) => (
              <li key={entry.return_ref}>
                <bdi dir="ltr">{stamp(entry.recorded_at)}</bdi>
                <span dir="ltr">{egp(entry.total_minor)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Erp({ detail }: Readonly<{ detail: SaleHistoryDetail }>): JSX.Element {
  const ref = detail.erp.sale === 'posted' ? detail.erp.sale_document_ref : null;
  return (
    <section aria-label={C.erpHeading}>
      <h4>{C.erpHeading}</h4>
      <p data-testid="history-erp">
        {erpCopy(detail.erp.sale)}
        {ref !== null && (
          <>
            {' '}
            <bdi dir="ltr">{ref}</bdi>
          </>
        )}
      </p>
      <p className="v5-history-note">{C.erpNote}</p>
    </section>
  );
}

const DUPLICATE_NOTE: Partial<Record<SaleHistoryDetail['reprint']['duplicate'], string>> = {
  unavailable_incomplete: C.duplicateIncomplete,
  unavailable_voided: C.duplicateVoided,
};

function PrintButton({
  label,
  primary,
  busy,
  onClick,
}: Readonly<{
  label: string;
  primary: boolean;
  busy: boolean;
  onClick: () => void;
}>): JSX.Element {
  const className = primary ? 'v5-sales-btn v5-sales-btn--primary' : 'v5-sales-btn';
  return (
    <button type="button" className={className} disabled={busy} onClick={onClick}>
      {label}
    </button>
  );
}

function PrintResult({ print }: Readonly<{ print: Print }>): JSX.Element | null {
  if (print.phase === 'printing') return <output>{C.printing}</output>;
  if (print.phase !== 'done') return null;
  const { res } = print;
  return (
    <Notice tone={res.kind === 'ok' ? 'success' : 'warning'} testId="history-reprint-result">
      {res.kind === 'ok' ? C.sent(res.copy_number) : refusalCopy(res.reason)}
    </Notice>
  );
}

function ReprintControls({
  detail,
  print,
  onPrint,
}: Readonly<{
  detail: SaleHistoryDetail;
  print: Print;
  onPrint: (kind: SaleHistoryReprintKind) => void;
}>): JSX.Element {
  const busy = print.phase === 'printing';
  const duplicate = detail.reprint.duplicate;
  const note = DUPLICATE_NOTE[duplicate];
  return (
    <div className="v5-sales-buttons">
      {duplicate === 'allowed' && (
        <PrintButton
          label={C.reprintDuplicate}
          primary
          busy={busy}
          onClick={() => {
            onPrint('duplicate');
          }}
        />
      )}
      <PrintButton
        label={C.reprintRecord}
        primary={false}
        busy={busy}
        onClick={() => {
          onPrint('sale_record');
        }}
      />
      {note !== undefined && <p className="v5-history-note">{note}</p>}
      <p className="v5-history-note">{C.recordNote}</p>
      <PrintResult print={print} />
    </div>
  );
}

function SaleHeader({ detail }: Readonly<{ detail: SaleHistoryDetail }>): JSX.Element {
  const { summary } = detail;
  return (
    <>
      <p className="v5-sales-ref">
        <bdi dir="ltr">{summary.sale_number ?? C.notRecorded}</bdi>
      </p>
      <p className="v5-sales-meta">
        <NameCell value={summary.operator_display_name} source={summary.operator_name_source} /> ·{' '}
        <NameCell value={summary.device_label} source={summary.device_label_source} /> ·{' '}
        <bdi dir="ltr">{stamp(detail.settled_at ?? summary.occurred_at)}</bdi>
      </p>
      {detail.receipt_header === null && <p className="v5-history-note">{C.headerNotRecorded}</p>}
    </>
  );
}

function LoadState({ load }: Readonly<{ load: Load }>): JSX.Element | null {
  if (load.phase === 'loading') return <output>{C.loading}</output>;
  if (load.phase !== 'refused') return null;
  return (
    <Notice tone="warning" testId="history-detail-refused">
      {refusalCopy(load.reason)}
    </Notice>
  );
}

function toLoad(res: SaleHistoryReadResponse): Load {
  return res.kind === 'ok'
    ? { phase: 'ok', detail: res.detail }
    : { phase: 'refused', reason: res.reason };
}

async function reprintOrRefusal(
  bridge: SaleHistoryBridgeAPI,
  saleRef: string,
  kind: SaleHistoryReprintKind,
): Promise<SaleHistoryReprintResponse> {
  try {
    return await bridge.reprint({ sale_ref: saleRef, kind });
  } catch {
    return { kind: 'refused', reason: 'unavailable' };
  }
}

export function HistoryDetail({
  saleRef,
  bridge,
  onClose,
}: Readonly<HistoryDetailProps>): JSX.Element {
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [print, setPrint] = useState<Print>({ phase: 'idle' });
  const printing = useRef(false);

  useEffect(() => {
    let live = true;
    setLoad({ phase: 'loading' });
    setPrint({ phase: 'idle' });
    bridge.read({ sale_ref: saleRef }).then(
      (res) => {
        if (live) setLoad(toLoad(res));
      },
      () => {
        if (live) setLoad({ phase: 'refused', reason: 'unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, saleRef]);

  async function onPrint(kind: SaleHistoryReprintKind): Promise<void> {
    if (printing.current) return;
    printing.current = true;
    setPrint({ phase: 'printing' });
    const res = await reprintOrRefusal(bridge, saleRef, kind);
    printing.current = false;
    setPrint({ phase: 'done', res });
  }

  return (
    <section className="v5-history-detail" aria-labelledby={headingId} data-testid="history-detail">
      <div className="v5-sales-panel-head">
        <h3 id={headingId}>{C.detailHeading}</h3>
        <button type="button" className="v5-sales-btn" onClick={onClose}>
          {C.close}
        </button>
      </div>
      <LoadState load={load} />
      {load.phase === 'ok' && (
        <div className="v5-history-detail-body">
          <SaleHeader detail={load.detail} />
          <Lines detail={load.detail} />
          <Tenders detail={load.detail} />
          <Reversals detail={load.detail} />
          <Erp detail={load.detail} />
          <ReprintControls
            detail={load.detail}
            print={print}
            onPrint={(kind) => void onPrint(kind)}
          />
        </div>
      )}
    </section>
  );
}
