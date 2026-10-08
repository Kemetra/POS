/**
 * 010-pos-catalog-read-down-consumption — `ReadDownClient` interface (DI seam).
 *
 * The CONCRETE HTTP client (`createReadDownClient`, T020/T021) is BLOCKED on
 * D-DEPLOY (#349): it consumes the generated `api-types.ts` snapshot type, which
 * cannot be re-pinned until the backend serves the deployed contract. Until then
 * the driver (T037/T038) depends only on this INTERFACE — the canonical DI seam —
 * and tests inject a fake. When T021 lands, `createReadDownClient` implements this
 * interface unchanged and the driver wiring (T039) is unaffected.
 *
 * The fetch outcome mirrors the contract's transport-result union
 * (contracts/backend-catalogue-snapshot.md): a reachable+valid snapshot (`ok`), an
 * unreachable backend (`no_connection`), or a reached-but-failed request
 * (`failed`, e.g. non-2xx / malformed body). The raw response body is NEVER
 * surfaced on a failure (P7/NFR-3) — only the discriminator.
 */

import type { SellableCatalogRow } from './map-sellable-row.js';

/** A reachable backend returned a usable snapshot. */
export interface ReadDownFetchOk {
  kind: 'ok';
  /** Opaque backend snapshot/version id (provenance; carried into freshness). */
  sourceSnapshotId: string | null;
  /** The sellable catalogue rows for the device-principal's (tenant, store). */
  rows: SellableCatalogRow[];
}

/** The backend was unreachable (offline / DNS / connection refused / timeout). */
export interface ReadDownFetchNoConnection {
  kind: 'no_connection';
}

/** The backend was reached but the request failed (non-2xx / malformed body). */
export interface ReadDownFetchFailed {
  kind: 'failed';
}

/**
 * RT-215 decision 2 — Backend-Core answered 401: the device credential was
 * refused. Distinct from `failed` so the device-revoked flow can tell it apart
 * (the device-401 detector confirms it with a second call). The driver treats
 * it like any other failed fetch: the prior catalogue is preserved.
 */
export interface ReadDownFetchDeviceUnauthorized {
  kind: 'device_unauthorized';
}

export type ReadDownFetchResult =
  | ReadDownFetchOk
  | ReadDownFetchNoConnection
  | ReadDownFetchFailed
  | ReadDownFetchDeviceUnauthorized;

export interface ReadDownClient {
  /**
   * Fetch the current catalogue snapshot for the device-principal's scope.
   * Resolves to a typed outcome; NEVER rejects (transport faults are mapped to
   * `no_connection` / `failed`). The device token is attached main-process-side
   * (`Authorization: Bearer <device_token>`, plan AD-7) and never surfaced here.
   */
  fetchSnapshot(): Promise<ReadDownFetchResult>;
}
