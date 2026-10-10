import { useRef, useEffect, useState, type JSX } from 'react';

import type { OperatorBridgeAPI } from '../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../stores/operator-session-store.js';
import { completeSignIn } from '../../session/complete-sign-in.js';
import { SIGN_IN_REFUSAL_COPY } from './messages.js';

/**
 * 004-operator-session T076 + T077 — TakeoverPrompt (Surface 5).
 *
 * Dialog-based modal rendered when the FSM is in `takeoverPrompt` state.
 * Shown when sign-in returns `takeover_required` — a session already
 * exists on another terminal.
 *
 * FR-013 minimum-disclosure invariant:
 *   MUST NOT identify the prior terminal, its operator, the role of
 *   that operator, or any timestamp. Tests assert forbidden strings are
 *   absent from the rendered DOM.
 *
 * Focus: initial focus on "Cancel" (non-destructive safety default).
 * This deviates from the visual-direction README — flagged in PR body.
 *
 * T077 response handling:
 *   - signed_in          → resolveSignedIn (FSM → signedIn)
 *   - refused/no_connection → inline retry error; proto-session retained,
 *                            stay in takeoverPrompt
 *   - refused/invalid_input → refuseSignIn (FSM → signedOut, alert)
 *   - cancel              → cancelTakeover (FSM → signedOut)
 */

export interface TakeoverPromptProps {
  operator: OperatorBridgeAPI;
  pending_takeover_id: string;
}

export function TakeoverPrompt({
  operator,
  pending_takeover_id,
}: TakeoverPromptProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [retryError, setRetryError] = useState<string | undefined>(undefined);

  // Focus Cancel on mount (safety default — FR-013 non-destructive).
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const handleConfirm = async (): Promise<void> => {
    if (confirming) return;
    setConfirming(true);
    setRetryError(undefined);
    try {
      const response = await operator.confirmTakeover({ pending_takeover_id });
      if (response.kind === 'signed_in') {
        // RT-352 — adopt the re-attached draft before routing on.
        await completeSignIn(operator, response.session);
        return;
      }
      // At this point response is OperatorRefusal (signed_in handled above).
      if (response.category === 'no_connection') {
        // Proto-session retained by the main process; stay in takeoverPrompt.
        setRetryError(SIGN_IN_REFUSAL_COPY.no_connection);
        return;
      }
      // Any other refusal (invalid_input) — drop to signedOut with alert.
      useOperatorSessionStore.getState().refuseSignIn(response.category);
    } catch {
      // IPC panic — generic refusal, drop to signedOut (PR-1: no message echo).
      useOperatorSessionStore.getState().refuseSignIn('invalid_input');
    } finally {
      setConfirming(false);
    }
  };

  const handleCancel = async (): Promise<void> => {
    await operator.cancelTakeover({ pending_takeover_id });
    useOperatorSessionStore.getState().cancelTakeover();
  };

  // Escape cancels the takeover (WCAG 2.1.1) — the non-destructive default,
  // matching the focus-Cancel-on-mount safety posture (FR-013). Mirrors the
  // Dialog primitive's keydown pattern; this prompt is hand-rolled.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        void handleCancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
    // handleCancel is stable for the prompt's lifetime (deps don't change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="takeover-prompt-title"
      data-testid="takeover-prompt"
      className="takeover-prompt"
    >
      <div className="takeover-prompt__content">
        <h2
          id="takeover-prompt-title"
          className="takeover-prompt__title"
          data-testid="takeover-prompt-title"
        >
          You are already signed in on another POS terminal in this branch.
        </h2>
        <p className="takeover-prompt__body" data-testid="takeover-prompt-body">
          Continue here and sign out there?
        </p>

        <div className="takeover-prompt__feedback" role="status" aria-live="polite">
          {confirming ? (
            <span className="takeover-prompt__spinner" data-testid="takeover-prompt-spinner">
              Signing in…
            </span>
          ) : retryError !== undefined ? (
            <span
              role="alert"
              className="takeover-prompt__error"
              data-testid="takeover-prompt-error"
              data-category="no_connection"
            >
              {retryError}
            </span>
          ) : null}
        </div>

        <div className="takeover-prompt__actions">
          <button
            ref={cancelRef}
            type="button"
            className="takeover-prompt__cancel"
            data-testid="takeover-prompt-cancel"
            disabled={confirming}
            onClick={() => {
              void handleCancel();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="takeover-prompt__confirm"
            data-testid="takeover-prompt-confirm"
            disabled={confirming}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {confirming ? 'Signing in…' : 'Continue here'}
          </button>
        </div>
      </div>
    </div>
  );
}
