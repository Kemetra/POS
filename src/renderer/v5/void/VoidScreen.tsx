import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type {
  SaleVoidJournalView,
  SaleVoidListResponse,
  SaleVoidSaleView,
} from '../../../shared/sale-void/types';
import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { useSingleFlight } from '../shift/shift-bridge';
import { formatShiftTime } from '../shift/shift-format';
import { ShiftAlert } from '../shift/ShiftScreen';
import { VOID_COPY, voidRefusalMessage, voidStateLabel, voidWaitingMessage } from './void-copy';
import type { VoidBridges } from './void-bridges';
import { VoidActionDialog } from './VoidActionDialog';
import '../shift/shift.css';
import './void.css';

/**
 * RT-530 — «إلغاء بيع», `/app/void`: find a finalized sale of this terminal by
 * its receipt number, void it with another manager's PIN, and watch the queued
 * voids. A void waits (visibly) for its sale to sync and for the operator who
 * requested it to be signed in online; a refusal by Backend-Core stays on the
 * list, flagged, until someone acknowledges it. Nothing is ever dropped.
 */
export interface VoidScreenProps {
  readonly bridges: VoidBridges;
  /** How often the list re-reads while the screen is open (ms); 0 turns the refresh off. */
  readonly refreshMs?: number;
}

type Listed = { kind: 'loading' } | SaleVoidListResponse;

function useVoidList(
  bridges: VoidBridges,
  refreshMs: number,
): { listed: Listed; reload: () => void } {
  const [listed, setListed] = useState<Listed>({ kind: 'loading' });
  const ticket = useRef(0);
  const reload = useCallback(() => {
    ticket.current += 1;
    const mine = ticket.current;
    bridges.saleVoid.list().then(
      (answer) => {
        if (mine === ticket.current) setListed(answer);
      },
      () => {
        if (mine === ticket.current) setListed({ kind: 'refused', reason: 'void_unavailable' });
      },
    );
  }, [bridges]);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (refreshMs <= 0) return;
    const timer = setInterval(reload, refreshMs);
    return () => {
      clearInterval(timer);
    };
  }, [reload, refreshMs]);
  return { listed, reload };
}

type Found =
  | { kind: 'idle' }
  | { kind: 'sale'; sale: SaleVoidSaleView }
  | { kind: 'refused'; message: string };

export function VoidScreen({ bridges, refreshMs = 10_000 }: VoidScreenProps): JSX.Element {
  const { listed, reload } = useVoidList(bridges, refreshMs);
  const [found, setFound] = useState<Found>({ kind: 'idle' });
  const [voiding, setVoiding] = useState<SaleVoidSaleView | null>(null);
  const [outcome, setOutcome] = useState<SaleVoidJournalView | null>(null);

  return (
    <section className="v5-shift v5-void" dir="rtl" lang="ar" aria-labelledby="void-title">
      <div className="v5-shift-titlebar">
        <h1 id="void-title">{VOID_COPY.title}</h1>
      </div>
      {outcome !== null && <RequestedNotice entry={outcome} />}
      <div className="v5-shift-columns">
        <LookupPanel
          bridges={bridges}
          found={found}
          onFound={(next) => {
            setOutcome(null);
            setFound(next);
          }}
          onVoid={setVoiding}
        />
        <HistoryPanel listed={listed} bridges={bridges} onChanged={reload} />
      </div>
      {voiding !== null && (
        <VoidActionDialog
          sale={voiding}
          bridges={bridges}
          onDismiss={() => {
            setVoiding(null);
          }}
          onRequested={(entry) => {
            setVoiding(null);
            setFound({ kind: 'idle' });
            setOutcome(entry);
            reload();
          }}
        />
      )}
    </section>
  );
}

function RequestedNotice({ entry }: { entry: SaleVoidJournalView }): JSX.Element {
  return (
    <output className="v5-shift-outcome" data-testid="void-requested">
      {VOID_COPY.requested}
      {entry.waiting_for !== null && (
        <> {voidWaitingMessage(entry.waiting_for, entry.requester_display_name)}</>
      )}
    </output>
  );
}

function LookupPanel(props: {
  bridges: VoidBridges;
  found: Found;
  onFound: (found: Found) => void;
  onVoid: (sale: SaleVoidSaleView) => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const { busy, run } = useSingleFlight();
  const search = (): void => {
    const saleNumber = value.trim();
    if (saleNumber.length === 0) return;
    run(async () => {
      try {
        const answer = await props.bridges.saleVoid.lookup({ sale_number: saleNumber });
        props.onFound(
          answer.kind === 'sale'
            ? { kind: 'sale', sale: answer.sale }
            : { kind: 'refused', message: voidRefusalMessage(answer.reason) },
        );
      } catch {
        props.onFound({ kind: 'refused', message: VOID_COPY.unavailable });
      }
    });
  };
  return (
    <section className="v5-shift-panel" aria-labelledby="void-lookup">
      <h2 id="void-lookup">{VOID_COPY.lookupHeading}</h2>
      <form
        className="v5-shift-fields"
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
      >
        <label htmlFor="void-sale-number">{VOID_COPY.numberLabel}</label>
        <input
          id="void-sale-number"
          className="v5-shift-input v5-ltr"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
        <button type="submit" className="v5-live-btn v5-live-btn--primary" disabled={busy}>
          {VOID_COPY.search}
        </button>
      </form>
      <FoundSale found={props.found} onVoid={props.onVoid} />
    </section>
  );
}

function FoundSale(props: {
  found: Found;
  onVoid: (sale: SaleVoidSaleView) => void;
}): JSX.Element | null {
  const { found } = props;
  if (found.kind === 'idle') return <p className="v5-shift-hint">{VOID_COPY.sameDayHint}</p>;
  if (found.kind === 'refused') return <ShiftAlert message={found.message} />;
  const { sale } = found;
  return (
    <div data-testid="void-sale">
      <dl className="v5-shift-facts">
        <Fact label={VOID_COPY.saleNumber} value={sale.sale_number} />
        <Fact label={VOID_COPY.soldAt} value={formatShiftTime(sale.finalized_at)} />
        <Fact label={VOID_COPY.seller} value={sale.selling_operator_display_name} text />
        <Fact label={VOID_COPY.total} value={formatCheckoutMoney(sale.total_minor)} />
        <Fact label={VOID_COPY.cash} value={formatCheckoutMoney(sale.cash_minor)} />
      </dl>
      {sale.ineligible === null ? (
        <button
          type="button"
          className="v5-live-btn v5-live-btn--primary"
          onClick={() => {
            props.onVoid(sale);
          }}
        >
          {VOID_COPY.voidAction}
        </button>
      ) : (
        <ShiftAlert message={voidRefusalMessage(sale.ineligible)} />
      )}
    </div>
  );
}

function Fact(props: { label: string; value: string; text?: boolean }): JSX.Element {
  return (
    <div className="v5-shift-fact">
      <dt>{props.label}</dt>
      <dd className={props.text === true ? 'v5-void-text' : undefined}>
        <bdi>{props.value}</bdi>
      </dd>
    </div>
  );
}

function HistoryPanel(props: {
  listed: Listed;
  bridges: VoidBridges;
  onChanged: () => void;
}): JSX.Element {
  const { listed } = props;
  return (
    <section className="v5-shift-panel" aria-labelledby="void-history">
      <h2 id="void-history">{VOID_COPY.historyTitle}</h2>
      {listed.kind === 'loading' && <output>{VOID_COPY.loading}</output>}
      {listed.kind === 'refused' && <ShiftAlert message={voidRefusalMessage(listed.reason)} />}
      {listed.kind === 'list' && listed.voids.length === 0 && (
        <p className="v5-shift-hint">{VOID_COPY.noHistory}</p>
      )}
      {listed.kind === 'list' && listed.voids.length > 0 && (
        <ul className="v5-void-list">
          {listed.voids.map((entry) => (
            <HistoryRow
              key={entry.void_id}
              entry={entry}
              bridges={props.bridges}
              onChanged={props.onChanged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryRow(props: {
  entry: SaleVoidJournalView;
  bridges: VoidBridges;
  onChanged: () => void;
}): JSX.Element {
  const { entry } = props;
  const { busy, run } = useSingleFlight();
  const acknowledge = (): void => {
    run(async () => {
      try {
        await props.bridges.saleVoid.acknowledge({ void_id: entry.void_id });
      } finally {
        props.onChanged();
      }
    });
  };
  return (
    <li
      className="v5-void-row"
      data-state={entry.state}
      data-attention={entry.needs_attention ? 'true' : 'false'}
      data-testid="void-row"
    >
      <p className="v5-void-row__head">
        <bdi>{entry.sale_number}</bdi> — <bdi>{formatCheckoutMoney(entry.total_minor)}</bdi>
      </p>
      <p className="v5-void-row__state">{voidStateLabel(entry.state)}</p>
      <p className="v5-void-row__time">
        {VOID_COPY.requestedAt}: <bdi>{formatShiftTime(entry.requested_at)}</bdi>
      </p>
      {entry.waiting_for !== null && (
        <output className="v5-void-row__waiting">
          {voidWaitingMessage(entry.waiting_for, entry.requester_display_name)}
        </output>
      )}
      {entry.refusal_reason !== null && (
        <ShiftAlert message={voidRefusalMessage(entry.refusal_reason)} />
      )}
      {entry.needs_attention && (
        <button type="button" className="v5-live-btn" disabled={busy} onClick={acknowledge}>
          {VOID_COPY.acknowledge}
        </button>
      )}
    </li>
  );
}
