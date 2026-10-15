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

export function RecoveryScreen({ bridges }: { bridges: RecoveryBridges }): JSX.Element {
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
      {outcome !== null && <output className="v5-shift-outcome">{outcome}</output>}
      <HeldBody held={held} nameOf={nameOf} onAction={open} />
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

function HeldBody(props: {
  held: Held;
  nameOf: (id: string) => string;
  onAction: (action: RecoveryAction) => void;
}): JSX.Element {
  const { held } = props;
  if (held.kind === 'loading') {
    return <output className="v5-shift-message">{RECOVERY_COPY.loading}</output>;
  }
  if (held.kind === 'refused') {
    return (
      <div className="v5-shift-message">
        <ShiftAlert message={recoveryRefusalMessage(held.reason)} />
      </div>
    );
  }
  return (
    <>
      {held.recovery_mode && (
        <p className="v5-shift-message v5-recovery-mode" role="note">
          {RECOVERY_COPY.recoveryMode}
        </p>
      )}
      <div className="v5-shift-columns">
        <StuckPanel stuck={held.stuck} nameOf={props.nameOf} onAction={props.onAction} />
        <HeldPanel held={held.held} nameOf={props.nameOf} onAction={props.onAction} />
      </div>
    </>
  );
}

/** One fact; `text` sets a word (a name) in the body face, not the tabular one. */
function Fact(props: { label: string; value: string; text?: boolean }): JSX.Element {
  const { label, value } = props;
  return (
    <div className="v5-shift-fact">
      <dt>{label}</dt>
      <dd className={props.text === true ? 'v5-recovery-text' : undefined}>
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

function StuckPanel(props: {
  stuck: RecoveryStuckAttemptView | null;
  nameOf: (id: string) => string;
  onAction: (action: RecoveryAction) => void;
}): JSX.Element {
  const { stuck } = props;
  return (
    <section className="v5-shift-panel" aria-labelledby="recovery-stuck">
      <h2 id="recovery-stuck">{RECOVERY_COPY.stuckTitle}</h2>
      {stuck === null ? (
        <p className="v5-shift-hint">{RECOVERY_COPY.noneStuck}</p>
      ) : (
        <>
          <dl className="v5-shift-facts">
            <Fact label={RECOVERY_COPY.owner} value={props.nameOf(stuck.owning_operator_id)} text />
            <Fact label={RECOVERY_COPY.lines} value={String(stuck.line_count)} />
            <Fact label={RECOVERY_COPY.total} value={formatCheckoutMoney(stuck.total_minor)} />
            {stuck.cash_minor > 0 && (
              <Fact label={RECOVERY_COPY.cash} value={formatCheckoutMoney(stuck.cash_minor)} />
            )}
            {stuck.card_minor > 0 && (
              <Fact label={RECOVERY_COPY.card} value={formatCheckoutMoney(stuck.card_minor)} />
            )}
            {stuck.voucher_minor > 0 && (
              <Fact
                label={RECOVERY_COPY.voucher}
                value={formatCheckoutMoney(stuck.voucher_minor)}
              />
            )}
            <Fact
              label={RECOVERY_COPY.remaining}
              value={formatCheckoutMoney(stuck.remaining_minor)}
            />
          </dl>
          <div className="v5-shift-actions">
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
    </section>
  );
}

function HeldPanel(props: {
  held: RecoveryHeldCartView[];
  nameOf: (id: string) => string;
  onAction: (action: RecoveryAction) => void;
}): JSX.Element {
  return (
    <section className="v5-shift-panel" aria-labelledby="recovery-held">
      <h2 id="recovery-held">{RECOVERY_COPY.heldTitle}</h2>
      {props.held.length === 0 ? (
        <p className="v5-shift-hint">{RECOVERY_COPY.noneHeld}</p>
      ) : (
        <ul className="v5-recovery-list">
          {props.held.map((cart) => (
            <li key={cart.cart_id} className="v5-recovery-row">
              <div className="v5-recovery-row__who">
                <strong>{props.nameOf(cart.owning_operator_id)}</strong>
                <span className="v5-recovery-tag">
                  {cart.kind === 'draft' ? RECOVERY_COPY.draft : RECOVERY_COPY.handedOff}
                </span>
                {cart.parked && <span className="v5-recovery-tag">{RECOVERY_COPY.parked}</span>}
              </div>
              <div className="v5-recovery-row__sum">
                <span>
                  {RECOVERY_COPY.lines} <bdi>{cart.line_count}</bdi>
                </span>
                <bdi className="v5-shift-money">{formatCheckoutMoney(cart.total_minor)}</bdi>
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
          ))}
        </ul>
      )}
    </section>
  );
}
