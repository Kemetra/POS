import { useState, useEffect, useCallback, type JSX } from 'react';

import {
  FORCED_CLOSE_REASONS,
  type ForcedCloseReason,
} from '../../../shared/audit/payload-schemas.js';
import type {
  OperatorBridgeAPI,
  StuckShiftSummary,
  ListStuckShiftsResponse,
} from '../../../shared/bridge-api.js';
import { ReauthDialog, ReauthRequiredNotice } from './ReauthDialog.js';
import { SIGN_IN_REFUSAL_COPY } from './messages.js';

// ─── Duration formatting ──────────────────────────────────────────────────────

function formatDuration(minutes: number): string {
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${String(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h)} h ${String(m)} min`;
}

// ─── ForcedCloseSurface (T083 — read-only summary row) ────────────────────────

export interface ForcedCloseSurfaceProps {
  cashier_display_name: string;
  terminal_label: string;
  /** ISO 8601 UTC timestamp string. */
  opened_at: string;
  duration_minutes: number;
}

/**
 * 004-operator-session T083 — read-only summary row for a stuck shift.
 *
 * FR-013 minimum-disclosure: renders only the four Wave 4.1 stub fields.
 * FR-024 blind-close discipline: NO drawer count, expected total, variance,
 * shortage, overage, change fund, or any financial/KPI field.
 *
 * Card-stack layout (div rows, not table).
 */
export function ForcedCloseSurface({
  cashier_display_name,
  terminal_label,
  opened_at,
  duration_minutes,
}: ForcedCloseSurfaceProps): JSX.Element {
  return (
    <div data-testid="forced-close-surface">
      <div data-testid="fcs-cashier-name">{cashier_display_name}</div>
      <div data-testid="fcs-terminal-label">{terminal_label}</div>
      <div data-testid="fcs-opened-at">{opened_at}</div>
      <div data-testid="fcs-duration">{duration_minutes}</div>
    </div>
  );
}

// ─── ForcedCloseForm ──────────────────────────────────────────────────────────

export interface ForcedCloseFormSubmitPayload {
  forced_close_reason: ForcedCloseReason;
  annotation?: string;
}

export interface ForcedCloseFormProps {
  onSubmit: (payload: ForcedCloseFormSubmitPayload) => void;
  onCancel: () => void;
  submitting?: boolean;
}

/**
 * 004-operator-session T084 — forced-close reason picker form.
 *
 * - Submit is disabled until a reason radio is selected.
 * - Exactly the five FORCED_CLOSE_REASONS values are offered.
 * - Free-text annotation captured in payload.annotation only;
 *   payload.forced_close_reason contains only the enum value.
 * - No financial or PII fields.
 */
export function ForcedCloseForm({
  onSubmit,
  onCancel,
  submitting,
}: ForcedCloseFormProps): JSX.Element {
  const [reason, setReason] = useState<ForcedCloseReason | null>(null);
  const [annotation, setAnnotation] = useState('');

  function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>): void {
    e.preventDefault();
    /* v8 ignore next 1 */
    if (reason == null) return;
    onSubmit(
      annotation ? { forced_close_reason: reason, annotation } : { forced_close_reason: reason },
    );
  }

  return (
    <form data-testid="forced-close-form" onSubmit={handleSubmit}>
      <fieldset>
        <legend>Reason for forced close</legend>
        {FORCED_CLOSE_REASONS.map((r) => (
          <label key={r}>
            <input
              type="radio"
              name="forced_close_reason"
              value={r}
              checked={reason === r}
              onChange={() => {
                setReason(r);
              }}
            />
            {r}
          </label>
        ))}
      </fieldset>

      <label htmlFor="forced-close-annotation">Annotation (optional)</label>
      <textarea
        id="forced-close-annotation"
        value={annotation}
        maxLength={500}
        onChange={(e) => {
          setAnnotation(e.target.value);
        }}
      />

      <button type="submit" disabled={reason == null || submitting}>
        Confirm forced close
      </button>
      <button type="button" onClick={onCancel} disabled={submitting}>
        Cancel
      </button>
    </form>
  );
}

// ─── StuckShiftSurface (T090 — orchestrated container) ───────────────────────

export interface StuckShiftSurfaceProps {
  operator: Pick<OperatorBridgeAPI, 'listStuckShifts' | 'forceCloseShift' | 'reauthenticate'>;
}

type SurfaceState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error' }
  /** RT-358 — the manager's sign-in expired; the re-auth dialog may be open. */
  | { kind: 'reauth'; dialogOpen: boolean }
  /** RT-358 — refused right after a re-auth: Arabic sign-in copy, no Retry, no new prompt. */
  | { kind: 'reauthFailed'; message: string }
  | { kind: 'list'; shifts: StuckShiftSummary[] };

/** RT-358 — a list answer as a surface state; a second re-auth prompt is never shown. */
function surfaceOf(res: ListStuckShiftsResponse, afterReauth: boolean): SurfaceState {
  if (res.kind === 'stuck_shifts') {
    return res.shifts.length === 0 ? { kind: 'empty' } : { kind: 'list', shifts: res.shifts };
  }
  if (afterReauth) {
    const category = res.category === 'reauth_required' ? 'not_signed_in' : res.category;
    return { kind: 'reauthFailed', message: SIGN_IN_REFUSAL_COPY[category] };
  }
  return res.category === 'reauth_required'
    ? { kind: 'reauth', dialogOpen: false }
    : { kind: 'error' };
}

type DialogState =
  | { kind: 'idle' }
  | { kind: 'open'; shift: StuckShiftSummary; submitting: boolean; submitError: boolean };

/**
 * 004-operator-session T090 — manager/admin forced-close recovery surface.
 *
 * Fetches stuck shifts on mount, renders loading/empty/error/list states,
 * and manages the forced-close dialog lifecycle.
 *
 * FR-024 blind-close discipline: no financial fields rendered.
 * FR-013 minimum-disclosure: only display-safe shift fields shown.
 * Card-stack layout (div rows, not table).
 */
export function StuckShiftSurface({ operator }: StuckShiftSurfaceProps): JSX.Element {
  const [surface, setSurface] = useState<SurfaceState>({ kind: 'loading' });
  const [dialog, setDialog] = useState<DialogState>({ kind: 'idle' });

  const fetchShifts = useCallback(
    async (afterReauth = false): Promise<void> => {
      setSurface({ kind: 'loading' });
      const res: ListStuckShiftsResponse = await operator.listStuckShifts();
      setSurface(surfaceOf(res, afterReauth));
    },
    [operator],
  );

  useEffect(() => {
    void fetchShifts();
  }, [fetchShifts]);

  // Escape closes the force-close dialog (WCAG 2.1.1) when open, mirroring its
  // Cancel button (setDialog idle). Only active while the dialog is open so it
  // doesn't swallow Escape elsewhere on the surface. Not submitting-guarded:
  // cancelling a dialog mid-submit is the same as clicking Cancel.
  useEffect(() => {
    if (dialog.kind !== 'open') return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setDialog({ kind: 'idle' });
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dialog.kind]);

  async function handleSubmit(
    shift: StuckShiftSummary,
    payload: ForcedCloseFormSubmitPayload,
  ): Promise<void> {
    setDialog({ kind: 'open', shift, submitting: true, submitError: false });

    const res = await operator.forceCloseShift({
      event_id: crypto.randomUUID(),
      shift_id: shift.shift_id,
      reason: payload.forced_close_reason,
      ...(payload.annotation !== undefined ? { annotation: payload.annotation } : {}),
    });

    if (res.kind === 'forced_closed') {
      setDialog({ kind: 'idle' });
      setSurface((prev) => {
        if (prev.kind !== 'list') return prev;
        const remaining = prev.shifts.filter((s) => s.shift_id !== shift.shift_id);
        return remaining.length === 0 ? { kind: 'empty' } : { kind: 'list', shifts: remaining };
      });
    } else if (res.category === 'state_invalid') {
      setDialog({ kind: 'open', shift, submitting: false, submitError: true });
      void fetchShifts();
    } else {
      setDialog({ kind: 'open', shift, submitting: false, submitError: true });
    }
  }

  return (
    <div data-testid="stuck-shift-surface">
      {surface.kind === 'loading' && (
        <div data-testid="stuck-shift-surface-loading" aria-busy="true">
          Loading stuck shifts…
        </div>
      )}

      {surface.kind === 'empty' && (
        <div data-testid="stuck-shift-surface-empty">No stuck shifts found.</div>
      )}

      {surface.kind === 'error' && (
        <div data-testid="stuck-shift-surface-error" role="alert">
          <p>Unable to load stuck shifts. Please try again.</p>
          <button
            type="button"
            onClick={() => {
              void fetchShifts();
            }}
          >
            Retry
          </button>
        </div>
      )}

      {surface.kind === 'reauth' && (
        <ReauthRequiredNotice
          onSignIn={() => {
            setSurface({ kind: 'reauth', dialogOpen: true });
          }}
        />
      )}

      {surface.kind === 'reauthFailed' && (
        <p data-testid="stuck-shift-surface-reauth-failed" role="alert" dir="rtl" lang="ar">
          {surface.message}
        </p>
      )}

      {surface.kind === 'reauth' && surface.dialogOpen && (
        <ReauthDialog
          operator={operator}
          onReauthenticated={() => {
            void fetchShifts(true);
          }}
          onCancel={() => {
            setSurface({ kind: 'reauth', dialogOpen: false });
          }}
        />
      )}

      {surface.kind === 'list' && (
        <div data-testid="stuck-shift-list">
          {surface.shifts.map((shift) => (
            <div
              key={shift.shift_id}
              data-testid={`stuck-shift-card-${shift.shift_id}`}
              role="button"
              tabIndex={0}
              onClick={() => {
                setDialog({ kind: 'open', shift, submitting: false, submitError: false });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setDialog({ kind: 'open', shift, submitting: false, submitError: false });
                }
              }}
            >
              <div>{shift.cashier_display_name || 'Cashier ···'}</div>
              <div>{shift.terminal_label}</div>
              <div>{formatDuration(shift.duration_minutes)}</div>
            </div>
          ))}
        </div>
      )}

      {dialog.kind === 'open' && (
        <div role="dialog" aria-modal="true" aria-label="Force close shift">
          {dialog.submitError && (
            <p data-testid="stuck-shift-submit-error" role="alert">
              This shift could not be force-closed. The list has been refreshed.
            </p>
          )}
          <ForcedCloseForm
            onSubmit={(payload) => {
              void handleSubmit(dialog.shift, payload);
            }}
            onCancel={() => {
              setDialog({ kind: 'idle' });
            }}
            submitting={dialog.submitting}
          />
        </div>
      )}
    </div>
  );
}
