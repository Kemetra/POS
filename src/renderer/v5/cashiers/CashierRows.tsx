import { useId, type JSX } from 'react';

import type { CashierPinState, CashierPinStatus } from '../../../shared/bridge-api';
import { V5Icon, type V5IconName } from '../foundation/V5Icon';
import { CASHIERS_COPY } from './cashiers-copy';
import { formatLockTime, rowActions, type RowAction } from './cashiers-model';

/**
 * RT-424 (G-3) — the cashier rows. Each row: the initial, the name (wraps,
 * never cut), the PIN badge (text + its own glyph, never colour alone, UX-02)
 * and two fixed action slots so every row's actions line up. An action that
 * does not fit the state is absent, not disabled (UX-05). The roster id never
 * reaches the DOM (PR-1).
 */

const BADGE_GLYPH: Record<CashierPinState, V5IconName> = {
  no_pin: 'dash',
  ready: 'check',
  locked: 'lock',
};

export interface CashierRowsProps {
  cashiers: readonly CashierPinStatus[];
  /** Every action is disabled while a call or a re-read is in flight (one shared guard). */
  busy: boolean;
  onAction: (action: RowAction, cashier: CashierPinStatus, opener: HTMLButtonElement) => void;
  /** The row element for each cashier, for focus after a re-read (keyed in JS, not the DOM). */
  rowRef: (id: string, el: HTMLLIElement | null) => void;
}

export function CashierRows({ cashiers, busy, onAction, rowRef }: CashierRowsProps): JSX.Element {
  return (
    <ul className="v5-cashiers-rows" aria-labelledby="v5-cashiers-list-heading">
      {cashiers.map((cashier) => (
        <CashierRow
          key={cashier.id}
          cashier={cashier}
          busy={busy}
          onAction={onAction}
          rowRef={rowRef}
        />
      ))}
    </ul>
  );
}

/** One row. The buttons are described by the row's name, so «تغيير الرقم السري» is never ambiguous. */
function CashierRow({
  cashier,
  busy,
  onAction,
  rowRef,
}: Omit<CashierRowsProps, 'cashiers'> & { cashier: CashierPinStatus }): JSX.Element {
  const nameId = useId();
  return (
    <li
      ref={(el) => {
        rowRef(cashier.id, el);
      }}
      className="v5-cashiers-row"
      data-testid="cashier-row"
      data-pin={cashier.pin}
    >
      <span className="v5-cashiers-initial" aria-hidden="true">
        {cashier.display_name.trim().charAt(0)}
      </span>
      <span className="v5-cashiers-name" id={nameId}>
        <bdi>{cashier.display_name}</bdi>
      </span>
      <PinBadge cashier={cashier} />
      <RowButtons cashier={cashier} busy={busy} onAction={onAction} describedBy={nameId} />
    </li>
  );
}

function PinBadge({ cashier }: { cashier: CashierPinStatus }): JSX.Element {
  const until = cashier.pin === 'locked' ? lockTime(cashier.locked_until) : null;
  return (
    <span className="v5-cashiers-badge" data-pin={cashier.pin} data-testid="cashier-pin-badge">
      <V5Icon name={BADGE_GLYPH[cashier.pin]} size={16} />
      {CASHIERS_COPY.badge[cashier.pin]}
      {until !== null && (
        <>
          {' '}
          <time className="v5-cashiers-until" dateTime={until.iso}>
            {CASHIERS_COPY.lockedUntil} <bdi dir="ltr">{until.text}</bdi>
          </time>
        </>
      )}
    </span>
  );
}

function lockTime(iso: string | undefined): { iso: string; text: string } | null {
  if (iso === undefined) return null;
  const text = formatLockTime(iso);
  return text === null ? null : { iso, text };
}

interface ButtonContext {
  cashier: CashierPinStatus;
  busy: boolean;
  onAction: CashierRowsProps['onAction'];
  describedBy: string;
}

function RowButtons(ctx: ButtonContext): JSX.Element {
  const { primary, secondary } = rowActions(ctx.cashier.pin);
  return (
    <div className="v5-cashiers-actions">
      <div className="v5-cashiers-slot">
        {primary !== null && <ActionButton action={primary} ctx={ctx} />}
      </div>
      <div className="v5-cashiers-slot">
        {secondary !== null && <ActionButton action={secondary} ctx={ctx} ghost />}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  ctx,
  ghost = false,
}: {
  action: RowAction;
  ctx: ButtonContext;
  ghost?: boolean;
}): JSX.Element {
  const { cashier, busy, onAction, describedBy } = ctx;
  return (
    <button
      type="button"
      className={ghost ? 'v5-cashiers-btn v5-cashiers-btn--ghost' : 'v5-cashiers-btn'}
      disabled={busy}
      data-action={action}
      aria-describedby={describedBy}
      onClick={(e) => {
        onAction(action, cashier, e.currentTarget);
      }}
    >
      {CASHIERS_COPY.action[action]}
    </button>
  );
}
