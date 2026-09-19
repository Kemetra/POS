import { useId, useRef, useState, type SyntheticEvent, type JSX } from 'react';

import type { OperatorBridgeAPI } from '../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../stores/operator-session-store.js';
import { SIGN_IN_REFUSAL_COPY, EMPTY_INPUT_MESSAGE } from './messages.js';

/**
 * 004-operator-session T019 + T021 + T029 — Manager / admin sign-in
 * form (Surface 2).
 *
 * Drives the Wave 1 manager/admin sign-in flow. Reads identifier and
 * password values via refs (research §6 / matches the established
 * 002 PairingForm pattern: React 19 batched state + synchronous
 * keystrokes can produce a stale read otherwise).
 *
 * Note 1 (Slice 0 reviewer) acceptance: the inline alert dismisses on
 * the first new keystroke; the next submit's spinner replaces the
 * alert's space, NOT alongside it. We achieve that by:
 *
 *   - calling `clearRefusal()` on every input change while a refusal
 *     is currently shown;
 *   - rendering EITHER the alert OR the spinner OR neither — never
 *     both — based on the FSM state.
 *
 * Security policy (PR-1):
 *   - The `password` field is uncontrolled (ref-driven) and never
 *     stored in React state, never logged, never echoed to a status
 *     message, never interpolated into any string.
 *   - On bridge call resolution the form clears the password input
 *     value (defence in depth).
 *   - The bridge response IS NOT spread into the rendered status —
 *     only the closed-set RefusalCategory drives copy via a fixed
 *     string table.
 */

export interface ManagerAdminSignInFormProps {
  operator: OperatorBridgeAPI;
  onBack?: () => void;
}

export function ManagerAdminSignInForm(props: ManagerAdminSignInFormProps): JSX.Element {
  const { onBack } = props;
  const identifierId = useId();
  const passwordId = useId();
  const identifierRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const fsm = useOperatorSessionStore((s) => s.state);

  const [emptyInputShown, setEmptyInputShown] = useState(false);

  const isSubmitting = fsm.kind === 'signingIn';
  const refusalCategory = fsm.kind === 'signedOut' ? fsm.lastRefusal : undefined;

  const handleInput = (): void => {
    // Note 1: typing dismisses any existing inline alert.
    if (refusalCategory !== undefined) {
      useOperatorSessionStore.getState().clearRefusal();
    }
    if (emptyInputShown) {
      setEmptyInputShown(false);
    }
  };

  const runSignIn = async (identifier: string, password: string): Promise<void> => {
    useOperatorSessionStore.getState().beginSignIn();
    try {
      const response = await props.operator.signIn({
        kind: 'manager_admin',
        identifier,
        password,
      });
      // Defence in depth: clear the password input as soon as the
      // bridge resolves, regardless of outcome. The `!== null` arm is
      // unreachable in the mounted lifecycle (the form unmounts only
      // after sign-in resolves and the router redirects); the v8
      // ignore keeps coverage honest about what tests can exercise.
      /* v8 ignore next 2 */
      if (passwordRef.current !== null) {
        passwordRef.current.value = '';
      }
      if (response.kind === 'signed_in') {
        useOperatorSessionStore.getState().resolveSignedIn(response.session);
      } else if (response.kind === 'takeover_required') {
        useOperatorSessionStore.getState().promptTakeover(response.pending_takeover_id);
      } else {
        useOperatorSessionStore.getState().refuseSignIn(response.category);
      }
    } catch {
      // The bridge handler maps every failure into a typed result; a
      // thrown rejection here means main-process panic (e.g., IPC
      // channel missing). Fall back to a generic refusal — the
      // operator can retry. We deliberately do NOT echo the thrown
      // value (Constitution VII).
      /* v8 ignore next 2 */
      if (passwordRef.current !== null) {
        passwordRef.current.value = '';
      }
      useOperatorSessionStore.getState().refuseSignIn('invalid_input');
    }
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isSubmitting) return; // re-entry guard
    const identifier = identifierRef.current?.value ?? '';
    const password = passwordRef.current?.value ?? '';
    if (identifier.length === 0 || password.length === 0) {
      setEmptyInputShown(true);
      return;
    }
    void runSignIn(identifier, password);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="sign-in-form"
      data-testid="manager-admin-sign-in-form"
      noValidate
    >
      {onBack !== undefined && (
        <button
          type="button"
          className="sign-in-form__back"
          data-testid="sign-in-back"
          onClick={onBack}
        >
          ← العودة إلى قائمة الكاشير
        </button>
      )}
      <div className="sign-in-form__field">
        <label htmlFor={identifierId}>البريد الإلكتروني أو اسم المستخدم</label>
        <input
          id={identifierId}
          ref={identifierRef}
          type="text"
          autoComplete="username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={isSubmitting}
          onChange={handleInput}
          data-testid="sign-in-identifier"
        />
      </div>
      <div className="sign-in-form__field">
        <label htmlFor={passwordId}>كلمة المرور</label>
        <input
          id={passwordId}
          ref={passwordRef}
          type="password"
          autoComplete="current-password"
          disabled={isSubmitting}
          onChange={handleInput}
          data-testid="sign-in-password"
        />
      </div>

      <div className="sign-in-form__feedback" role="status" aria-live="polite">
        {isSubmitting ? (
          <span data-testid="sign-in-spinner">جارٍ تسجيل الدخول…</span>
        ) : refusalCategory !== undefined ? (
          <span
            role="alert"
            data-testid="sign-in-refusal"
            data-category={refusalCategory}
            className="sign-in-form__refusal"
          >
            {SIGN_IN_REFUSAL_COPY[refusalCategory]}
          </span>
        ) : emptyInputShown ? (
          <span
            role="alert"
            data-testid="sign-in-empty-input"
            className="sign-in-form__empty-input"
          >
            {EMPTY_INPUT_MESSAGE}
          </span>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        data-testid="sign-in-submit"
        className="sign-in-form__submit"
      >
        {isSubmitting ? 'جارٍ تسجيل الدخول…' : 'تسجيل الدخول'}
      </button>
    </form>
  );
}
