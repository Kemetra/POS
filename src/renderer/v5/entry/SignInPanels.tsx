import type { JSX, ReactNode } from 'react';

import { Icon } from '../../icons/Icon';
import { ToneIcon } from '../foundation/ToneIcon';
import '../foundation/messages.css';
import { SIGN_IN_COPY, nameInitial } from './entry-copy';

/**
 * RT-244 (VNext W1-D) — the sign-in screen's two zones (G-1 references):
 * "who are you" (the roster, inline start) and "prove it" (the fixed PIN or
 * manager column, inline end). Presentation only: the route owns the state.
 */

/** What the roster fetch proved. Only `ready` has tiles to pick from. */
export type RosterState = 'loading' | 'ready' | 'offline' | 'refused' | 'empty';

const ROSTER_NOTICE: Readonly<
  Partial<Record<RosterState, { tone: 'warning' | 'info'; text: string }>>
> = Object.freeze({
  offline: { tone: 'warning', text: SIGN_IN_COPY.rosterOffline },
  refused: { tone: 'warning', text: SIGN_IN_COPY.rosterRefused },
  empty: { tone: 'info', text: SIGN_IN_COPY.rosterEmpty },
});

/** The PIN column's prompt before a cashier is picked, per roster state. */
export function pinPromptFor(state: RosterState): string {
  if (state === 'offline' || state === 'refused') return SIGN_IN_COPY.pinPromptNoRoster;
  if (state === 'empty') return SIGN_IN_COPY.pinPromptEmptyRoster;
  return SIGN_IN_COPY.pinPrompt;
}

export function RosterPanel({
  state,
  roster,
  managerMode,
  onManagerEntry,
  disabled = false,
}: Readonly<{
  state: RosterState;
  roster: ReactNode;
  managerMode: boolean;
  onManagerEntry: () => void;
  /** True while a sign-in is in flight: the column must not switch. */
  disabled?: boolean;
}>): JSX.Element {
  const notice = ROSTER_NOTICE[state];
  return (
    <section className="v5-entry__panel" aria-labelledby="signin-roster-heading">
      <div className="v5-entry__panel-head">
        <h2 className="v5-entry__panel-title" id="signin-roster-heading">
          {SIGN_IN_COPY.rosterHeading}
        </h2>
      </div>
      {notice !== undefined ? (
        <div className="v5-entry__panel-body" data-testid="roster-state" data-state={state}>
          <div
            className="v5-notice"
            data-tone={notice.tone}
            role={notice.tone === 'warning' ? 'alert' : 'status'}
          >
            <ToneIcon tone={notice.tone} />
            <div className="v5-notice__text">{notice.text}</div>
          </div>
        </div>
      ) : (
        roster
      )}
      <div className="v5-entry__panel-foot">
        <button
          type="button"
          className="v5-entry__btn"
          data-testid="sign-in-manager-entry"
          aria-pressed={managerMode}
          disabled={disabled}
          onClick={onManagerEntry}
        >
          <Icon name="key" />
          {SIGN_IN_COPY.managerEntry}
        </button>
      </div>
    </section>
  );
}

/** The inline-end column's frame: a fixed-height head, then its body. */
export function AuthPanel({
  head,
  children,
}: Readonly<{
  head: ReactNode;
  children: ReactNode;
}>): JSX.Element {
  return (
    <aside
      className="v5-entry__panel v5-entry__auth"
      aria-labelledby="signin-auth-heading"
      data-testid="sign-in-auth"
    >
      <div className="v5-entry__panel-head">{head}</div>
      {children}
    </aside>
  );
}

export function AuthHeading({ children }: Readonly<{ children: ReactNode }>): JSX.Element {
  return (
    <h2 className="v5-entry__panel-title" id="signin-auth-heading">
      {children}
    </h2>
  );
}

export function BackButton({
  onClick,
  disabled = false,
  testId,
}: Readonly<{
  onClick: () => void;
  disabled?: boolean;
  testId: string;
}>): JSX.Element {
  return (
    <button
      type="button"
      className="v5-entry__btn v5-entry__btn--ghost"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name="back" />
      {SIGN_IN_COPY.back}
    </button>
  );
}

/** The picked cashier: badge, name and role, in the PIN column's head. */
export function PickedCashier({ name }: Readonly<{ name: string }>): JSX.Element {
  return (
    <div className="v5-entry__auth-who">
      <span className="v5-entry__badge" aria-hidden="true">
        {nameInitial(name)}
      </span>
      <div>
        <h2
          className="v5-entry__panel-title"
          id="signin-auth-heading"
          data-testid="pin-cashier-name"
        >
          {name}
        </h2>
        <span className="v5-entry__meta">{SIGN_IN_COPY.cashierRole}</span>
      </div>
    </div>
  );
}
