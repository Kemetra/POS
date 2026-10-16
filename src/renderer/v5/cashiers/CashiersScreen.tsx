import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import type {
  CashierPinStatus,
  OperatorBridgeAPI,
  PairingBridgeAPI,
} from '../../../shared/bridge-api';
import type { OperatorRefusal } from '../../../shared/audit/event-shape';
import { ReauthDialog } from '../../ui/operator/ReauthDialog';
import { REAUTH_COPY, SIGN_IN_REFUSAL_COPY } from '../../ui/operator/messages';
import { useTerminalLabel } from '../entry/EntryStrip';
import { Notice } from '../foundation/Notice';
import { V5Icon } from '../foundation/V5Icon';
import { CashierRows } from './CashierRows';
import { CASHIERS_COPY } from './cashiers-copy';
import type { RowAction } from './cashiers-model';
import {
  afterReauthAnswer,
  changePinAnswer,
  firstPinAnswer,
  unlockAnswer,
  type Outcome,
  type SaveAnswer,
} from './cashiers-outcomes';
import { PinDialog, type PinDialogMode, type PinSaveResult } from './PinDialog';
import { useCashierList, type CashierListState } from './use-cashier-list';
import './cashiers.css';

/**
 * RT-424 (RT-251 doc 19, G-3) — Manager → Cashiers, `/app/manager/cashiers`,
 * in the v5 manager frame (UX-09). Manager and admin only: the router guards
 * the route (secondary), main gates every call with `requireRole` (AD-1).
 *
 * - Each row shows the cashier's PIN state on this terminal and only the
 *   actions that fit it (the M2–M4 matrix).
 * - One shared pending guard: while any call or re-read is in flight, every
 *   row action is disabled, and a second call is never sent.
 * - The list re-reads on mount, after every action (success or refusal) and on
 *   «إعادة المحاولة». No polling.
 * - M6: a first PIN refused `reauth_required` shows the M-A3 notice; the
 *   RT-358 re-auth dialog opens from «تسجيل الدخول»; on success the same PIN
 *   is sent again exactly once, on cancel it is dropped.
 * - The roster id and the PIN never reach the DOM (PR-1); refusal categories
 *   never reach it either (UX-12).
 */

type Operator = Pick<
  OperatorBridgeAPI,
  | 'listCashierPinStatus'
  | 'provisionCashierPin'
  | 'resetCashierPin'
  | 'unlockCashier'
  | 'reauthenticate'
>;

interface Props {
  operator: Operator;
  /** For the terminal label under the title. Optional: the label is best-effort. */
  pairing?: PairingBridgeAPI;
}

interface OpenDialog {
  mode: PinDialogMode;
  cashier: CashierPinStatus;
}

const REFUSED: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };

/** A rejected call (e.g. the session locked: the lock guard throws) reads as a generic refusal. */
function safe<T>(call: () => Promise<T | OperatorRefusal>): Promise<T | OperatorRefusal> {
  return call().catch(() => REFUSED);
}

/** The one pending guard: a ref blocks re-entry synchronously, the state disables the UI. */
function useExclusive(): {
  pending: boolean;
  run: <T>(call: () => Promise<T>) => Promise<T | undefined>;
} {
  const ref = useRef(false);
  const [pending, setPending] = useState(false);
  const run = useCallback(async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
    if (ref.current) return undefined;
    ref.current = true;
    setPending(true);
    try {
      return await call();
    } finally {
      ref.current = false;
      setPending(false);
    }
  }, []);
  return { pending, run };
}

export function CashiersScreen({ operator, pairing }: Readonly<Props>): JSX.Element {
  const terminalLabel = useTerminalLabel(pairing);
  const { list, reading, landed, reload } = useCashierList(operator);
  const { pending, run } = useExclusive();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const focus = useFocusAfterRead(reading, landed);

  /** After any answer: re-read, then put focus back on that cashier's row if it was lost. */
  const settle = (cashier: CashierPinStatus): void => {
    focus.target(cashier.id);
    void reload();
  };

  const onAction = (action: RowAction, cashier: CashierPinStatus): void => {
    setOutcome(null);
    if (action === 'unlock') {
      void unlock(cashier);
      return;
    }
    setDialog({ mode: action, cashier });
  };

  const unlock = async (cashier: CashierPinStatus): Promise<void> => {
    const req = { event_id: crypto.randomUUID(), target_cashier_id: cashier.id };
    const res = await run(() => safe(() => operator.unlockCashier(req)));
    if (res === undefined) return;
    setOutcome(unlockAnswer(res, cashier));
    settle(cashier);
  };

  const sendPin = async (open: OpenDialog, pin: string): Promise<SaveAnswer | undefined> => {
    const target_cashier_id = open.cashier.id;
    const event_id = crypto.randomUUID();
    if (open.mode === 'first_pin') {
      const req = { event_id, target_cashier_id, initial_pin: pin };
      const res = await run(() => safe(() => operator.provisionCashierPin(req)));
      return res === undefined ? undefined : firstPinAnswer(res, open.cashier, pin);
    }
    const req = { event_id, target_cashier_id, new_pin: pin };
    const res = await run(() => safe(() => operator.resetCashierPin(req)));
    return res === undefined ? undefined : changePinAnswer(res, open.cashier);
  };

  const onSave = async (pin: string): Promise<PinSaveResult> => {
    if (dialog === null) return 'ignored';
    const answer = await sendPin(dialog, pin);
    if (answer === undefined) return 'ignored';
    if (answer.dialog === 'closed') {
      setDialog(null);
      setOutcome(answer.outcome);
    }
    settle(dialog.cashier);
    return answer.dialog;
  };

  /** RT-358 — the re-auth worked: send the same PIN again, once. */
  const onReauthenticated = async (): Promise<void> => {
    if (outcome?.kind !== 'reauth') return;
    const { cashier, pin } = outcome;
    setOutcome({ ...outcome, dialogOpen: false });
    const req = { event_id: crypto.randomUUID(), target_cashier_id: cashier.id, initial_pin: pin };
    const res = await run(() => safe(() => operator.provisionCashierPin(req)));
    if (res === undefined) return;
    setOutcome(afterReauthAnswer(res, cashier));
    settle(cashier);
  };

  const busy = pending || reading;

  return (
    <section
      className="v5-cashiers"
      aria-labelledby="v5-cashiers-title"
      data-testid="cashier-management"
    >
      <ScreenHead terminalLabel={terminalLabel} />
      <div className="v5-cashiers-outcome" aria-live="polite" data-testid="cashiers-outcome">
        {outcome !== null && (
          <OutcomeNotice
            outcome={outcome}
            pending={pending}
            onSignIn={() => {
              if (outcome.kind === 'reauth') setOutcome({ ...outcome, dialogOpen: true });
            }}
          />
        )}
      </div>
      <ListPanel
        list={list}
        busy={busy}
        headingRef={focus.headingRef}
        rowRef={focus.rowRef}
        onAction={onAction}
        onRetry={() => {
          // The retry button goes when the rows arrive: focus the list heading then.
          focus.target(null);
          void reload();
        }}
      />
      {dialog !== null && (
        <PinDialog
          mode={dialog.mode}
          name={dialog.cashier.display_name}
          // `busy`, not `pending`: after a refusal the dialog stays open while
          // the list re-reads, and no second Save may go out on stale state.
          pending={busy}
          onSave={onSave}
          onCancel={() => {
            if (!busy) setDialog(null);
          }}
        />
      )}
      {outcome?.kind === 'reauth' && outcome.dialogOpen && (
        <ReauthDialog
          operator={operator}
          onReauthenticated={() => {
            void onReauthenticated();
          }}
          onCancel={() => {
            // The «تسجيل الدخول» opener goes with the notice: focus that cashier's row.
            focus.now(outcome.cashier.id);
            setOutcome(null);
          }}
        />
      )}
    </section>
  );
}

function ScreenHead({
  terminalLabel,
}: Readonly<{ terminalLabel: string | undefined }>): JSX.Element {
  return (
    <div className="v5-cashiers-head">
      <h1 id="v5-cashiers-title">{CASHIERS_COPY.title}</h1>
      {terminalLabel !== undefined && terminalLabel.length > 0 && (
        <p data-testid="cashiers-terminal">
          {CASHIERS_COPY.subtitle}{' '}
          <b>
            <bdi>{terminalLabel}</bdi>
          </b>
        </p>
      )}
    </div>
  );
}

function OutcomeNotice({
  outcome,
  pending,
  onSignIn,
}: Readonly<{
  outcome: Outcome;
  pending: boolean;
  onSignIn: () => void;
}>): JSX.Element | null {
  switch (outcome.kind) {
    case 'done':
      return (
        <Notice tone="success" announce={false} testId="action-success">
          {CASHIERS_COPY.done[outcome.action]} <bdi>{outcome.name}</bdi>.
        </Notice>
      );
    case 'failure':
      return (
        <Notice tone="danger" announce={false} testId="action-error">
          {CASHIERS_COPY.failure}
        </Notice>
      );
    case 'after_reauth':
      return (
        <Notice tone="warning" announce={false} testId="action-error">
          {outcome.message}
        </Notice>
      );
    case 'reauth':
      // Hidden while the retry after a re-auth is in flight: one prompt only.
      return pending ? null : <ReauthNotice onSignIn={onSignIn} />;
  }
}

/** M6 — the shipped M-A3 copy with its one action, «تسجيل الدخول». */
function ReauthNotice({ onSignIn }: Readonly<{ onSignIn: () => void }>): JSX.Element {
  return (
    <Notice
      tone="warning"
      announce={false}
      testId="reauth-required"
      action={
        <button
          type="button"
          className="v5-cashiers-btn v5-cashiers-btn--primary"
          onClick={onSignIn}
        >
          {REAUTH_COPY.action}
        </button>
      }
    >
      {SIGN_IN_REFUSAL_COPY.reauth_required}
    </Notice>
  );
}

interface ListPanelProps {
  list: CashierListState;
  busy: boolean;
  headingRef: (el: HTMLHeadingElement | null) => void;
  rowRef: (id: string, el: HTMLLIElement | null) => void;
  onAction: (action: RowAction, cashier: CashierPinStatus) => void;
  onRetry: () => void;
}

function ListPanel({
  list,
  busy,
  headingRef,
  rowRef,
  onAction,
  onRetry,
}: Readonly<ListPanelProps>): JSX.Element {
  return (
    <section className="v5-cashiers-panel" aria-labelledby="v5-cashiers-list-heading">
      <div className="v5-cashiers-panel-head">
        <h2 id="v5-cashiers-list-heading" ref={headingRef} tabIndex={-1}>
          {CASHIERS_COPY.listHeading}
        </h2>
        {list.kind === 'rows' && (
          <span className="v5-cashiers-count">{CASHIERS_COPY.count(list.cashiers.length)}</span>
        )}
      </div>
      <ListBody list={list} busy={busy} rowRef={rowRef} onAction={onAction} onRetry={onRetry} />
    </section>
  );
}

function ListBody({
  list,
  busy,
  rowRef,
  onAction,
  onRetry,
}: Readonly<Omit<ListPanelProps, 'headingRef'>>): JSX.Element {
  if (list.kind === 'loading') {
    return (
      <PanelState>
        <output className="v5-cashiers-muted">{CASHIERS_COPY.loading}</output>
      </PanelState>
    );
  }
  if (list.kind === 'failed') {
    return (
      <PanelState>
        <Notice
          tone="warning"
          testId="cashier-management-error"
          action={
            <button type="button" className="v5-cashiers-btn" disabled={busy} onClick={onRetry}>
              <V5Icon name="retry" size={18} />
              {CASHIERS_COPY.retry}
            </button>
          }
        >
          {list.reason === 'unreachable' ? CASHIERS_COPY.unreachable : CASHIERS_COPY.refused}
        </Notice>
      </PanelState>
    );
  }
  if (list.cashiers.length === 0) {
    return (
      <PanelState>
        <Notice tone="info" testId="cashiers-empty">
          {CASHIERS_COPY.empty}
        </Notice>
      </PanelState>
    );
  }
  return <CashierRows cashiers={list.cashiers} busy={busy} onAction={onAction} rowRef={rowRef} />;
}

function PanelState({ children }: Readonly<{ children: ReactNode }>): JSX.Element {
  return <div className="v5-cashiers-panel-state">{children}</div>;
}

/**
 * After an action, the re-read may remove the button that had focus (a
 * first-PIN row becomes «جاهز»), and a retry or a cancelled re-auth removes
 * its own button. Once the read lands (or at once, for `now`), focus that
 * cashier's first enabled action, else the list heading, but only when focus
 * was lost (it sits on <body>): a manager who moved on keeps their place.
 * A `null` target means the heading.
 */
function useFocusAfterRead(
  reading: boolean,
  landed: number,
): {
  target: (id: string | null) => void;
  now: (id: string) => void;
  rowRef: (id: string, el: HTMLLIElement | null) => void;
  headingRef: (el: HTMLHeadingElement | null) => void;
} {
  const rows = useRef(new Map<string, HTMLLIElement>());
  const heading = useRef<HTMLHeadingElement | null>(null);
  const pendingTarget = useRef<{ id: string | null } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const target = pendingTarget.current;
    if (reading || target === null) return;
    pendingTarget.current = null;
    if (!focusWasLost()) return;
    const row = target.id === null ? undefined : rows.current.get(target.id);
    const button = row?.querySelector<HTMLButtonElement>('button:not([disabled])');
    (button ?? heading.current)?.focus();
  }, [reading, landed, tick]);

  return {
    target: (id) => {
      pendingTarget.current = { id };
    },
    now: (id) => {
      pendingTarget.current = { id };
      setTick((n) => n + 1);
    },
    rowRef: (id, el) => {
      if (el === null) rows.current.delete(id);
      else rows.current.set(id, el);
    },
    headingRef: (el) => {
      heading.current = el;
    },
  };
}

function focusWasLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}
