/**
 * 011-sale-sync-capture-up T027/T035/T041 — `sale-sync-engine`.
 *
 * Drains eligible sales UP to DP2 `captureSale`. One main-process engine; the
 * renderer never drives it (Principle III / P8). Single-flight admission mirrors
 * 010's `read-down-driver`: `runTickOnce()` returns synchronously
 * (`{ kind:'started', completed }` or `{ kind:'already_running' }`), and the
 * drain runs on the `completed` promise.
 *
 * One tick:
 *   1. If no operator session token is present → pause (no POST); resume next tick
 *      once a token returns (FR-3 / clarify Q1). The token is read in-process and
 *      never crosses the bridge.
 *   2. `stateRepo.eligible(scope, now)` → FIFO list (outbox LEFT JOIN state).
 *   3. For each: read the durable Sale, build the payload (tenders only past the
 *      RT-79 cutoff; integer minor units), POST, and record the outcome:
 *        ok(200/201) → markSynced  (incl. idempotent replays, P5); also stores
 *          the Backend-Core `saleRef` when the answer carried one (RT-15 S1)
 *        divergent(409) → markDeadLetter(reason `payload_divergence`) +
 *          onPayloadDivergence (RT-190): the server holds a DIFFERENT sale for
 *          this provenance. Terminal — never synced, never retried, never
 *          re-sent under a new key; an operator investigates.
 *        transient(5xx/timeout) / no_connection → recordTransient (stay pending,
 *          attempt++, exponential backoff next_retry_at)  (P3 no silent loss)
 *        permanent(4xx) → markDeadLetter + onDeadLetter notification  (P3/FR-7)
 *
 * Logs (caller's concern) carry only sale_id / externalId / status / category /
 * attempt / closed-set codes — never PII, card data, or the token (P7/P12).
 */

import type {
  CaptureConflictCode,
  SaleSyncClient,
  SaleSyncResult,
} from './sale-sync-client-types.js';
import { PAYLOAD_DIVERGENCE_REASON, type SaleSyncStateRepo } from './sale-sync-state-repo.js';
import {
  buildCapturePayload,
  TenderNotSendableError,
  type CaptureSalePayload,
} from './capture-payload.js';

/** Minimal read surface the engine needs from 008's sales repository. */
export interface SaleReadPort {
  readById(saleId: string): import('../sales/repositories/sales.repository.js').SaleRow | null;
}

export interface BackoffPolicy {
  /** First retry delay (ms). Doubles per attempt, capped at `maxMs`. */
  baseMs: number;
  maxMs: number;
}

export interface SaleSyncEngineDeps {
  client: SaleSyncClient;
  stateRepo: SaleSyncStateRepo;
  salesRepo: SaleReadPort;
  tenantId: string;
  branchId: string;
  /** In-process read of 004's operator session token; null when no session. */
  getOperatorToken: () => string | null;
  /** One ISO-8601 UTC stamp source (determinism in tests). */
  now: () => string;
  backoff: BackoffPolicy;
  /**
   * RT-79 rollout gate (`POS_PULSE_FEATURE_SALE_TENDERS_SINCE`, an ISO instant).
   * Unset/null = never send tenders. Set = only sales finalized at/after it carry
   * `tenders`. It must be a FUTURE instant, later than both the Backend-Core tender
   * switch and the POS restart that loads it (see index.ts).
   */
  tendersSince?: string | null | undefined;
  /**
   * Called once when a sale is dead-lettered (non-blocking operator notification).
   * `reason` is set when the POS itself refused to send the sale (RT-79: a tender it
   * cannot send faithfully); it carries no PII, card data or token.
   */
  onDeadLetter?: (saleId: string, reason?: string) => void;
  /**
   * RT-15 S1: called when a capture answer's `saleRef` differs from the one
   * already stored for the sale. The stored value is kept (first write wins).
   * Receives only the sale's opaque `externalId` — no PII, no reference values.
   */
  onSaleRefMismatch?: (info: { externalId: string }) => void;
  /**
   * RT-190: called once when a capture 409 dead-letters a sale as a payload
   * divergence. Receives only the opaque `externalId` and the closed-set
   * conflict code — no PII, no body, no token. `onDeadLetter` is NOT also
   * called for it.
   */
  onPayloadDivergence?: (info: { externalId: string; errorCode: CaptureConflictCode }) => void;
}

export type TickAdmission =
  | { kind: 'started'; completed: Promise<void> }
  | { kind: 'already_running' };

export interface SaleSyncEngine {
  /** Admit one drain tick synchronously; the drain resolves on `completed`. */
  runTickOnce(): TickAdmission;
}

/** Exponential backoff: baseMs * 2^(attempt-1), capped at maxMs. `attempt` is 1-based. */
export function backoffMs(policy: BackoffPolicy, attempt: number): number {
  const raw = policy.baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(raw, policy.maxMs);
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function createSaleSyncEngine(deps: SaleSyncEngineDeps): SaleSyncEngine {
  const { client, stateRepo, salesRepo, tenantId, branchId, getOperatorToken, now, backoff } = deps;
  const scope = { tenantId, branchId };
  let inFlight = false;

  async function drainOne(saleId: string): Promise<void> {
    const sale = salesRepo.readById(saleId);
    if (sale === null) return; // outbox row without a durable Sale — skip (defensive)

    let payload: CaptureSalePayload;
    try {
      payload = buildCapturePayload(sale, { tendersSince: deps.tendersSince });
    } catch (err) {
      if (!(err instanceof TenderNotSendableError)) throw err;
      // RT-10 D2: a sale whose tenders cannot be sent faithfully (voucher, unknown
      // method, corrupt amounts) is dead-lettered observably — never POSTed, never
      // given a fabricated method. The typed reason goes to `onDeadLetter`.
      stateRepo.markDeadLetter({ saleId, tenantId, branchId, now: now() });
      deps.onDeadLetter?.(saleId, err.message);
      return;
    }
    const result = await client.postSale(payload);
    recordOutcome(saleId, payload.externalId, result, now());
  }

  /** Persist one POST outcome on `sale_sync_state` and fire its notification. */
  function recordOutcome(
    saleId: string,
    externalId: string,
    result: SaleSyncResult,
    stamp: string,
  ): void {
    switch (result.kind) {
      case 'ok': {
        // RT-15 S1: persist the server reference with the synced transition. The
        // first stored reference wins; a null never clears it, and a different one
        // is kept out and reported.
        const synced = stateRepo.markSynced({
          saleId,
          tenantId,
          branchId,
          now: stamp,
          serverSaleRef: result.saleRef,
        });
        if (synced.saleRefMismatch) {
          deps.onSaleRefMismatch?.({ externalId });
        }
        return;
      }
      case 'divergent':
        // RT-190: the server holds a different sale for this provenance. Terminal
        // dead-letter with its own reason; never synced, never retried.
        stateRepo.markDeadLetter({
          saleId,
          tenantId,
          branchId,
          now: stamp,
          reason: PAYLOAD_DIVERGENCE_REASON,
        });
        deps.onPayloadDivergence?.({ externalId, errorCode: result.errorCode });
        return;
      case 'permanent':
        stateRepo.markDeadLetter({ saleId, tenantId, branchId, now: stamp });
        deps.onDeadLetter?.(saleId);
        return;
      case 'transient':
      case 'no_connection': {
        const prior = stateRepo.read(saleId);
        const attempt = (prior?.attempt_count ?? 0) + 1;
        stateRepo.recordTransient({
          saleId,
          tenantId,
          branchId,
          now: stamp,
          nextRetryAt: addMs(stamp, backoffMs(backoff, attempt)),
          errorCategory: result.kind === 'no_connection' ? 'no_connection' : 'transient',
        });
        return;
      }
    }
  }

  // 016 (M-1): envelope-present gate. The holder normalizes an absent/null
  // pos_operator envelope to '' (sign-in & takeover), so '' must be treated as
  // ABSENT exactly like null — otherwise an empty string slips past a `=== null`
  // check and the client rejects it as no_connection, a silent no-op drain. After
  // D7 (X-Device-Attestation retired) the envelope is the ONLY sale-wire credential,
  // so an absent envelope makes a device-token-alone POST structurally impossible.
  function envelopePresent(): boolean {
    const token = getOperatorToken();
    return token !== null && token.length > 0;
  }

  async function runTick(): Promise<void> {
    try {
      // Operator-session gate (FR-3): no envelope (null or '') → pause the whole drain.
      if (!envelopePresent()) return;
      const due = stateRepo.eligible(scope, now());
      for (const sale of due) {
        // Re-check the session before each POST so a mid-drain expiry pauses cleanly.
        if (!envelopePresent()) return;
        await drainOne(sale.sale_id);
      }
    } finally {
      inFlight = false;
    }
  }

  function runTickOnce(): TickAdmission {
    if (inFlight) return { kind: 'already_running' };
    inFlight = true;
    return { kind: 'started', completed: runTick() };
  }

  return { runTickOnce };
}
