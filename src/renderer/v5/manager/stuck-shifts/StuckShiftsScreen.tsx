import { useId, type JSX, type ReactNode } from 'react';

import type { StuckShiftSummary } from '../../../../shared/bridge-api';
import { Notice } from '../../foundation/Notice';
import { V5Icon } from '../../foundation/V5Icon';
import { STUCK_SHIFTS_COPY as COPY } from './stuck-shifts-copy';
import { displayNameOf, formatOpenFor, initialOf } from './stuck-shifts-model';
import type { StuckShiftFocus } from './use-stuck-shift-focus';
import './stuck-shifts.css';

/**
 * RT-502 (VN-S10 S10-5, G-6 StuckList / StuckEmpty / StuckUnreachable) — the
 * stuck-shifts screen, presentation only. `StuckShiftSurface`
 * (`ui/operator/ForcedCloseSurface.tsx`) keeps the state and both bridge
 * calls; the route's ScreenSection renders the <h1>.
 *
 * - One row per shift: the cashier name in <bdi> (wraps, never cut), the
 *   terminal label as an LTR mono run, «مفتوحة منذ ‹مدة›» and a real
 *   «إغلاق الوردية» button described by the row's name.
 * - Loading, empty and unreachable are page-state notices under the sub-line.
 * - No amount anywhere (FR-024 blind close); only the display-safe fields
 *   (FR-013). The shift id never reaches the visible text.
 */

/** The page: the sub-line, then whichever state the surface is in. */
export function StuckShiftsPage({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="v5-stuck" data-testid="stuck-shift-surface">
      <p className="v5-stuck-sub">{COPY.subtitle}</p>
      {children}
    </div>
  );
}

/** A page-state slot: loading, empty, unreachable and the re-auth notices sit in one. */
export function StuckShiftsState({
  children,
  stateRef,
}: {
  children: ReactNode;
  stateRef?: (el: HTMLDivElement | null) => void;
}): JSX.Element {
  return (
    <div className="v5-stuck-state" ref={stateRef} tabIndex={stateRef ? -1 : undefined}>
      {children}
    </div>
  );
}

export function StuckShiftsLoading(): JSX.Element {
  return (
    <StuckShiftsState>
      <p
        className="v5-stuck-muted"
        role="status"
        aria-busy="true"
        data-testid="stuck-shift-surface-loading"
      >
        {COPY.loading}
      </p>
    </StuckShiftsState>
  );
}

export function StuckShiftsEmpty({ focus }: { focus: StuckShiftFocus }): JSX.Element {
  return (
    <StuckShiftsState stateRef={focus.stateRef}>
      <div className="v5-stuck-neutral">
        <Notice tone="info" testId="stuck-shift-surface-empty">
          {COPY.empty}
        </Notice>
      </div>
    </StuckShiftsState>
  );
}

export function StuckShiftsUnreachable({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <StuckShiftsState>
      <Notice
        tone="warning"
        testId="stuck-shift-surface-error"
        action={
          <button type="button" className="v5-stuck-btn" onClick={onRetry}>
            <V5Icon name="retry" size={18} />
            {COPY.retry}
          </button>
        }
      >
        {COPY.unreachable}
      </Notice>
    </StuckShiftsState>
  );
}

export interface StuckShiftListProps {
  shifts: readonly StuckShiftSummary[];
  onClose: (shift: StuckShiftSummary) => void;
  focus: StuckShiftFocus;
}

export function StuckShiftList({ shifts, onClose, focus }: StuckShiftListProps): JSX.Element {
  const headingId = useId();
  return (
    <section className="v5-stuck-panel" aria-labelledby={headingId} data-testid="stuck-shift-list">
      <div className="v5-stuck-panel-head">
        <h2 id={headingId} ref={focus.headingRef} tabIndex={-1}>
          {COPY.listHeading}
        </h2>
      </div>
      <ul className="v5-stuck-rows" aria-labelledby={headingId} ref={focus.listRef}>
        {shifts.map((shift) => (
          <StuckShiftRow key={shift.shift_id} shift={shift} onClose={onClose} focus={focus} />
        ))}
      </ul>
    </section>
  );
}

function StuckShiftRow({
  shift,
  onClose,
  focus,
}: {
  shift: StuckShiftSummary;
  onClose: (shift: StuckShiftSummary) => void;
  focus: StuckShiftFocus;
}): JSX.Element {
  const nameId = useId();
  const name = displayNameOf(shift.cashier_display_name);
  return (
    <li
      ref={(el) => {
        focus.rowRef(shift.shift_id, el);
      }}
      className="v5-stuck-row"
      data-testid={`stuck-shift-card-${shift.shift_id}`}
    >
      <span className="v5-stuck-initial" aria-hidden="true">
        {initialOf(name)}
      </span>
      <span className="v5-stuck-name" id={nameId}>
        <bdi>{name}</bdi>
      </span>
      <span className="v5-stuck-terminal" dir="ltr">
        {shift.terminal_label}
      </span>
      <span className="v5-stuck-since">
        {COPY.openFor} {formatOpenFor(shift.duration_minutes)}
      </span>
      <button
        type="button"
        className="v5-stuck-btn"
        aria-describedby={nameId}
        onClick={() => {
          onClose(shift);
        }}
      >
        {COPY.close}
      </button>
    </li>
  );
}
