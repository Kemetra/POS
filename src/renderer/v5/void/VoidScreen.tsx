import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';

import type {
  SaleVoidJournalView,
  SaleVoidListResponse,
  SaleVoidSaleView,
  SaleVoidState,
} from '../../../shared/sale-void/types';
import { Notice } from '../foundation/Notice';
import { ScreenSection } from '../foundation/ScreenSection';
import { V5Icon, type V5IconName } from '../foundation/V5Icon';
import { useSingleFlight } from '../shift/shift-bridge';
import { formatShiftTime } from '../shift/shift-format';
import { VOID_COPY, voidRefusalMessage, voidStateLabel, voidWaitingMessage } from './void-copy';
import type { VoidBridges } from './void-bridges';
import { VoidActionDialog } from './VoidActionDialog';
import { VoidAlert, VoidCode, VoidMoney } from './void-parts';
import './void.css';

/**
 * RT-530 — «إلغاء بيع», `/app/void`: find a finalized sale of this terminal by
 * its receipt number, void it with another manager's PIN, and watch the queued
 * voids. A void waits (visibly) for its sale to sync and for the operator who
 * requested it to be signed in online; a refusal by Backend-Core stays on the
 * list, flagged, until someone acknowledges it. Nothing is ever dropped.
 *
 * RT-654 — composed on the G-6 vocabulary (frozen references VD-Void,
 * owner-approved OD-1…OD-8): the ScreenSection page header, the lookup and the
 * void journal as two panels, 44px V5 buttons, refusals as V5 notices. Arabic
 * (times, names) stays in the text face; only the sale number and amounts are
 * LTR tabular runs.
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
  // The void button that opened the dialog is gone once the sale is cleared, so
  // the screen sends focus back to the sale number field after a request.
  const lookupRef = useRef<HTMLInputElement>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus) return;
    lookupRef.current?.focus();
    setRefocus(false);
  }, [refocus]);

  return (
    <ScreenSection title={VOID_COPY.title}>
      <div className="v5-void" dir="rtl" lang="ar">
        {outcome !== null && <RequestedNotice entry={outcome} />}
        <div className="v5-void-cols">
          <LookupPanel
            inputRef={lookupRef}
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
            setRefocus(true);
            reload();
          }}
        />
      )}
    </ScreenSection>
  );
}

function RequestedNotice({ entry }: { entry: SaleVoidJournalView }): JSX.Element {
  return (
    <Notice tone="success" testId="void-requested">
      {VOID_COPY.requested}
      {entry.waiting_for !== null && (
        <> {voidWaitingMessage(entry.waiting_for, entry.requester_display_name)}</>
      )}
    </Notice>
  );
}

function Panel(props: { title: string; hug?: boolean; children: ReactNode }): JSX.Element {
  const headingId = useId();
  return (
    <section
      className={props.hug === true ? 'v5-void-panel v5-void-panel--hug' : 'v5-void-panel'}
      aria-labelledby={headingId}
    >
      <div className="v5-void-panel-head">
        <h2 id={headingId}>{props.title}</h2>
      </div>
      {props.children}
    </section>
  );
}

function LookupPanel(props: {
  inputRef: RefObject<HTMLInputElement | null>;
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
    <Panel title={VOID_COPY.lookupHeading} hug>
      <div className="v5-void-panel-body">
        <form
          className="v5-void-lookup"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <div className="v5-void-field">
            <label htmlFor="void-sale-number">{VOID_COPY.numberLabel}</label>
            <input
              ref={props.inputRef}
              id="void-sale-number"
              className="v5-void-input v5-void-input--code"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          </div>
          <button type="submit" className="v5-void-btn v5-void-btn--primary" disabled={busy}>
            {VOID_COPY.search}
          </button>
        </form>
        <FoundSale found={props.found} onVoid={props.onVoid} />
      </div>
    </Panel>
  );
}

function FoundSale(props: { found: Found; onVoid: (sale: SaleVoidSaleView) => void }): JSX.Element {
  const { found } = props;
  if (found.kind === 'idle') return <p className="v5-void-hint">{VOID_COPY.sameDayHint}</p>;
  if (found.kind === 'refused') return <VoidAlert message={found.message} />;
  const { sale } = found;
  return (
    <div className="v5-void-result" data-testid="void-sale">
      <dl className="v5-void-facts">
        <dt>{VOID_COPY.saleNumber}</dt>
        <dd>
          <VoidCode value={sale.sale_number} />
        </dd>
        <dt>{VOID_COPY.soldAt}</dt>
        <dd>
          <VoidTime iso={sale.finalized_at} />
        </dd>
        <dt>{VOID_COPY.seller}</dt>
        <dd>
          <bdi>{sale.selling_operator_display_name}</bdi>
        </dd>
        <dt>{VOID_COPY.total}</dt>
        <dd>
          <VoidMoney minor={sale.total_minor} />
        </dd>
        <dt>{VOID_COPY.cash}</dt>
        <dd>
          <VoidMoney minor={sale.cash_minor} />
        </dd>
      </dl>
      {sale.ineligible === null ? (
        <div className="v5-void-actions">
          <button
            type="button"
            className="v5-void-btn v5-void-btn--danger"
            onClick={() => {
              props.onVoid(sale);
            }}
          >
            {VOID_COPY.voidAction}
          </button>
        </div>
      ) : (
        <VoidAlert message={voidRefusalMessage(sale.ineligible)} />
      )}
    </div>
  );
}

/** An absolute Arabic date and time: the text face with tabular digits (never monospace). */
function VoidTime({ iso }: { iso: string }): JSX.Element {
  return (
    <time className="v5-void-when" dateTime={iso}>
      {formatShiftTime(iso)}
    </time>
  );
}

function HistoryPanel(props: {
  listed: Listed;
  bridges: VoidBridges;
  onChanged: () => void;
}): JSX.Element {
  return (
    <Panel title={VOID_COPY.historyTitle}>
      <HistoryBody {...props} />
    </Panel>
  );
}

function HistoryBody(props: {
  listed: Listed;
  bridges: VoidBridges;
  onChanged: () => void;
}): JSX.Element {
  const { listed } = props;
  if (listed.kind === 'loading')
    return (
      <div className="v5-void-panel-state">
        <output>{VOID_COPY.loading}</output>
      </div>
    );
  if (listed.kind === 'refused')
    return (
      <div className="v5-void-panel-state">
        <VoidAlert message={voidRefusalMessage(listed.reason)} />
      </div>
    );
  if (listed.voids.length === 0)
    return (
      <div className="v5-void-panel-state v5-void-neutral">
        <Notice tone="info">{VOID_COPY.noHistory}</Notice>
      </div>
    );
  return (
    // A scroll region with no control in it must still take focus (axe scrollable-region-focusable, OD-5).
    <ul className="v5-void-rows" tabIndex={0} aria-label={VOID_COPY.historyTitle}>
      {listed.voids.map((entry) => (
        <HistoryRow
          key={entry.void_id}
          entry={entry}
          bridges={props.bridges}
          onChanged={props.onChanged}
        />
      ))}
    </ul>
  );
}

/** Each state has its own tone and glyph, so it never rests on colour alone (OD-3). */
const STATE_LOOK: Readonly<
  Record<SaleVoidState, { tone: 'neutral' | 'success' | 'danger'; icon: V5IconName }>
> = {
  // The clock glyph (the same path as the manager-home shift card).
  pending: { tone: 'neutral', icon: 'manager-shift' },
  unknown: { tone: 'neutral', icon: 'retry' },
  confirmed: { tone: 'success', icon: 'status-success' },
  refused: { tone: 'danger', icon: 'status-warning' },
};

function StatePill({ state }: { state: SaleVoidState }): JSX.Element {
  const look = STATE_LOOK[state];
  return (
    <span className="v5-void-state" data-tone={look.tone}>
      <V5Icon name={look.icon} size={16} />
      {voidStateLabel(state)}
    </span>
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
      <VoidCode value={entry.sale_number} className="v5-void-row__ref" />
      <VoidMoney minor={entry.total_minor} className="v5-void-row__amount" />
      <div className="v5-void-row__full">
        <StatePill state={entry.state} />
      </div>
      <p className="v5-void-row__full v5-void-row__meta">
        {VOID_COPY.requestedAt}: <VoidTime iso={entry.requested_at} />
      </p>
      {entry.waiting_for !== null && (
        <output className="v5-void-row__full v5-void-row__waiting">
          <V5Icon name="manager-shift" size={16} />
          <span>{voidWaitingMessage(entry.waiting_for, entry.requester_display_name)}</span>
        </output>
      )}
      {entry.refusal_reason !== null && (
        <div className="v5-void-row__full">
          <VoidAlert message={voidRefusalMessage(entry.refusal_reason)} />
        </div>
      )}
      {entry.needs_attention && (
        <div className="v5-void-row__full">
          <button type="button" className="v5-void-btn" disabled={busy} onClick={acknowledge}>
            {VOID_COPY.acknowledge}
          </button>
        </div>
      )}
    </li>
  );
}
