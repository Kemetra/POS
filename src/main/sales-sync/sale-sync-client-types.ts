/**
 * 011-sale-sync-capture-up T025 — `SaleSyncClient` DI seam.
 *
 * The engine depends ONLY on this interface. The concrete HTTP client
 * (`createSaleSyncClient`, T061) is BLOCKED on the backend deploy (#349); until
 * then the engine is driven against `createFakeSaleSyncClient`. When the live
 * client lands it implements this interface unchanged and the engine is unaffected.
 *
 * The fetch outcome is a typed union mirroring the HTTP responses the engine
 * acts on (contracts/README.md): `ok` (200/201), `duplicate` (409 — idempotent
 * success), `transient` (5xx / timeout — retry), `permanent` (4xx — dead-letter),
 * `no_connection` (offline / DNS / refused). `postSale` NEVER rejects — transport
 * faults are mapped to the union. The raw response body is NEVER surfaced (P7);
 * the operator token is attached main-process-side and never passed through here.
 *
 * RT-15 S1: `ok` carries the Backend-Core `saleRef` (the stable server reference,
 * a UUID) read from the 200/201 `Sale` body — the ONE field taken from the body.
 * It is `null` when the body is missing, unparseable, or has no valid UUID
 * `saleRef`; the sale is still captured server-side, so the outcome stays `ok`.
 * `duplicate` (409) carries none: Backend-Core's capture 409 is an `Error`
 * envelope (`idempotency_key_conflict`) with no `Sale` projection.
 */

import type { CaptureSalePayload } from './capture-payload.js';

export type SaleSyncResult =
  | { kind: 'ok'; saleRef: string | null }
  | { kind: 'duplicate' }
  | { kind: 'transient' }
  | { kind: 'permanent' }
  | { kind: 'no_connection' };

export interface SaleSyncClient {
  /** POST a sale to DP2 captureSale. Resolves to a typed outcome; never rejects. */
  postSale(payload: CaptureSalePayload): Promise<SaleSyncResult>;
}

/** A test fake: yields scripted results in order, then repeats the last; records calls. */
export interface FakeSaleSyncClient extends SaleSyncClient {
  readonly calls: CaptureSalePayload[];
}

export function createFakeSaleSyncClient(
  script: SaleSyncResult[] = [{ kind: 'ok', saleRef: null }],
): FakeSaleSyncClient {
  const calls: CaptureSalePayload[] = [];
  const queue = [...script];
  let last: SaleSyncResult = script[script.length - 1] ?? { kind: 'ok', saleRef: null };
  return {
    calls,
    postSale(payload: CaptureSalePayload): Promise<SaleSyncResult> {
      calls.push(payload);
      const next = queue.shift();
      if (next !== undefined) {
        last = next;
        return Promise.resolve(next);
      }
      return Promise.resolve(last);
    },
  };
}
