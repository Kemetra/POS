/**
 * T281 — `<ForceFailSurface>` (Wave 5b-renderer).
 *
 * Manager / admin incident-response surface for force-failing a stuck
 * `started` PaymentAttempt (FR-021 / plan AD-5). Mounted under a
 * manager-only route in `src/renderer/router.tsx`. The route guard is
 * **secondary UX defence only** — the load-bearing role check lives in
 * the main-process bridge handler (`payments-force-fail.ts`). A
 * hostile renderer (e.g., devtools manipulation) bypassing the guard
 * would still be refused at the bridge with `role_denied`.
 *
 * SECURITY (FR-021 last clause):
 *   The manager's identity MUST NEVER be displayed in cashier-visible
 *   UI. This surface IS the manager's view, so displaying the
 *   manager's name here is fine — but no part of the response from
 *   `payments.forceFail` carries the cashier's identity into a
 *   cashier-facing context. The `payments.read` projection (Slice 3c
 *   `projection.ts`) is the FR-017 stripper that prevents
 *   `force_fail_attribution_operator_id` from crossing back to a
 *   cashier surface.
 *
 * FR-017:
 *   No voucher tokens, card data, PII, or operator identity (other
 *   than the signed-in manager's own display name) are rendered.
 *
 * MINIMUM-VIABLE SCOPE (Wave 5b-renderer):
 *   The surface takes a `payment_attempt_id` prop (the caller — a
 *   future "list of stuck attempts" view — supplies the id). The
 *   spec mentions reading a stuck-attempt list via `payments.read`,
 *   but `payments.read` is a single-attempt read; a `payments.listStuck`
 *   bridge method does not yet exist. Recorded as a wave finding for
 *   a future PR.
 */

import { useCallback, useState, type JSX } from 'react';

import type { PaymentsBridgeAPI, PaymentsForceFailResponse } from '../../../shared/bridge-api.js';

export interface ForceFailSurfaceProps {
  /** The payment attempt to force-fail. Supplied by the caller. */
  payment_attempt_id: string;
  /**
   * Caller-supplied idempotency key. The renderer generates this at
   * the moment of intent (per Slice 3 idempotency contract); the
   * bridge handler refuses identical-key retries with the prior
   * outcome via the §P5 replay path.
   */
  idempotency_key: string;
  /** Bridge ref (injected; production wires `window.api.payments`). */
  payments: Pick<PaymentsBridgeAPI, 'forceFail'>;
  /**
   * Called after a successful force-fail. The caller (future
   * list-of-stuck-attempts view) is responsible for re-fetching or
   * navigating away.
   */
  onForceFailed?: (response: { force_failed_at: string }) => void;
}

type SurfaceState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; force_failed_at: string }
  | { kind: 'refused' };

/**
 * Generic refusal copy. Closed enum reasons (no_session, role_denied,
 * attempt_terminal, tenant_isolation, idempotency_payload_mismatch,
 * internal_error) all map to the same renderer string — the cashier-
 * facing UX is non-disclosing per FR-022 / NFR-003 / PR-2 (004
 * inherited). The structured `reason` stays on the audit row + the
 * debug logger.
 */
const GENERIC_REFUSAL_COPY = 'This payment attempt could not be force-failed right now.';

export function ForceFailSurface({
  payment_attempt_id,
  idempotency_key,
  payments,
  onForceFailed,
}: Readonly<ForceFailSurfaceProps>): JSX.Element {
  const [state, setState] = useState<SurfaceState>({ kind: 'idle' });

  const handleClick = useCallback(() => {
    void (async (): Promise<void> => {
      setState({ kind: 'submitting' });
      try {
        const response: PaymentsForceFailResponse = await payments.forceFail({
          payment_attempt_id,
          idempotency_key,
        });
        if (response.kind === 'ok') {
          setState({ kind: 'success', force_failed_at: response.force_failed_at });
          onForceFailed?.({ force_failed_at: response.force_failed_at });
          return;
        }
        setState({ kind: 'refused' });
      } catch {
        // CR-1 (PR #224): a rejected bridge call (IPC error, main-process
        // crash, timeout) must NOT leave the surface stuck in
        // `submitting`. Collapse to the same generic refusal copy — the
        // structured error stays on the renderer-process logger
        // upstream of this layer. No factor-distinguishing leak to the
        // operator (FR-022 / NFR-003 / PR-2 inherited).
        setState({ kind: 'refused' });
      }
    })();
  }, [payments, payment_attempt_id, idempotency_key, onForceFailed]);

  return (
    <div data-testid="force-fail-surface">
      <div data-testid="ffs-attempt-id">{payment_attempt_id}</div>
      <button
        type="button"
        data-testid="ffs-confirm"
        disabled={state.kind === 'submitting' || state.kind === 'success'}
        onClick={handleClick}
      >
        Force-fail this attempt
      </button>
      {state.kind === 'submitting' && (
        <div data-testid="ffs-submitting" aria-busy="true">
          Force-failing…
        </div>
      )}
      {state.kind === 'success' && (
        <div data-testid="ffs-success">Attempt force-failed at {state.force_failed_at}.</div>
      )}
      {state.kind === 'refused' && (
        <div data-testid="ffs-refused" role="alert">
          {GENERIC_REFUSAL_COPY}
        </div>
      )}
    </div>
  );
}
