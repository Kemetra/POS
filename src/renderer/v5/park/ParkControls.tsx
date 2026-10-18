import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type { CartParkBridgeAPI } from '../../../shared/cart/park-types';
import { Notice } from '../foundation/Notice';
import { Icon } from '../../icons/Icon';
import { callPark } from './park-bridge';
import { PARK_COPY } from './park-copy';
import { ParkDialog } from './ParkDialog';
import './park.css';

/**
 * OD-4: the badge counts this cashier's own parked sales (`listParked`).
 * Unknown (not read yet, or refused) shows no number rather than a guess.
 */
export function useParkedCount(bridge: CartParkBridgeAPI | null): {
  count: number | null;
  reload: () => void;
} {
  const [count, setCount] = useState<number | null>(null);
  const ticket = useRef(0);
  const reload = useCallback((): void => {
    if (bridge === null) return;
    ticket.current += 1;
    const mine = ticket.current;
    void callPark(() => bridge.listParked()).then((answer) => {
      if (mine !== ticket.current) return;
      setCount(answer.kind === 'parked_sales' ? answer.items.length : null);
    });
  }, [bridge]);
  useEffect(reload, [reload]);
  return { count, reload };
}

/** «عُلِّق البيع ‹الاسم›.» (M-H1); with no label the sentence simply ends. */
export function ParkedNotice({ label }: Readonly<{ label: string | null }>): JSX.Element {
  return (
    <div className="v5-park-sale-notice">
      <Notice tone="success">
        {PARK_COPY.parkedOk}
        {label !== null && (
          <>
            {' '}
            <bdi>{label}</bdi>
          </>
        )}
        .
      </Notice>
    </div>
  );
}

/** «المبيعات المعلّقة» + count: the visible way to the list (no F3, D-K1). */
export function ParkedSalesButton(
  props: Readonly<{ count: number | null; onOpen: () => void }>,
): JSX.Element {
  return (
    <button type="button" className="v5-park-btn v5-park-btn--quiet" onClick={props.onOpen}>
      {PARK_COPY.parkedSales}
      {props.count !== null && (
        <span className="v5-park-badge v5-park-num">{String(props.count)}</span>
      )}
    </button>
  );
}

interface ParkActionProps {
  readonly bridge: CartParkBridgeAPI;
  readonly cartId: string | null;
  /** Only an editing cart with at least one line parks (K2); otherwise the button is disabled. */
  readonly enabled: boolean;
  readonly lineCount: number;
  readonly totalMinor: number;
  readonly onParked: (label: string | null) => void;
  readonly onShowParked: () => void;
  readonly onRefused: () => void;
}

/**
 * RT-445 — «تعليق البيع»: neutral, with its own pause glyph, never the
 * danger colour of «إلغاء البيع» (I-2). No key is bound (D-K1).
 */
export function ParkAction(props: Readonly<ParkActionProps>): JSX.Element {
  const [open, setOpen] = useState(false);
  const usable = props.enabled && props.cartId !== null;
  return (
    <>
      <button
        type="button"
        className="v5-park-btn v5-park-btn--park"
        disabled={!usable}
        onClick={() => {
          setOpen(true);
        }}
      >
        <Icon name="park" />
        {PARK_COPY.parkAction}
      </button>
      {open && props.cartId !== null && (
        <ParkDialog
          bridge={props.bridge}
          cartId={props.cartId}
          lineCount={props.lineCount}
          totalMinor={props.totalMinor}
          onClose={() => {
            setOpen(false);
          }}
          onParked={(label) => {
            setOpen(false);
            props.onParked(label);
          }}
          onShowParked={() => {
            setOpen(false);
            props.onShowParked();
          }}
          onRefused={props.onRefused}
        />
      )}
    </>
  );
}
