import { useState, useEffect, useCallback, type JSX } from 'react';

import type { RefusalCategory } from '../../../shared/audit/event-shape.js';
import { Notice } from '../../v5/foundation/Notice.js';

import type {
  OperatorBridgeAPI,
  StuckShiftSummary,
  ListStuckShiftsResponse,
} from '../../../shared/bridge-api.js';
import { ReauthDialog, ReauthRequiredNotice } from './ReauthDialog.js';
import { SIGN_IN_REFUSAL_COPY } from './messages.js';
import { STUCK_SHIFTS_COPY as COPY } from '../../v5/manager/stuck-shifts/stuck-shifts-copy.js';
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
}: Readonly<ForcedCloseSurfaceProps>): JSX.Element {
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

/**
 * Which dialog message each refusal shows; any other category is `failed`.
 */
const REFUSAL_OF_CATEGORY: Partial<Record<RefusalCategory, ForcedCloseRefusal>> = {
  state_invalid: 'changed',
  // RT-554: still open on the backend, and no re-read can change that.
  not_closable_here: 'notClosable',
  // RT-554 (b): parked sales or drawer cash in flight; the shift is still open.
  close_blocked: 'blocked',
  // RT-554 (b): closed on this terminal, not at the server yet.
  closed_here_unsent: 'unsent',
};

/** The list without `shiftId` (the empty state when it was the last one). */
function withoutShift(prev: SurfaceState, shiftId: string): SurfaceState {
  if (prev.kind !== 'list') return prev;
  const remaining = prev.shifts.filter((s) => s.shift_id !== shiftId);
  return remaining.length === 0 ? { kind: 'empty' } : { kind: 'list', shifts: remaining };
}

/**
 * The refusals that re-read the stuck list: `state_invalid` (the shift changed under
 * the manager) and `not_closable_here` (local absence cannot prove the backend shift
 * is still open: its opening terminal may have closed it since the list loaded).
 * Every other refusal leaves the shift exactly where it was (still open on this
 * terminal, or closed here and not at the server yet), so a re-read could only show it again.
 */
const REREADS_LIST: ReadonlySet<RefusalCategory> = new Set<RefusalCategory>([
  'state_invalid',
  'not_closable_here',
]);

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
export function StuckShiftSurface({ operator }: Readonly<StuckShiftSurfaceProps>): JSX.Element {
  const [surface, setSurface] = useState<SurfaceState>({ kind: 'loading' });
  const [dialog, setDialog] = useState<DialogState>({ kind: 'idle' });
  // RT-554 (b): a forced close recorded here but not yet at the server.
  const [queued, setQueued] = useState(false);
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

  /** The forced close succeeded: the dialog closes, the shift leaves the list. */
  function showClosed(input: { shiftId: string; delivery: 'sent' | 'queued' }): void {
    // Follows the latest outcome: the drain is causal, so a later `sent` means the queue is empty.
    setQueued(input.delivery === 'queued');
    closeDialog(input.shiftId);
    setSurface((prev) => withoutShift(prev, input.shiftId));
  }

  /** A refusal: its dialog message; `REREADS_LIST` refusals also re-read the list. */
  function showRefusal(input: { shift: StuckShiftSummary; category: RefusalCategory }): void {
    setDialog({
      kind: 'open',
      shift: input.shift,
      submitting: false,
      refusal: REFUSAL_OF_CATEGORY[input.category] ?? 'failed',
    });
    if (REREADS_LIST.has(input.category)) void fetchShifts();
  }

  async function handleSubmit(
    shift: StuckShiftSummary,
    payload: ForcedCloseFormSubmitPayload,
  ): Promise<void> {
    setDialog({ kind: 'open', shift, submitting: true, refusal: null });

    const res = await operator.forceCloseShift({
      event_id: crypto.randomUUID(),
      shift_id: shift.shift_id,
      reason: payload.forced_close_reason,
      counted_cash_minor: payload.counted_cash_minor,
      ...(payload.annotation !== undefined ? { annotation: payload.annotation } : {}),
    });

    if (res.kind === 'forced_closed') {
      showClosed({ shiftId: shift.shift_id, delivery: res.delivery });
    } else {
      showRefusal({ shift, category: res.category });
    }
  }

  return (
    <StuckShiftsPage>
      {queued && (
        <Notice tone="info" testId="stuck-shift-queued-notice">
          {COPY.queuedNotice}
        </Notice>
      )}

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
