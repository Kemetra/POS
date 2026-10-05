/**
 * 011-sale-sync-capture-up T025 — `SaleSyncClient` DI seam.
 *
 * The engine depends ONLY on this interface. The concrete HTTP client
 * (`createSaleSyncClient`, T061) is BLOCKED on the backend deploy (#349); until
 * then the engine is driven against `createFakeSaleSyncClient`. When the live
 * client lands it implements this interface unchanged and the engine is unaffected.
 *
 * The fetch outcome is a typed union mirroring the HTTP responses the engine
 * acts on (contracts/README.md): `ok` (200/201), `divergent` (409 — terminal
 * payload divergence, RT-190), `transient` (5xx / timeout — retry), `permanent`
 * (4xx — dead-letter), `no_connection` (offline / DNS / refused). `postSale` NEVER rejects — transport
 * faults are mapped to the union. The raw response body is NEVER surfaced (P7);
 * the operator token is attached main-process-side and never passed through here.
 *
 * RT-15 S1: `ok` carries the Backend-Core `saleRef` (the stable server reference,
 * a UUID) read from the 200/201 `Sale` body — the ONE field taken from the body.
 * It is `null` when the body is missing, unparseable, or has no valid UUID
 * `saleRef`; the sale is still captured server-side, so the outcome stays `ok`.
 *
 * RT-190: `divergent` (409) is NOT success. Backend-Core answers a capture 409
 * only as `idempotency_key_conflict`: the Idempotency-Key or the
 * `(tenant, sourceSystem, externalId)` provenance was already used for a
 * DIFFERENT logical payload (e.g. different tenders). Benign replays are 201
 * (`Idempotent-Replayed`) or 200, never 409. So a 409 means the server holds a
 * different sale than the till recorded; the engine dead-letters it with the
 * `payload_divergence` reason and never retries it. `errorCode` is a closed set:
 * the contract's code, or `unrecognized` for a malformed body or any other code
 * (fail closed — the 409 status alone makes it divergent). No server text is
 * ever echoed (P7).
 *
 * RT-194: `transient` may carry `retryAfterMs` — the server's `Retry-After`
 * (425 `idempotency_in_progress` or 429 rate limit), already parsed and clamped.
 * The engine waits at least that long before the next attempt for the sale, and
 * uses its normal backoff when the field is absent. A 425 is never `permanent`:
 * the same Idempotency-Key is still being processed, so the retry replays the
 * eventual 201/200 instead of losing the sale.
 *
 * RT-224 step 2 (Option B, Backend-Core #709): `postSaleAsCashier` sends the sale
 * with the DEVICE bearer and the sale's own cashier `operatorUserId` (the
 * `users.id` captured at confirm time), never the envelope. Two outcomes exist
 * only on that path:
 *   • `refused` (403 `refused`) — the device is authenticated but the server
 *     refused this sale's cashier claim (no covering admission window, a capped
 *     date, an ineligible cashier). A per-sale terminal outcome: never a device
 *     revocation, never a pause of the queue.
 *   • `device_unauthorized` (401) — the device credential itself was not
 *     accepted. The sale stays queued; revocation is decided elsewhere (RT-215).
 */

import type { CaptureSalePayload } from './capture-payload.js';

/** RT-190: the closed-set label of a capture 409 (never the server's raw text). */
export type CaptureConflictCode = 'idempotency_key_conflict' | 'unrecognized';

export type SaleSyncResult =
  | { kind: 'ok'; saleRef: string | null }
  | { kind: 'divergent'; errorCode: CaptureConflictCode }
  | { kind: 'transient'; retryAfterMs?: number }
  | { kind: 'permanent' }
  | { kind: 'no_connection' }
  | { kind: 'refused' }
  | { kind: 'device_unauthorized' };

export interface SaleSyncClient {
  /**
   * POST a sale to DP2 captureSale with the operator ENVELOPE
   * (`operatorAuthorization`); the body never carries `operatorUserId`.
   * Resolves to a typed outcome; never rejects.
   */
  postSale(payload: CaptureSalePayload): Promise<SaleSyncResult>;
  /**
   * RT-224 step 2: POST a sale with the DEVICE bearer plus `operatorUserId` — the
   * `users.id` of the cashier who made THIS sale. Resolves; never rejects.
   */
  postSaleAsCashier(payload: CaptureSalePayload, operatorUserId: string): Promise<SaleSyncResult>;
}

/** One recorded device-path call of the fake. */
export interface FakeCashierCall {
  payload: CaptureSalePayload;
  operatorUserId: string;
}

/**
 * A test fake: yields scripted results in order (both methods share one
 * script), then repeats the last; records envelope calls in `calls` and
 * device-path calls in `cashierCalls`.
 */
export interface FakeSaleSyncClient extends SaleSyncClient {
  readonly calls: CaptureSalePayload[];
  readonly cashierCalls: FakeCashierCall[];
}

export function createFakeSaleSyncClient(
  script: SaleSyncResult[] = [{ kind: 'ok', saleRef: null }],
): FakeSaleSyncClient {
  const calls: CaptureSalePayload[] = [];
  const cashierCalls: FakeCashierCall[] = [];
  const queue = [...script];
  let last: SaleSyncResult = script[script.length - 1] ?? { kind: 'ok', saleRef: null };
  const nextResult = (): Promise<SaleSyncResult> => {
    const next = queue.shift();
    if (next !== undefined) last = next;
    return Promise.resolve(last);
  };
  return {
    calls,
    cashierCalls,
    postSale(payload: CaptureSalePayload): Promise<SaleSyncResult> {
      calls.push(payload);
      return nextResult();
    },
    postSaleAsCashier(payload: CaptureSalePayload, operatorUserId: string) {
      cashierCalls.push({ payload, operatorUserId });
      return nextResult();
    },
  };
}
