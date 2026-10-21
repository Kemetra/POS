import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import type { ListBranchRosterResponse } from '../../../shared/bridge-api';
import type { ManagerApprovalBridgeAPI } from '../../../shared/operator/manager-approval';
import type {
  RecoveryBridgeAPI,
  RecoveryHeldCartView,
  RecoveryListHeldResponse,
  RecoveryStuckAttemptView,
} from '../../../shared/operator/recovery';
import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { Notice } from '../foundation/Notice';
import { ScreenSection } from '../foundation/ScreenSection';
import { Icon } from '../../icons/Icon';
import { RECOVERY_COPY, recoveryRefusalMessage } from './recovery-copy';
import { RecoveryActionDialog, type RecoveryAction } from './RecoveryActionDialog';
import { RecoveryAlert } from './RecoveryAlert';
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
 *
 * RT-656 — drawn on the G-6 page header (ScreenSection) and V5 controls, as
 * the owner-approved references in docs/design/vnext/visual-acceptance/RC-Recovery.
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
    <ScreenSection title={RECOVERY_COPY.title}>
      <div className="v5-recovery" dir="rtl" lang="ar">
        {outcome !== null && (
          <Notice tone="success">
            <Outcome message={outcome} />
          </Notice>
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
    </ScreenSection>
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
    return (
      <div className="v5-recovery-state v5-recovery-neutral" aria-busy="true">
        <Notice tone="info">{RECOVERY_COPY.loading}</Notice>
      </div>
    );
  }
  if (held.kind === 'refused') {
    return (
      <div className="v5-recovery-state">
        <RecoveryAlert message={recoveryRefusalMessage(held.reason)} />
      </div>
    );
  }
  return (
    <>
      {held.recovery_mode && (
        <div className="v5-recovery-neutral" role="note">
          <Notice tone="info" announce={false}>
            {RECOVERY_COPY.recoveryMode}
          </Notice>
        </div>
      )}
      <div className="v5-recovery-grid">
        <StuckPanel stuck={held.stuck} nameOf={props.nameOf} onAction={props.onAction} />
        <HeldPanel held={held.held} nameOf={props.nameOf} onAction={props.onAction} />
      </div>
    </>
  );
}

/** An amount or a count: Western digits, LTR, tabular (DESIGN.md OD-3). */
function Num({ children }: Readonly<{ children: string | number }>): JSX.Element {
  return <bdi className="v5-recovery-num">{children}</bdi>;
}

/** formatCheckoutMoney's output inside a sentence: «1,250.00 EGP», «−5.00 EGP». */
const MONEY_RUN = /\u2212?[\d,]+\.\d{2} EGP/;

/** An outcome sentence with its amount isolated, so bidi never reads «EGP 50.00». */
function Outcome({ message }: Readonly<{ message: string }>): JSX.Element {
  const run = MONEY_RUN.exec(message);
  if (run === null) return <>{message}</>;
  const end = run.index + run[0].length;
  return (
    <>
      {message.slice(0, run.index)}
      <Num>{run[0]}</Num>
      {message.slice(end)}
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
        {props.text === true ? <bdi>{value}</bdi> : <Num>{value}</Num>}
      </dd>
    </div>
  );
}

function Panel(
  props: Readonly<{
    id: string;
    title: string;
    icon: 'cash' | 'held';
    className?: string;
    children: ReactNode;
  }>,
): JSX.Element {
  const cls = props.className === undefined ? '' : ` ${props.className}`;
  return (
    <section className={`v5-recovery-panel${cls}`} aria-labelledby={props.id}>
      <header className="v5-recovery-panel-head">
        <span className="v5-recovery-glyph">
          <Icon name={props.icon} />
        </span>
        <h2 id={props.id}>{props.title}</h2>
      </header>
      {props.children}
    </section>
  );
}

function Empty({ text }: Readonly<{ text: string }>): JSX.Element {
  return (
    <div className="v5-recovery-panel-body">
      <p className="v5-recovery-empty">
        <Icon name="status.neutral" />
        {text}
      </p>
    </div>
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
    <Panel
      id="recovery-stuck"
      title={RECOVERY_COPY.stuckTitle}
      icon="cash"
      className="v5-recovery-panel--stuck"
    >
      {stuck === null ? (
        <Empty text={RECOVERY_COPY.noneStuck} />
      ) : (
        <div className="v5-recovery-panel-body">
          <StuckFacts stuck={stuck} owner={props.nameOf(stuck.owning_operator_id)} />
          <div className="v5-recovery-actions">
            <button
              type="button"
              className="v5-recovery-btn v5-recovery-btn--primary v5-btn v5-btn--primary"
              onClick={() => {
                props.onAction({ kind: 'complete', stuck });
              }}
            >
              {RECOVERY_COPY.complete}
            </button>
            <button
              type="button"
              className="v5-recovery-btn v5-btn v5-btn--danger-quiet"
              onClick={() => {
                props.onAction({ kind: 'cancel_attempt', stuck });
              }}
            >
              {RECOVERY_COPY.cancelPayment}
            </button>
          </div>
        </div>
      )}
    </Panel>
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
          <Num>{formatCheckoutMoney(stuck.remaining_minor)}</Num>
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
    <Panel id="recovery-held" title={RECOVERY_COPY.heldTitle} icon="held">
      {props.held.length === 0 ? (
        <Empty text={RECOVERY_COPY.noneHeld} />
      ) : (
        <ul className="v5-recovery-rows">
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
    </Panel>
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
        <span className="v5-recovery-name">
          <bdi>{props.owner}</bdi>
        </span>
        <span className="v5-recovery-tags">
          <span className="v5-recovery-tag">
            {cart.kind === 'draft' ? RECOVERY_COPY.draft : RECOVERY_COPY.handedOff}
          </span>
          {cart.parked && <span className="v5-recovery-tag">{RECOVERY_COPY.parked}</span>}
        </span>
      </div>
      <div className="v5-recovery-row__sum">
        <Num>{formatCheckoutMoney(cart.total_minor)}</Num>
        <span>
          {RECOVERY_COPY.lines} <Num>{cart.line_count}</Num>
        </span>
      </div>
      <button
        type="button"
        className="v5-recovery-btn v5-btn v5-btn--danger-quiet"
        onClick={() => {
          props.onAction({ kind: 'cancel_cart', cart });
        }}
      >
        {RECOVERY_COPY.cancelSale}
      </button>
    </li>
  );
}
