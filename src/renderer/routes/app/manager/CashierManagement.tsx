import { type JSX, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import type {
  CashierPinStatus,
  ListCashierPinStatusResponse,
  OperatorBridgeAPI,
  PairingBridgeAPI,
} from '../../../../shared/bridge-api.js';
import type { RefusalCategory } from '../../../../shared/audit/event-shape.js';
import { REAUTH_COPY, SIGN_IN_REFUSAL_COPY } from '../../../ui/operator/messages.js';
import { ReauthDialog } from '../../../ui/operator/ReauthDialog.js';
import { ToneIcon, type Tone } from '../../../v5/foundation/ToneIcon.js';
import '../../../v5/foundation/messages.css';
import { useTerminalLabel } from '../../../v5/entry/EntryStrip.js';
import { CashierRow, type RowAction } from '../../../v5/cashiers/CashierRow.js';
import { PinDialog } from '../../../v5/cashiers/PinDialog.js';
import {
  CASHIERS_COPY,
  SUCCESS_SENTENCE,
  cashierCount,
  type NamedSentence,
} from '../../../v5/cashiers/cashiers-copy.js';
import '../../../v5/cashiers/cashiers.css';

/**
 * T078 → RT-424 (D-M1) — the manager's Cashiers screen at /app/manager/cashiers,
 * rebuilt on the owner-approved G-3 references (doc 19 §3–§6). Manager and
 * admin only: main's `requireRole` is the trust gate (AD-1); the route guard is
 * the UX layer.
 *
 * - The list comes from `listCashierPinStatus` (doc 19 §2): each cashier with
 *   its PIN state on THIS terminal. Each row offers only the actions its state
 *   allows (M1–M6); the rest are not rendered (UX-05).
 * - Re-read, never polled: on mount, after every action (success or refusal)
 *   and on «إعادة المحاولة». A lock ends on its own after 5 minutes, so a
 *   «مقفل» badge would otherwise go stale. Rows already shown stay until the
 *   answer lands, then are replaced in one step; a refused read shows M1.
 * - One pending guard for every call (reads included): while one is in flight,
 *   every row action and the dialog's buttons are disabled, so a late answer
 *   can never overwrite a newer action (RT-235 review).
 * - RT-358 (M6): a first PIN refused `reauth_required` shows M-A3 with the
 *   single action «تسجيل الدخول». The typed PIN is kept in state; after a
 *   re-auth it is submitted again exactly once, and on cancel it is dropped.
 *   A refusal right after a re-auth never prompts again.
 *
 * PR-1: a PIN never renders, the roster id never renders, a refusal category
 * never renders. Unlock carries no PIN.
 */

type OperatorDeps = Pick<
  OperatorBridgeAPI,
  | 'listCashierPinStatus'
  | 'resetCashierPin'
  | 'provisionCashierPin'
  | 'unlockCashier'
  | 'reauthenticate'
>;

interface Props {
  operator: OperatorDeps;
  /** The paired terminal's label for the subtitle (M-K0b). Decorative: optional. */
  pairing?: PairingBridgeAPI;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; cashiers: CashierPinStatus[] }
  | { kind: 'failed'; offline: boolean };

type Notice =
  | { kind: 'none' }
  | { kind: 'success'; sentence: NamedSentence; name: string }
  | { kind: 'error'; message: string }
  | { kind: 'reauth'; cashier: CashierPinStatus; pin: string; dialogOpen: boolean };

type DialogState =
  | { kind: 'closed' }
  | {
      kind: 'open';
      mode: 'first' | 'change';
      cashier: CashierPinStatus;
      inlineMessage?: string;
    };

const READ_REFUSED: ListCashierPinStatusResponse = { kind: 'refused', category: 'invalid_input' };
const NONE: Notice = { kind: 'none' };
const CLOSED: DialogState = { kind: 'closed' };

function readList(operator: OperatorDeps): Promise<ListCashierPinStatusResponse> {
  if (operator.listCashierPinStatus === undefined) return Promise.resolve(READ_REFUSED);
  return operator.listCashierPinStatus().catch(() => READ_REFUSED);
}

function listStateOf(res: ListCashierPinStatusResponse): ListState {
  if (res.kind === 'cashiers') return { kind: 'loaded', cashiers: res.cashiers };
  return { kind: 'failed', offline: res.category === 'no_connection' };
}

function success(sentence: NamedSentence, name: string): Notice {
  return { kind: 'success', sentence, name };
}

const GENERIC_FAILURE: Notice = { kind: 'error', message: CASHIERS_COPY.genericFailure };

/**
 * A call that rejects (the lock guard refuses a locked session by throwing)
 * reads as a refusal, so the screen shows M-K9 instead of nothing.
 */
const CALL_FAILED = { kind: 'refused', category: 'invalid_input' } as const;

function settled<T>(call: () => Promise<T>): Promise<T | typeof CALL_FAILED> {
  return call().catch(() => CALL_FAILED);
}

/** A refusal right after a re-auth: never a new prompt, so `reauth_required` reads as signed out. */
function refusalAfterReauth(category: RefusalCategory): Notice {
  return {
    kind: 'error',
    message: SIGN_IN_REFUSAL_COPY[category === 'reauth_required' ? 'not_signed_in' : category],
  };
}

export function CashierManagement({ operator, pairing }: Props): JSX.Element {
  const terminalLabel = useTerminalLabel(pairing);
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [notice, setNotice] = useState<Notice>(NONE);
  const [dialog, setDialog] = useState<DialogState>(CLOSED);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);

  const runExclusive = useCallback(async (call: () => Promise<void>): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await call();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, []);

  /** The re-read every path ends with. Rows stay until the answer lands. */
  const reload = useCallback(async (): Promise<void> => {
    setList(listStateOf(await readList(operator)));
  }, [operator]);

  useEffect(() => {
    void runExclusive(reload);
  }, [runExclusive, reload]);

  function handleRowAction(action: RowAction, cashier: CashierPinStatus): void {
    if (pendingRef.current) return;
    setNotice(NONE);
    if (action === 'unlock') {
      void unlock(cashier);
      return;
    }
    setDialog({ kind: 'open', mode: action, cashier });
  }

  async function unlock(cashier: CashierPinStatus): Promise<void> {
    await runExclusive(async () => {
      const res = await settled(() =>
        operator.unlockCashier({ event_id: crypto.randomUUID(), target_cashier_id: cashier.id }),
      );
      // An already-expired lock answers state_invalid: that is unlocked too.
      const done = res.kind === 'unlocked' || res.category === 'state_invalid';
      setNotice(done ? success(SUCCESS_SENTENCE.unlock, cashier.display_name) : GENERIC_FAILURE);
      await reload();
    });
  }

  async function changePin(cashier: CashierPinStatus, pin: string): Promise<void> {
    await runExclusive(async () => {
      const res = await settled(() =>
        operator.resetCashierPin({
          event_id: crypto.randomUUID(),
          target_cashier_id: cashier.id,
          new_pin: pin,
        }),
      );
      setDialog(CLOSED);
      setNotice(
        res.kind === 'pin_reset'
          ? success(SUCCESS_SENTENCE.change, cashier.display_name)
          : GENERIC_FAILURE,
      );
      await reload();
    });
  }

  async function firstPin(
    cashier: CashierPinStatus,
    pin: string,
    afterReauth: boolean,
  ): Promise<void> {
    await runExclusive(async () => {
      const res = await settled(() =>
        operator.provisionCashierPin({
          event_id: crypto.randomUUID(),
          target_cashier_id: cashier.id,
          initial_pin: pin,
        }),
      );
      if (res.kind === 'pin_provisioned') {
        setDialog(CLOSED);
        setNotice(success(SUCCESS_SENTENCE.first, cashier.display_name));
      } else if (afterReauth) {
        setNotice(refusalAfterReauth(res.category));
      } else if (res.category === 'not_ready') {
        // M-K10 stays inside the dialog.
        setDialog({ kind: 'open', mode: 'first', cashier, inlineMessage: CASHIERS_COPY.notReady });
      } else if (res.category === 'reauth_required') {
        setDialog(CLOSED);
        setNotice({ kind: 'reauth', cashier, pin, dialogOpen: false });
      } else {
        setDialog(CLOSED);
        setNotice(GENERIC_FAILURE);
      }
      await reload();
    });
  }

  function handleSave(pin: string): void {
    if (dialog.kind !== 'open') return;
    if (dialog.mode === 'first') void firstPin(dialog.cashier, pin, false);
    else void changePin(dialog.cashier, pin);
  }

  /** RT-358 — the re-auth worked: submit the same PIN again, once. */
  function handleReauthenticated(): void {
    if (notice.kind !== 'reauth') return;
    const { cashier, pin } = notice;
    setNotice(NONE);
    void firstPin(cashier, pin, true);
  }

  const reauthDialogOpen = notice.kind === 'reauth' && notice.dialogOpen;
  const modalOpen = dialog.kind === 'open' || reauthDialogOpen;

  return (
    <>
      <div
        className="v5-cashiers"
        data-testid="cashier-management"
        dir="rtl"
        lang="ar"
        inert={modalOpen ? true : undefined}
      >
        <div className="v5-cashiers__head">
          <h1>{CASHIERS_COPY.title}</h1>
          {terminalLabel !== undefined && terminalLabel.length > 0 && (
            <p>
              {CASHIERS_COPY.subtitle}{' '}
              <b>
                <bdi>{terminalLabel}</bdi>
              </b>
            </p>
          )}
        </div>

        <ScreenNotice
          notice={notice}
          pending={pending}
          onSignIn={() => {
            if (notice.kind === 'reauth') setNotice({ ...notice, dialogOpen: true });
          }}
        />

        <section className="v5-cashiers__panel" aria-labelledby="cashiers-list-h">
          <div className="v5-cashiers__panel-head">
            <h2 id="cashiers-list-h">{CASHIERS_COPY.listHeading}</h2>
            {list.kind === 'loaded' && (
              <span className="v5-cashiers__count">{cashierCount(list.cashiers.length)}</span>
            )}
          </div>
          <ListBody
            list={list}
            pending={pending}
            onRetry={() => {
              void runExclusive(reload);
            }}
            onAction={handleRowAction}
          />
        </section>
      </div>

      {dialog.kind === 'open' && (
        <PinDialog
          mode={dialog.mode}
          cashierName={dialog.cashier.display_name}
          pending={pending}
          {...(dialog.inlineMessage === undefined ? {} : { inlineMessage: dialog.inlineMessage })}
          onSave={handleSave}
          onCancel={() => {
            if (!pendingRef.current) setDialog(CLOSED);
          }}
        />
      )}

      {reauthDialogOpen && (
        <ReauthDialog
          operator={operator}
          onReauthenticated={handleReauthenticated}
          onCancel={() => {
            setNotice(NONE);
          }}
        />
      )}
    </>
  );
}

function NoticeBox({
  tone,
  role,
  testId,
  children,
}: {
  tone: Tone;
  role: 'status' | 'alert';
  testId: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="v5-notice" data-tone={tone} role={role} data-testid={testId}>
      <ToneIcon tone={tone} />
      {children}
    </div>
  );
}

function ScreenNotice({
  notice,
  pending,
  onSignIn,
}: {
  notice: Notice;
  pending: boolean;
  onSignIn: () => void;
}): JSX.Element | null {
  switch (notice.kind) {
    case 'none':
      return null;
    case 'success':
      return (
        <NoticeBox tone="success" role="status" testId="action-success">
          <p>
            {notice.sentence.before}
            <bdi>{notice.name}</bdi>
            {notice.sentence.after}
          </p>
        </NoticeBox>
      );
    case 'error':
      return (
        <NoticeBox tone="danger" role="alert" testId="action-error">
          <p>{notice.message}</p>
        </NoticeBox>
      );
    case 'reauth':
      // Hidden while the PIN retry after a re-auth is in flight: one prompt only.
      if (pending || notice.dialogOpen) return null;
      return (
        <NoticeBox tone="warning" role="alert" testId="reauth-required">
          <p>{SIGN_IN_REFUSAL_COPY.reauth_required}</p>
          <button
            type="button"
            className="v5-cashiers-btn v5-cashiers-btn--primary"
            onClick={onSignIn}
          >
            {REAUTH_COPY.action}
          </button>
        </NoticeBox>
      );
  }
}

function ListBody({
  list,
  pending,
  onRetry,
  onAction,
}: {
  list: ListState;
  pending: boolean;
  onRetry: () => void;
  onAction: (action: RowAction, cashier: CashierPinStatus) => void;
}): JSX.Element {
  if (list.kind === 'loading') {
    return (
      <div className="v5-cashiers__state">
        <p className="v5-cashiers__loading" role="status">
          {CASHIERS_COPY.loading}
        </p>
      </div>
    );
  }
  if (list.kind === 'failed') {
    return (
      <div className="v5-cashiers__state">
        <NoticeBox tone="warning" role="alert" testId="cashier-management-error">
          <p>{list.offline ? CASHIERS_COPY.rosterOffline : CASHIERS_COPY.rosterRefused}</p>
          <button type="button" className="v5-cashiers-btn" disabled={pending} onClick={onRetry}>
            {CASHIERS_COPY.retry}
          </button>
        </NoticeBox>
      </div>
    );
  }
  if (list.cashiers.length === 0) {
    return (
      <div className="v5-cashiers__state">
        <div className="v5-notice" data-tone="neutral" role="status">
          <p>{CASHIERS_COPY.empty}</p>
        </div>
      </div>
    );
  }
  return (
    <ul className="v5-cashiers__rows" aria-labelledby="cashiers-list-h">
      {list.cashiers.map((c) => (
        <CashierRow key={c.id} cashier={c} disabled={pending} onAction={onAction} />
      ))}
    </ul>
  );
}
