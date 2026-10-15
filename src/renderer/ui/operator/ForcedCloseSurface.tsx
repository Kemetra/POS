import { useState, useEffect, useCallback, type JSX } from 'react';

import type {
  OperatorBridgeAPI,
  StuckShiftSummary,
  ListStuckShiftsResponse,
} from '../../../shared/bridge-api.js';
import { ReauthDialog, ReauthRequiredNotice } from './ReauthDialog.js';
import { SIGN_IN_REFUSAL_COPY } from './messages.js';
import {
  ForcedCloseDialog,
  type ForcedCloseFormSubmitPayload,
  type ForcedCloseRefusal,
} from '../../v5/manager/stuck-shifts/ForcedCloseDialog.js';
import { displayNameOf } from '../../v5/manager/stuck-shifts/stuck-shifts-model.js';
import {
  StuckShiftList,
  StuckShiftsEmpty,
  StuckShiftsLoading,
  StuckShiftsPage,
  StuckShiftsState,
  StuckShiftsUnreachable,
} from '../../v5/manager/stuck-shifts/StuckShiftsScreen.js';
import { useStuckShiftFocus } from '../../v5/manager/stuck-shifts/use-stuck-shift-focus.js';

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

// ─── ForcedCloseForm (T084) ───────────────────────────────────────────────────

// RT-502 (VN-S10 S10-5): the reason picker moved to the v5 forced-close dialog
// (Arabic reasons, same payload). Re-exported so existing imports keep working.
export { ForcedCloseForm } from '../../v5/manager/stuck-shifts/ForcedCloseDialog.js';
export type {
  ForcedCloseFormProps,
  ForcedCloseFormSubmitPayload,
} from '../../v5/manager/stuck-shifts/ForcedCloseDialog.js';

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
  | {
      kind: 'open';
      shift: StuckShiftSummary;
      submitting: boolean;
      /** RT-502: which refusal the dialog shows; `null` before any answer. */
      refusal: ForcedCloseRefusal | null;
    };

/**
 * 004-operator-session T090 — manager/admin forced-close recovery surface.
 *
 * Fetches stuck shifts on mount, renders loading/empty/error/list states,
 * and manages the forced-close dialog lifecycle.
 *
 * RT-502 (VN-S10 S10-5): the state, both bridge calls and the refusal
 * branches stay here unchanged; the presentation is the v5 screen and dialog
 * in `v5/manager/stuck-shifts/` (G-6 Stuck*). The RT-358 re-auth notice and
 * dialog render exactly as before.
 *
 * FR-024 blind-close discipline: no financial fields rendered.
 * FR-013 minimum-disclosure: only display-safe shift fields shown.
 */
export function StuckShiftSurface({ operator }: StuckShiftSurfaceProps): JSX.Element {
  const [surface, setSurface] = useState<SurfaceState>({ kind: 'loading' });
  const [dialog, setDialog] = useState<DialogState>({ kind: 'idle' });
  const focus = useStuckShiftFocus(surface.kind !== 'loading');
  const { afterClose } = focus;
  const openShiftId = dialog.kind === 'open' ? dialog.shift.shift_id : null;

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

  /** Cancel (button or Esc) and success: close, then put focus back on the list. */
  const closeDialog = useCallback(
    (shiftId: string): void => {
      afterClose(shiftId);
      setDialog({ kind: 'idle' });
    },
    [afterClose],
  );

  // Escape closes the force-close dialog (WCAG 2.1.1) when open, mirroring its
  // Cancel button (setDialog idle). Only active while the dialog is open so it
  // doesn't swallow Escape elsewhere on the surface. Not submitting-guarded:
  // cancelling a dialog mid-submit is the same as clicking Cancel.
  // RT-502: the v5 Dialog handles Esc while focus is inside it and stops the
  // key there; this listener still covers focus lost to <body> mid-submit.
  useEffect(() => {
    if (openShiftId === null) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        closeDialog(openShiftId);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openShiftId, closeDialog]);

  async function handleSubmit(
    shift: StuckShiftSummary,
    payload: ForcedCloseFormSubmitPayload,
  ): Promise<void> {
    setDialog({ kind: 'open', shift, submitting: true, refusal: null });

    const res = await operator.forceCloseShift({
      event_id: crypto.randomUUID(),
      shift_id: shift.shift_id,
      reason: payload.forced_close_reason,
      ...(payload.annotation !== undefined ? { annotation: payload.annotation } : {}),
    });

    if (res.kind === 'forced_closed') {
      closeDialog(shift.shift_id);
      setSurface((prev) => {
        if (prev.kind !== 'list') return prev;
        const remaining = prev.shifts.filter((s) => s.shift_id !== shift.shift_id);
        return remaining.length === 0 ? { kind: 'empty' } : { kind: 'list', shifts: remaining };
      });
    } else if (res.category === 'state_invalid') {
      setDialog({ kind: 'open', shift, submitting: false, refusal: 'changed' });
      void fetchShifts();
    } else {
      setDialog({ kind: 'open', shift, submitting: false, refusal: 'failed' });
    }
  }

  return (
    <StuckShiftsPage>
      {surface.kind === 'loading' && <StuckShiftsLoading />}

      {surface.kind === 'empty' && <StuckShiftsEmpty focus={focus} />}

      {surface.kind === 'error' && (
        <StuckShiftsUnreachable
          onRetry={() => {
            void fetchShifts();
          }}
        />
      )}

      {surface.kind === 'reauth' && (
        <StuckShiftsState>
          <ReauthRequiredNotice
            onSignIn={() => {
              setSurface({ kind: 'reauth', dialogOpen: true });
            }}
          />
        </StuckShiftsState>
      )}

      {surface.kind === 'reauthFailed' && (
        <StuckShiftsState>
          <p data-testid="stuck-shift-surface-reauth-failed" role="alert" dir="rtl" lang="ar">
            {surface.message}
          </p>
        </StuckShiftsState>
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
        <StuckShiftList
          shifts={surface.shifts}
          focus={focus}
          onClose={(shift) => {
            setDialog({ kind: 'open', shift, submitting: false, refusal: null });
          }}
        />
      )}

      {dialog.kind === 'open' && (
        <ForcedCloseDialog
          name={displayNameOf(dialog.shift.cashier_display_name)}
          submitting={dialog.submitting}
          refusal={dialog.refusal}
          onSubmit={(payload) => {
            void handleSubmit(dialog.shift, payload);
          }}
          onCancel={() => {
            closeDialog(dialog.shift.shift_id);
          }}
        />
      )}
    </StuckShiftsPage>
  );
}
