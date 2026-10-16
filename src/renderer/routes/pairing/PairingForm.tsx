import { useEffect, useRef, useState, type SyntheticEvent, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { messageFor, EMPTY_INPUT_MESSAGE } from './messages';
import { PAIRING_COPY } from '../../v5/entry/entry-copy';
import { RefusalNotice } from '../../v5/entry/RefusalNotice';
import type { PairingBridgeAPI, PreloadBridgeAPI } from '../../../shared/bridge-api';

/**
 * 002-terminal-pairing T029 + T034 + T043 + T045 + T057 — `PairingForm`.
 *
 * Single-input form that drives the pairing submit flow. Accepts both
 * manual entry (operator types code + Enter or click) and wedge-scanner
 * input (keystrokes followed by Enter, treated as a regular keyboard;
 * research §6).
 *
 * Critical implementation choices:
 *
 *   1. The current input value is read via a `ref`, not via `useState`.
 *      `userEvent.keyboard('CODE{Enter}')` and a real wedge scanner
 *      both fire keys synchronously; React 19's batched state updates
 *      mean a stale `useState` read can produce an empty submit. The
 *      ref always reflects the live DOM value.
 *
 *   2. `useState` holds three pieces of state:
 *      - `submitting` — gates re-entry (a second Enter while the first
 *        call is still pending is dropped) and disables the submit
 *        button.
 *      - `statusMessage` — the operator-facing message rendered in the
 *        always-mounted `role="status"` slot (RT-244). `null` when the
 *        form is idle, so the slot is empty; the empty-input
 *        validation copy on a no-content submit (T045); the outcome's
 *        message family on a non-success result (T043), or the
 *        generic copy when the submit throws.
 *      - `disabledUntil` (T057, US5) — epoch-ms timestamp when the
 *        rate-limit window expires. `null` means "no rate limit
 *        active". A `useEffect` schedules a single `setTimeout` to
 *        flip the value back to `null`. The submit BUTTON is gated by
 *        this state; the input is NOT (operators may correct a typo
 *        while waiting).
 *
 *   3. On `outcome === 'success'` the form calls
 *      `navigate('/paired', { replace: true })`. PairedScreen calls
 *      `getStatus()` itself on mount, so the navigation lands on a
 *      route that fetches its own data — we are not coupling the form
 *      to the boot router's state.
 *
 *   4. Per-outcome copy lives in `./messages.ts`. US3+US4+US5 own
 *      five recoverable-failure outcomes; the generic fallback in
 *      `messageFor()` covers `network_error` / `unknown_error` until
 *      T074 lands per-category copy.
 *
 *   5. Rate-limit timer (T057): plain `useState + useEffect` rather
 *      than Zustand. The state lives entirely inside `PairingForm`
 *      and there is no cross-component sharing requirement; pulling
 *      in Zustand for one number would be inconsistent with the
 *      ref+useState architecture established in US2/US3/US4.
 *
 * Security policy (Constitution VII + spec NFR-4 / FR-9 / FR-10):
 *   - The `pairing_code` lives in the input element's value (controlled
 *     uncontrolled hybrid: ref-driven, but the input IS what holds it).
 *     It is never written to a logger, never interpolated into the
 *     status message, never echoed to any text node outside the input.
 *   - On success the form navigates away; the input unmounts and React
 *     drops the value.
 *   - The bridge's submit return type omits `device_token` by
 *     construction (PR #15 / PR #17), so even if the form rendered
 *     `result` it could not leak the token. The status message comes
 *     from a fixed string table in `./messages.ts` — there is no place
 *     to interpolate a secret.
 *   - The `retry_after_s` value flowed from the bridge is a public
 *     timer integer; it is NOT logged from the renderer (the main
 *     process already logged it via `pairingLog` in `service.ts`).
 */

export interface PairingFormProps {
  /**
   * Bridge to the main process. Tests inject a fake; production reads
   * from `window.api.pairing`.
   */
  pairing?: PairingBridgeAPI;
  /** The card heading that names the form; without it the form names itself. */
  labelledBy?: string;
  /** The card hint, announced with the field. */
  hintId?: string;
}

const STATUS_ID = 'pairing-status';

export function PairingForm(props: Readonly<PairingFormProps>): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [disabledUntil, setDisabledUntil] = useState<number | null>(null);
  // Set while a submit that has not navigated away is in flight: the field was
  // disabled while it ran, which drops focus to <body>, so it takes focus back
  // once re-enabled and a scanner operator can scan the next code (RT-244 PR2).
  const refocusAfterSubmit = useRef(false);
  const navigate = useNavigate();

  const pairing = props.pairing ?? readBridge();

  // T057 — rate-limit timer. Schedule a single setTimeout that flips
  // disabledUntil back to null when the window elapses. The cleanup
  // clears the timeout on unmount or when disabledUntil changes (e.g.,
  // a fresh rate_limited outcome with a new window arrives), so we
  // never leak timers and never have two pending timers at once.
  useEffect(() => {
    if (disabledUntil === null) return;
    const remainingMs = Math.max(0, disabledUntil - Date.now());
    const timer = setTimeout(() => {
      setDisabledUntil(null);
    }, remainingMs);
    return () => {
      clearTimeout(timer);
    };
  }, [disabledUntil]);

  useEffect(() => {
    if (submitting || !refocusAfterSubmit.current) return;
    refocusAfterSubmit.current = false;
    // Only reclaim focus the disabled field lost; never pull it away from a
    // control the operator moved to while the submit ran.
    const active = document.activeElement;
    if (active === null || active === document.body) inputRef.current?.focus();
  }, [submitting]);

  // Compute fresh on every render. `disabledUntil` is the epoch-ms
  // expiry; `Date.now() < disabledUntil` is the active window. The
  // useEffect above guarantees the value flips to null when the window
  // closes, so this predicate stays in sync with the rendered button.
  const isRateLimited = disabledUntil !== null && Date.now() < disabledUntil;

  async function performSubmit(): Promise<void> {
    if (submitting) return;
    if (isRateLimited) return;
    const code = inputRef.current?.value.trim() ?? '';
    if (code.length === 0) {
      // T045: visible client-side validation. Replaces the silent
      // no-op the form had in US2. No bridge call; the operator sees
      // why nothing happened.
      setStatusMessage(EMPTY_INPUT_MESSAGE);
      return;
    }

    setSubmitting(true);
    // Clear any prior message so a stale failure copy does not visually
    // stack with the in-flight state.
    setStatusMessage(null);
    // Set before the await so a thrown submit refocuses too; only success,
    // which navigates away, clears it.
    refocusAfterSubmit.current = true;
    try {
      const result = await pairing.submit(code);
      if (result.outcome === 'success') {
        refocusAfterSubmit.current = false;
        void navigate('/paired', { replace: true });
        return;
      }
      if (result.outcome === 'rate_limited') {
        // T057 — start the disabled-window. The retry_after_s value
        // is the authoritative wait time (already parsed and clamped
        // by network.ts; service trusts the envelope verbatim). We
        // convert to an epoch-ms expiry so the useEffect's setTimeout
        // can compute the remaining ms even if the component re-renders
        // mid-window.
        setDisabledUntil(Date.now() + result.retry_after_s * 1000);
        setStatusMessage(messageFor('rate_limited'));
        return;
      }
      // Other non-success outcomes (US3 invalid_code / expired_code /
      // already_paired; US4 branch_mismatch; T074 network_error /
      // unknown_error). The form re-enables and stays editable so the
      // operator can retry.
      setStatusMessage(messageFor(result.outcome));
    } catch {
      // The bridge maps every failure to an outcome; a rejection means the
      // main handler threw (IPC). Show the generic copy so the operator can
      // retry, and never echo the thrown value (Constitution VII).
      setStatusMessage(messageFor('unknown_error'));
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    void performSubmit();
  }

  const formName =
    props.labelledBy !== undefined
      ? { 'aria-labelledby': props.labelledBy }
      : { 'aria-label': PAIRING_COPY.title };
  const describedBy = [props.hintId, STATUS_ID].filter((id) => id !== undefined).join(' ');

  // RT-244 PR2 (G-1 «Pairing»): one free-text code field (mono, LTR; the code
  // length is server-defined, so it is not segmented), a status slot that stays
  // mounted so the live region is in place before the first message, and the
  // full-width commit.
  return (
    <form className="v5-entry__card-form" onSubmit={onSubmit} noValidate {...formName}>
      <div className="v5-entry__field">
        <label htmlFor="pairing-code">{PAIRING_COPY.field}</label>
        <input
          id="pairing-code"
          className="v5-entry__input v5-entry__code-input"
          ref={inputRef}
          dir="ltr"
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          aria-describedby={describedBy}
          // T057: input is gated by `submitting` only. While rate-limited,
          // the operator may correct a typo so they're ready to retry the
          // moment the timer expires. Only the submit BUTTON gates on
          // isRateLimited.
          disabled={submitting}
        />
      </div>
      <output className="v5-entry__slot" id={STATUS_ID}>
        {statusMessage !== null ? (
          <RefusalNotice testId="pairing-message">{statusMessage}</RefusalNotice>
        ) : null}
      </output>
      <button
        type="submit"
        className="v5-entry__btn v5-entry__btn--primary v5-entry__commit"
        disabled={submitting || isRateLimited}
      >
        {submitting ? PAIRING_COPY.submitting : PAIRING_COPY.submit}
      </button>
    </form>
  );
}

/**
 * Read `window.api.pairing` defensively. The bridge is exposed by the
 * preload script before the renderer mounts, so this read is safe in
 * production. In test environments without a bridge, callers MUST pass
 * the `pairing` prop — we throw a clear error rather than coerce.
 */
function readBridge(): PairingBridgeAPI {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api) {
    throw new Error('PairingForm: window.api missing — preload bridge not initialised.');
  }
  return api.pairing;
}
