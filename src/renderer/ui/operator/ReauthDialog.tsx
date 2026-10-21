import { useId, useRef, useState, type JSX, type SyntheticEvent } from 'react';

import type { OperatorBridgeAPI, ReauthenticateResponse } from '../../../shared/bridge-api.js';
import type { RefusalCategory } from '../../../shared/audit/event-shape.js';
import { useOperatorSessionStore } from '../../stores/operator-session-store.js';
import { Dialog, DialogHost, useHasDialogHost } from '../../v5/foundation/Dialog.js';
import { EMPTY_INPUT_MESSAGE, REAUTH_COPY, SIGN_IN_REFUSAL_COPY } from './messages.js';
import '../../v5/sale/live-sale.css';
import '../../v5/shift/shift.css';

/**
 * RT-358 (RT-247 plan §2.5, owner decision Q4 = dialog) — the in-place manager
 * re-auth after an action was refused `reauth_required`.
 *
 * `ReauthRequiredNotice` is the inline warning on the surface where the action
 * failed: the owner-approved copy and ONE action, «تسجيل الدخول». No generic
 * retry, no English fallback, never the raw category (UX-12). RT-652: its
 * button is the V5 shift primary (`v5-shift-btn`, 44px on its own), not the
 * retired 007 `.btn`.
 *
 * `ReauthDialog` opens on the same surface, so the manager keeps their place
 * and what they typed. It renders through the one v5 Dialog (UX-11): focus on
 * the identifier, Esc cancels (not while a request is in flight), Tab stays
 * inside, focus returns to the invoker. The manager's name is shown read-only;
 * a refusal uses the sign-in refusal copy and clears the password. The
 * credentials go to main only (`operator.reauthenticate`); the fresh JWT never
 * reaches the renderer.
 */

export function ReauthRequiredNotice({
  onSignIn,
}: Readonly<{ onSignIn: () => void }>): JSX.Element {
  return (
    <div data-testid="reauth-required" role="alert" dir="rtl" lang="ar">
      <p>{SIGN_IN_REFUSAL_COPY.reauth_required}</p>
      <button
        type="button"
        className="v5-shift-btn v5-shift-btn--primary v5-btn v5-btn--primary"
        onClick={onSignIn}
      >
        {REAUTH_COPY.action}
      </button>
    </div>
  );
}

export interface ReauthDialogProps {
  operator: Pick<OperatorBridgeAPI, 'reauthenticate'>;
  onReauthenticated: () => void;
  onCancel: () => void;
}

type Feedback =
  | { kind: 'none' }
  | { kind: 'empty' }
  | { kind: 'refused'; category: RefusalCategory };

const NOT_SIGNED_IN: ReauthenticateResponse = { kind: 'refused', category: 'not_signed_in' };

function send(
  operator: ReauthDialogProps['operator'],
  identifier: string,
  password: string,
): Promise<ReauthenticateResponse> {
  if (operator.reauthenticate === undefined) return Promise.resolve(NOT_SIGNED_IN);
  return operator.reauthenticate({ identifier, password }).catch(() => NOT_SIGNED_IN);
}

export function ReauthDialog({
  operator,
  onReauthenticated,
  onCancel,
}: ReauthDialogProps): JSX.Element {
  const identifierId = useId();
  const passwordId = useId();
  const identifierRef = useRef<HTMLInputElement>(null);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'none' });
  const hasHost = useHasDialogHost();
  const displayName = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session.display_name : null,
  );

  const submit = async (): Promise<void> => {
    const trimmed = identifier.trim();
    if (trimmed.length === 0 || password.length === 0) {
      setFeedback({ kind: 'empty' });
      return;
    }
    setSubmitting(true);
    setFeedback({ kind: 'none' });
    const answer = await send(operator, trimmed, password);
    setPassword('');
    setSubmitting(false);
    if (answer.kind === 'reauthenticated') onReauthenticated();
    else setFeedback({ kind: 'refused', category: answer.category });
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!submitting) void submit();
  };

  // Its own DialogHost only where none exists: a render outside the v5 frame
  // (RT-504: no production route is outside it; standalone renders and unit
  // tests) would otherwise portal to document.body, outside the lock's inert,
  // concealed subtree — the dialog would float over the lock screen.
  // Inside the v5 frame (RT-424 Cashiers) it uses the frame's host, so the
  // backdrop covers the nav too.
  const dialog = (
    <Dialog
      label={REAUTH_COPY.title}
      {...(submitting ? {} : { onCancel })}
      initialFocusRef={identifierRef}
    >
      <h2 className="v5-live-dialog-title">{REAUTH_COPY.title}</h2>
      <form onSubmit={handleSubmit} noValidate>
        {displayName !== null && (
          <p data-testid="reauth-manager-name">
            {REAUTH_COPY.managerLabel}: <bdi>{displayName}</bdi>
          </p>
        )}
        <div className="v5-shift-fields">
          <label htmlFor={identifierId}>{REAUTH_COPY.identifierLabel}</label>
          <input
            id={identifierId}
            ref={identifierRef}
            className="v5-shift-input v5-ltr"
            type="text"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={submitting}
            value={identifier}
            onChange={(e) => {
              setIdentifier(e.target.value);
            }}
            data-testid="reauth-identifier"
          />
          <label htmlFor={passwordId}>{REAUTH_COPY.passwordLabel}</label>
          <input
            id={passwordId}
            className="v5-shift-input v5-ltr"
            type="password"
            autoComplete="current-password"
            disabled={submitting}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            data-testid="reauth-password"
          />
        </div>
        <ReauthFeedback submitting={submitting} feedback={feedback} />
        <div>
          <button
            type="button"
            className="v5-live-btn v5-btn"
            disabled={submitting}
            onClick={onCancel}
          >
            {REAUTH_COPY.cancel}
          </button>
          <button
            type="submit"
            className="v5-live-btn v5-live-btn--primary v5-btn v5-btn--primary"
            disabled={submitting}
          >
            {REAUTH_COPY.submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
  return hasHost ? dialog : <DialogHost>{dialog}</DialogHost>;
}

function ReauthFeedback({
  submitting,
  feedback,
}: Readonly<{
  submitting: boolean;
  feedback: Feedback;
}>): JSX.Element {
  return (
    <div role="status" aria-live="polite">
      {submitting && <span>{REAUTH_COPY.submitting}</span>}
      {!submitting && feedback.kind === 'refused' && (
        <span role="alert" data-testid="reauth-refusal">
          {SIGN_IN_REFUSAL_COPY[feedback.category]}
        </span>
      )}
      {!submitting && feedback.kind === 'empty' && (
        <span role="alert" data-testid="reauth-empty">
          {EMPTY_INPUT_MESSAGE}
        </span>
      )}
    </div>
  );
}
