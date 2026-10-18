import { useCallback, useEffect, useRef, useState, type JSX, type RefObject } from 'react';

import type { CartBridgeAPI } from '../../../shared/bridge-api';
import type {
  CartListParkedResponse,
  CartParkBridgeAPI,
  ParkedSaleView,
} from '../../../shared/cart/park-types';
import { useScanOwner } from '../../scan/ScanGuardHost';
import { SCAN_PAUSED_DIALOG_STATUS } from '../../scan/scan-messages';
import { useScanNoticeStore } from '../../scan/scan-notice-store';
import { formatHumanMoney } from '../../ui/format/human-format';
import { Notice } from '../foundation/Notice';
import { Icon } from '../../icons/Icon';
import { callPark, type ParkUnreachable } from './park-bridge';
import { PARK_COPY, itemsLabel, parkedTime } from './park-copy';
import { ResumeReview } from './ResumeReview';
import { useResumeFlow } from './useResumeFlow';
import './park.css';

type ListState = { kind: 'loading' } | CartListParkedResponse | ParkUnreachable;

/** `cart.listParked`, read on mount and on `reload()`; the last read wins. */
export function useParkedList(bridge: CartParkBridgeAPI | null): {
  list: ListState;
  reload: () => void;
} {
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const ticket = useRef(0);
  const reload = useCallback((): void => {
    ticket.current += 1;
    const mine = ticket.current;
    if (bridge === null) {
      setList({ kind: 'unreachable' });
      return;
    }
    void callPark(() => bridge.listParked()).then((answer) => {
      if (mine === ticket.current) setList(answer);
    });
  }, [bridge]);
  useEffect(reload, [reload]);
  return { list, reload };
}

/** RT-239 / OD-15: a scan while the list or the review is open is refused, visibly. */
function useRefuseScans(): void {
  const refuse = useCallback((): void => {
    useScanNoticeStore.getState().show(SCAN_PAUSED_DIALOG_STATUS);
  }, []);
  useScanOwner(refuse);
}

interface Props {
  readonly parked: CartParkBridgeAPI | null;
  readonly cart: CartBridgeAPI | null;
  readonly onBackToSale: () => void;
  /** Main answered `resumed`: show this cart on the Sale. */
  readonly onResumed: (cartId: string) => void;
}

/**
 * RT-445 (PK3-List* / Review* / Conflict* / Ref*) — the cashier's own parked
 * sales on this terminal, newest first (K3: no other operator, no lines), and
 * the resume review. A full screen (OD-4) inside the Sale entry.
 */
export function ParkedSalesScreen(props: Readonly<Props>): JSX.Element {
  useRefuseScans();
  const { list, reload } = useParkedList(props.parked);
  if (props.parked === null) {
    return (
      <ListFrame count={null} onBack={props.onBackToSale}>
        <Notice tone="warning">{PARK_COPY.generic}</Notice>
      </ListFrame>
    );
  }
  return <ParkedSalesFlow {...props} parked={props.parked} list={list} reload={reload} />;
}

function ParkedSalesFlow(
  props: Readonly<Props & { parked: CartParkBridgeAPI; list: ListState; reload: () => void }>,
): JSX.Element {
  const flow = useResumeFlow({
    parked: props.parked,
    cart: props.cart,
    onResumed: props.onResumed,
    reloadList: props.reload,
  });
  if (flow.view.kind !== 'list') return <ResumeReview flow={flow} />;
  const items = itemsOf(props.list);
  return (
    <ListFrame count={items === null ? null : items.length} onBack={props.onBackToSale}>
      <ParkedList
        list={props.list}
        refused={flow.listRefused}
        pendingCartId={flow.pendingCartId}
        onResume={flow.start}
      />
    </ListFrame>
  );
}

function ListFrame(
  props: Readonly<{ count: number | null; onBack: () => void; children: JSX.Element }>,
): JSX.Element {
  const backRef = useRef<HTMLButtonElement>(null);
  return (
    <section className="v5-park-screen" dir="rtl" lang="ar" aria-labelledby="v5-park-list-title">
      <div className="v5-park-head">
        <h1 id="v5-park-list-title">{PARK_COPY.listTitle}</h1>
        {props.count !== null && (
          <p className="v5-park-num">
            {props.count === 0 ? PARK_COPY.listNone : String(props.count)}
          </p>
        )}
        <span className="v5-park-grow" />
        <button
          ref={backRef}
          type="button"
          className="v5-park-btn"
          data-park-back
          onClick={props.onBack}
        >
          {PARK_COPY.backToSale}
        </button>
      </div>
      {props.children}
    </section>
  );
}

interface ListProps {
  readonly list: ListState;
  readonly refused: boolean;
  readonly pendingCartId: string | null;
  readonly onResume: (sale: ParkedSaleView) => void;
}

function itemsOf(list: ListState): readonly ParkedSaleView[] | null {
  return list.kind === 'parked_sales' ? list.items : null;
}

function ParkedList(props: Readonly<ListProps>): JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const items = itemsOf(props.list);
  useArrivalFocus(panelRef, items);
  return (
    <section
      ref={panelRef}
      className="v5-park-panel"
      aria-labelledby="v5-park-list-heading"
      aria-busy={props.list.kind === 'loading'}
    >
      <div className="v5-park-panel__head">
        <h2 id="v5-park-list-heading">{PARK_COPY.listHeading}</h2>
        {items !== null && <ListCount count={items.length} />}
      </div>
      <ListBody {...props} items={items} />
    </section>
  );
}

/** «5 من مبيعاتك», or «0» when there is none. */
function ListCount({ count }: Readonly<{ count: number }>): JSX.Element {
  return <span className="v5-park-muted">{count === 0 ? '0' : `${String(count)} من مبيعاتك`}</span>;
}

/** The generic refusal (OD-9) and the empty state above the rows, then the rows and their foot. */
function ListBody(
  props: Readonly<ListProps & { items: readonly ParkedSaleView[] | null }>,
): JSX.Element {
  const failed = props.list.kind === 'refused' || props.list.kind === 'unreachable';
  const { items } = props;
  return (
    <>
      {(props.refused || failed) && <PanelNotice tone="warning" text={PARK_COPY.generic} />}
      {items?.length === 0 && <PanelNotice tone="info" text={PARK_COPY.listEmpty} />}
      {items !== null && items.length > 0 && (
        <>
          <ul className="v5-park-list" aria-labelledby="v5-park-list-heading">
            {items.map((sale) => (
              <ParkedRow
                key={sale.cart_id}
                sale={sale}
                busy={props.pendingCartId === sale.cart_id}
                disabled={props.pendingCartId !== null}
                onResume={props.onResume}
              />
            ))}
          </ul>
          <p className="v5-park-panel__foot">{PARK_COPY.listFoot}</p>
        </>
      )}
    </>
  );
}

function PanelNotice(props: Readonly<{ tone: 'warning' | 'info'; text: string }>): JSX.Element {
  return (
    <div className="v5-park-panel__state">
      <Notice tone={props.tone}>{props.text}</Notice>
    </div>
  );
}

/**
 * Arriving on the list, focus lands on the newest sale's «استئناف البيع»
 * (as drawn), or on «رجوع إلى البيع» when there is none.
 */
function useArrivalFocus(
  panelRef: RefObject<HTMLElement | null>,
  items: readonly ParkedSaleView[] | null,
): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || items === null) return;
    done.current = true;
    const first = panelRef.current?.querySelector<HTMLButtonElement>('.v5-park-row button');
    const back = panelRef.current
      ?.closest('.v5-park-screen')
      ?.querySelector<HTMLButtonElement>('[data-park-back]');
    (first ?? back)?.focus();
  }, [items, panelRef]);
}

function ParkedRow(
  props: Readonly<{
    sale: ParkedSaleView;
    busy: boolean;
    disabled: boolean;
    onResume: (sale: ParkedSaleView) => void;
  }>,
): JSX.Element {
  const { sale } = props;
  return (
    <li className="v5-park-row">
      <span className="v5-park-row__name">
        {sale.label === null ? (
          <span className="v5-park-muted">{PARK_COPY.unnamed}</span>
        ) : (
          <span className="v5-park-row__label">
            <bdi>{sale.label}</bdi>
          </span>
        )}
        <span className="v5-park-row__meta">
          {`${itemsLabel(sale.line_count)} · ${PARK_COPY.parkedAt} `}
          <time className="v5-park-num" dateTime={sale.parked_at}>
            {parkedTime(sale.parked_at)}
          </time>
        </span>
      </span>
      <span className="v5-park-row__stale">
        {sale.stale && (
          <span className="v5-park-tag v5-park-tag--stale">
            <Icon name="shift" size="sm" />
            {PARK_COPY.stale}
          </span>
        )}
      </span>
      <span className="v5-park-row__total v5-park-num" dir="ltr">
        {formatHumanMoney(sale.total_minor)}
      </span>
      <button
        type="button"
        className="v5-park-btn"
        disabled={props.disabled}
        aria-busy={props.busy || undefined}
        onClick={() => {
          props.onResume(sale);
        }}
      >
        {PARK_COPY.resume}
      </button>
    </li>
  );
}
