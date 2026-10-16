import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type { ListBranchRosterResponse } from '../../../shared/bridge-api';
import type { ManagerApprovalBridgeAPI } from '../../../shared/operator/manager-approval';
import type {
  RecoveryBridgeAPI,
  RecoveryHeldCartView,
  RecoveryListHeldResponse,
  RecoveryStuckAttemptView,
} from '../../../shared/operator/recovery';
import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { V5Icon } from '../foundation/V5Icon';
import { ShiftAlert } from '../shift/ShiftScreen';
import { RECOVERY_COPY, recoveryRefusalMessage } from './recovery-copy';
import { RecoveryActionDialog, type RecoveryAction } from './RecoveryActionDialog';
import '../shift/shift.css';
import './recovery.css';

/**
 * RT-441 (RT-116 §5) — Manager → المبيعات المعلقة, `/app/manager/recovery`.
 *
 * Lists what other operators left on this terminal — the stuck payment and
 * the held sales — as TOTALS ONLY (no line items, no park label), and offers
 * the manager's three actions, each confirmed with the manager's own PIN
 * (an RT-114 approval, consumed by the action in main). Names come from the
 * branch roster; an operator the roster does not know shows as «موظف آخر».
 *
 * A session admitted in recovery mode lands here and can do nothing else
 * until the stuck payment is completed or cancelled; main then signs it out.
 */

export interface RecoveryBridges {
  recovery: RecoveryBridgeAPI;
  approval: ManagerApprovalBridgeAPI;
  listRoster?: () => Promise<ListBranchRosterResponse>;
}

export function windowRecoveryBridges(): RecoveryBridges | null {
  const api = (
    window as unknown as {
      api?: {
        recovery?: RecoveryBridgeAPI;
        approval?: ManagerApprovalBridgeAPI;
        operator?: { listBranchRoster?: () => Promise<ListBranchRosterResponse> };
      };
    }
  ).api;
  if (api?.recovery === undefined || api.approval === undefined) return null;
  const listRoster = api.operator?.listBranchRoster;
  return {
    recovery: api.recovery,
    approval: api.approval,
    ...(listRoster === undefined ? {} : { listRoster: () => listRoster() }),
  };
}

type Held = { kind: 'loading' } | RecoveryListHeldResponse;

function useHeld(bridge: RecoveryBridgeAPI): { held: Held; reload: () => void } {
  const [held, setHeld] = useState<Held>({ kind: 'loading' });
  const ticket = useRef(0);
  const reload = useCallback(() => {
    ticket.current += 1;
    const mine = ticket.current;
    bridge.listHeld().then(
      (answer) => {
        if (mine === ticket.current) setHeld(answer);
      },
      () => {
        if (mine === ticket.current) setHeld({ kind: 'refused', reason: 'recovery_unavailable' });
      },
    );
  }, [bridge]);
  useEffect(reload, [reload]);
  return { held, reload };
}

function useRosterNames(list: RecoveryBridges['listRoster']): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (list === undefined) return;
    let live = true;
    list().then(
      (answer) => {
        if (!live || answer.kind !== 'roster') return;
        setNames(new Map(answer.cashiers.map((c) => [c.id, c.display_name])));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [list]);
  return names;
}

export function RecoveryScreen({ bridges }: Readonly<{ bridges: RecoveryBridges }>): JSX.Element {
  const { held, reload } = useHeld(bridges.recovery);
  const names = useRosterNames(bridges.listRoster);
  const [action, setAction] = useState<RecoveryAction | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const nameOf = (id: string): string => names.get(id) ?? RECOVERY_COPY.someoneElse;

  const open = (next: RecoveryAction): void => {
    setOutcome(null);
    setAction(next);
  };

  return (
    <section className="v5-shift v5-recovery" dir="rtl" lang="ar" aria-labelledby="recovery-title">
      <div className="v5-shift-titlebar">
        <h1 id="recovery-title">{RECOVERY_COPY.title}</h1>
      </div>
      <div className="v5-recovery-grid">
        {outcome !== null && (
          <output className="v5-shift-outcome v5-recovery-wide">{outcome}</output>
        )}
        <HeldBody held={held} nameOf={nameOf} onAction={open} />
      </div>
      {action !== null && (
        <RecoveryActionDialog
          action={action}
          bridges={bridges}
          onDismiss={() => {
            setAction(null);
          }}
          onDone={(message) => {
            setAction(null);
            setOutcome(message);
            reload();
          }}
        />
      )}
    </section>
  );
}

function HeldBody(
  props: Readonly<{
    held: Held;
    nameOf: (id: string) => string;
    onAction: (action: RecoveryAction) => void;
  }>,
): JSX.Element {
  const { held } = props;
  if (held.kind === 'loading') {
    return <output className="v5-shift-message v5-recovery-wide">{RECOVERY_COPY.loading}</output>;
  }
  if (held.kind === 'refused') {
    return (
      <div className="v5-shift-message v5-recovery-wide">
        <ShiftAlert message={recoveryRefusalMessage(held.reason)} />
      </div>
    );
  }
  return (
    <>
      {held.recovery_mode && (
        <p className="v5-recovery-mode v5-recovery-wide" role="note">
          <V5Icon name="status-info" />
          <span>{RECOVERY_COPY.recoveryMode}</span>
        </p>
      )}
      <StuckPanel stuck={held.stuck} nameOf={props.nameOf} onAction={props.onAction} />
      <HeldPanel held={held.held} nameOf={props.nameOf} onAction={props.onAction} />
    </>
  );
}

/** One fact; `text` sets a word (a name) in the body face, not the tabular one. */
function Fact(
  props: Readonly<{ label: string; value: string; text?: boolean; lead?: boolean }>,
): JSX.Element {
  const { label, value } = props;
  return (
    <div
      className={
        props.lead === true ? 'v5-recovery-fact v5-recovery-fact--lead' : 'v5-recovery-fact'
      }
    >
      <dt>{label}</dt>
      <dd className={props.text === true ? 'v5-recovery-text' : undefined}>
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

function PanelHead(
  props: Readonly<{ id: string; title: string; icon: 'tender-cash' | 'manager-held' }>,
): JSX.Element {
  return (
    <header className="v5-shift-mgr-head v5-recovery-head">
      <span className="v5-shift-mgr-glyph">
        <V5Icon name={props.icon} />
      </span>
      <h2 id={props.id}>{props.title}</h2>
    </header>
  );
}

function Initial({ name }: Readonly<{ name: string }>): JSX.Element {
  return (
    <span className="v5-recovery-initial" aria-hidden="true">
      {name.charAt(0)}
    </span>
  );
}

function StuckPanel(
  props: Readonly<{
    stuck: RecoveryStuckAttemptView | null;
    nameOf: (id: string) => string;
    onAction: (action: RecoveryAction) => void;
  }>,
): JSX.Element {
  const { stuck } = props;
  return (
    <section className="v5-shift-mgr-panel" aria-labelledby="recovery-stuck">
      <PanelHead id="recovery-stuck" title={RECOVERY_COPY.stuckTitle} icon="tender-cash" />
      <div className="v5-shift-mgr-body">
        {stuck === null ? (
          <p className="v5-recovery-empty">
            <V5Icon name="dash" />
            {RECOVERY_COPY.noneStuck}
          </p>
        ) : (
          <>
            <StuckFacts stuck={stuck} owner={props.nameOf(stuck.owning_operator_id)} />
            <div className="v5-recovery-actions">
              <button
                type="button"
                className="v5-shift-btn v5-shift-btn--primary"
                onClick={() => {
                  props.onAction({ kind: 'complete', stuck });
                }}
              >
                {RECOVERY_COPY.complete}
              </button>
              <button
                type="button"
                className="v5-shift-btn"
                onClick={() => {
                  props.onAction({ kind: 'cancel_attempt', stuck });
                }}
              >
                {RECOVERY_COPY.cancelPayment}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** Totals and live tender only: a zero tender line is never shown. */
function StuckFacts(
  props: Readonly<{ stuck: RecoveryStuckAttemptView; owner: string }>,
): JSX.Element {
  const { stuck } = props;
  return (
    <dl className="v5-recovery-facts">
      <Fact label={RECOVERY_COPY.owner} value={props.owner} text lead />
      <Fact label={RECOVERY_COPY.lines} value={String(stuck.line_count)} />
      <Fact label={RECOVERY_COPY.total} value={formatCheckoutMoney(stuck.total_minor)} />
      {stuck.cash_minor > 0 && (
        <Fact label={RECOVERY_COPY.cash} value={formatCheckoutMoney(stuck.cash_minor)} />
      )}
      {stuck.card_minor > 0 && (
        <Fact label={RECOVERY_COPY.card} value={formatCheckoutMoney(stuck.card_minor)} />
      )}
      {stuck.voucher_minor > 0 && (
        <Fact label={RECOVERY_COPY.voucher} value={formatCheckoutMoney(stuck.voucher_minor)} />
      )}
      <div className="v5-recovery-fact v5-recovery-fact--due">
        <dt>{RECOVERY_COPY.remaining}</dt>
        <dd>
          <bdi>{formatCheckoutMoney(stuck.remaining_minor)}</bdi>
        </dd>
      </div>
    </dl>
  );
}

function HeldPanel(
  props: Readonly<{
    held: RecoveryHeldCartView[];
    nameOf: (id: string) => string;
    onAction: (action: RecoveryAction) => void;
  }>,
): JSX.Element {
  return (
    <section className="v5-shift-mgr-panel" aria-labelledby="recovery-held">
      <PanelHead id="recovery-held" title={RECOVERY_COPY.heldTitle} icon="manager-held" />
      {props.held.length === 0 ? (
        <p className="v5-shift-mgr-body v5-recovery-empty">
          <V5Icon name="dash" />
          {RECOVERY_COPY.noneHeld}
        </p>
      ) : (
        <ul className="v5-recovery-list">
          {props.held.map((cart) => (
            <HeldRow
              key={cart.cart_id}
              cart={cart}
              owner={props.nameOf(cart.owning_operator_id)}
              onAction={props.onAction}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function HeldRow(
  props: Readonly<{
    cart: RecoveryHeldCartView;
    owner: string;
    onAction: (action: RecoveryAction) => void;
  }>,
): JSX.Element {
  const { cart } = props;
  return (
    <li className="v5-recovery-row">
      <Initial name={props.owner} />
      <div className="v5-recovery-row__who">
        <strong>{props.owner}</strong>
        <span className="v5-recovery-tags">
          <span className="v5-recovery-tag">
            {cart.kind === 'draft' ? RECOVERY_COPY.draft : RECOVERY_COPY.handedOff}
          </span>
          {cart.parked && <span className="v5-recovery-tag">{RECOVERY_COPY.parked}</span>}
        </span>
      </div>
      <div className="v5-recovery-row__sum">
        <bdi className="v5-shift-money">{formatCheckoutMoney(cart.total_minor)}</bdi>
        <span>
          {RECOVERY_COPY.lines} <bdi>{cart.line_count}</bdi>
        </span>
      </div>
      <button
        type="button"
        className="v5-shift-btn"
        onClick={() => {
          props.onAction({ kind: 'cancel_cart', cart });
        }}
      >
        {RECOVERY_COPY.cancelSale}
      </button>
    </li>
  );
}
