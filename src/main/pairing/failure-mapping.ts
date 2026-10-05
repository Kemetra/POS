import type { PairingOutcome } from '../../shared/pairing-types.js';

/**
 * 002-terminal-pairing T020 + T037 + T047 + T055 — pure mapping from a
 * non-2xx HTTP envelope to a `PairingOutcome` category.
 *
 * US2 (T020) shipped:
 *   - the success-path guard ("called with 2xx is a programmer error"),
 *   - a defensive default of `'unknown_error'` for any non-2xx whose
 *     body code is not yet recognised.
 *
 * US3 (T037) added the recoverable-failure branches documented in
 * `contracts/pairing-http.md`:
 *   - INVALID_CODE   -> 'invalid_code'
 *   - EXPIRED_CODE   -> 'expired_code'
 *   - ALREADY_PAIRED -> 'already_paired'
 *
 * US4 (T047) added:
 *   - BRANCH_MISMATCH -> 'branch_mismatch'
 *
 * US5 (T055) adds:
 *   - RATE_LIMITED   -> 'rate_limited'
 *
 * `retry_after_s` (US5) is NOT touched by this function — it lives on
 * the surrounding `PairResult` envelope, parsed by `network.ts` (only
 * when status === 429). `mapFailure` is a pure status+body→outcome
 * function; the field flows around it via the envelope.
 *
 * RT-228 — wire shape: Backend-Core returns pairing failures in the
 * canonical envelope `{ "error": { "code", "message", "request_id"? } }`
 * (`pos-terminal-pairing.openapi.yaml` `components.schemas.Error`, pinned
 * under `contracts/backend-core/`). The discriminator is therefore
 * `body.error.code`. The legacy flat top-level `{ code, message }` shape was
 * only ever documented by the superseded hand-authored fallback snapshot
 * (`/api/v1/terminals/pair`, which the deployed server does not serve); the
 * pinned contract does not document it, so it is deliberately NOT read —
 * a flat body maps to 'unknown_error'.
 *
 * Discriminator policy: the function reads `body.error.code` only. HTTP
 * status is NOT the routing key — `409` is shared between `ALREADY_PAIRED`
 * (US3) and `BRANCH_MISMATCH` (US4), so a status-based switch would
 * conflate them. Routing on the code keeps the two branches distinct.
 * `validation_failure` (400) is documented but has no dedicated outcome and
 * maps to 'unknown_error' like any other unrecognised code.
 *
 * The function is pure: same input -> same output, no side effects, no
 * I/O. That makes it trivial to test exhaustively per case.
 *
 * Security: this function never receives the `pairing_code` and does not
 * log. The body argument is structurally typed and only `error.code` is
 * read.
 */

/**
 * Body shape `mapFailure` reads. Modelled loosely so we can accept arbitrary
 * shapes without throwing — the contract calls for the canonical
 * `{ error: { code, message, request_id? } }` envelope, but a non-2xx body can
 * be anything (or `{}` when it was not JSON), so every level is `unknown` and
 * narrowed at the read site.
 */
export interface FailureBody {
  error?: unknown;
  // Other backend-supplied fields are tolerated but ignored.
  [key: string]: unknown;
}

/**
 * Read `body.error.code` if (and only if) it is an OWN string property of an
 * object-valued `error`. Anything else — missing, null, array, wrong type,
 * inherited — yields `undefined`.
 */
function readErrorCode(body: FailureBody): string | undefined {
  const err = body.error;
  if (typeof err !== 'object' || err === null || Array.isArray(err)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(err, 'code')) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Translate a non-2xx HTTP response (status + parsed body) into a
 * PairingOutcome category. Throws ONLY when called with a 2xx status —
 * that is a programmer error (the service has the success branch and
 * MUST NOT route 2xx through here).
 *
 * @param status — HTTP status code from the response. MUST be non-2xx.
 * @param body   — Parsed JSON body. May be any shape; we read
 *                 `error.code` defensively.
 */
export function mapFailure(status: number, body: FailureBody): PairingOutcome {
  if (status >= 200 && status < 300) {
    throw new Error(
      'mapFailure called with success status (2xx) — programmer error. ' +
        'The service must route 2xx responses down the success path.',
    );
  }

  // Body-code switch (NOT a status switch). US3 landed the three
  // recoverable-failure branches; US4 added BRANCH_MISMATCH; US5
  // adds RATE_LIMITED. The catch-all 'unknown_error' covers every
  // unrecognised body code (incl. `validation_failure`) and every
  // malformed / non-envelope body.
  switch (readErrorCode(body)) {
    case 'INVALID_CODE':
      return 'invalid_code';
    case 'EXPIRED_CODE':
      return 'expired_code';
    case 'ALREADY_PAIRED':
      return 'already_paired';
    case 'BRANCH_MISMATCH':
      return 'branch_mismatch';
    case 'RATE_LIMITED':
      return 'rate_limited';
    default:
      return 'unknown_error';
  }
}
