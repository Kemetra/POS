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
 *   1. If the drain holds NEITHER an operator envelope NOR a device credential →
 *      pause (no POST); resume on a later tick once either returns (FR-3 / clarify
 *      Q1). Credentials are read in-process and never cross the bridge. RT-224:
 *      the pause is visible — `onPauseTransition` fires ONCE on entering the
 *      paused state and once on resuming (never per tick), and `pausedReason()`
 *      gives the live reason for the status surface.
 *   2. Resolve the CURRENT pairing's `terminal_id` (RT-221); none (unpaired /
 *      invalid) → nothing to drain. `stateRepo.eligible(scope, now)` → FIFO list
 *      (outbox LEFT JOIN state) of THIS terminal's rows only. Rows queued under an
 *      earlier pairing are held — never sent under the new device identity
 *      (RT-138 L6). The terminal is re-resolved before each POST, so a re-pair
 *      mid-drain stops the drain.
 *   3. For each: read the durable Sale and choose its ONE credential (RT-224
 *      step 2, Option B), from the sale itself — never from the current session:
 *        • the sale's own `payment.settled` payload carries `selling_user_id`
 *          (`sellingUserIdOf`) → the device bearer + `operatorUserId`
 *          (`postSaleAsCashier`), even while a manager envelope is held, so the
 *          cashier who made the sale is credited;
 *        • no `selling_user_id` (a manager/admin sale, or one finalized before
 *          RT-224) → the operator envelope, exactly as before (`postSale`).
 *      A sale whose credential is not held right now is skipped untouched (no
 *      attempt, no dead-letter) and the drain moves on, so a sale waiting for an
 *      envelope never blocks the cashier sales queued behind it. FIFO is the
 *      attempt order, not a barrier: each sale is captured independently
 *      (idempotent per externalId), as the per-sale backoff already allows.
 *      Then build the payload (tenders only past the RT-79 cutoff; integer minor
 *      units), POST, and record the outcome:
 *        ok(200/201) → markSynced  (incl. idempotent replays, P5); also stores
 *          the Backend-Core `saleRef` when the answer carried one (RT-15 S1)
 *        divergent(409) → markDeadLetter(reason `payload_divergence`) +
 *          onPayloadDivergence (RT-190): the server holds a DIFFERENT sale for
 *          this provenance. Terminal — never synced, never retried, never
 *          re-sent under a new key; an operator investigates.
 *        transient(5xx/timeout) / no_connection → recordTransient (stay pending,
 *          attempt++, exponential backoff next_retry_at)  (P3 no silent loss)
 *        transient(425/429, RT-194) → the same, but next_retry_at is at least the
 *          server's `Retry-After` (`retryAfterMs`). There is no max-attempts cap:
 *          a transient sale is never dead-lettered, however many retries it takes.
 *        permanent(4xx) → markDeadLetter + onDeadLetter notification  (P3/FR-7)
 *        refused(device-path 403, RT-224) → markDeadLetter(reason
 *          `cashier_claim_refused`) + onDeadLetter: this sale's cashier claim was
 *          refused. Per-sale and terminal — never a device revocation, never a
 *          pause; the next sale is still sent. Repair is the envelope path.
 *        device_unauthorized(device-path 401, RT-224) → recordTransient (category
 *          `device_unauthorized`; the sale stays queued) and the device path is
 *          not used again in this tick. `onDeviceUnauthorized` fires once per
 *          episode (re-armed by any device-path answer that is not a 401).
 *          Revoking the device is NOT the drain's call (RT-215's detector owns it).
 *
 * Logs (caller's concern) carry only sale_id / externalId / status / category /
 * attempt / closed-set codes — never PII, card data, or the token (P7/P12).
 */

import type {
  CaptureConflictCode,
  SaleSyncClient,
  SaleSyncResult,
} from './sale-sync-client-types.js';
import {
  CASHIER_CLAIM_REFUSED_REASON,
  PAYLOAD_DIVERGENCE_REASON,
  type SaleSyncErrorCategory,
  type SaleSyncStateRepo,
} from './sale-sync-state-repo.js';
import type { SaleRow } from '../sales/repositories/sales.repository.js';
import type { SellingUserIdResolver } from './selling-user-id.js';
import {
  buildCapturePayload,
  TenderNotSendableError,
  type CaptureSalePayload,
} from './capture-payload.js';

/** Minimal read surface the engine needs from 008's sales repository. */
export interface SaleReadPort {
  readById(saleId: string): SaleRow | null;
}

export interface BackoffPolicy {
  /** First retry delay (ms). Doubles per attempt, capped at `maxMs`. */
  baseMs: number;
  maxMs: number;
}

/**
 * The sale-sync retry policy: 1 s base, doubling per attempt, capped at 5 min.
 * Also the per-row backoff of the RT-15 returns resolver (RT-197 I2).
 */
export const SALE_SYNC_BACKOFF_POLICY: Readonly<BackoffPolicy> = Object.freeze({
  baseMs: 1_000,
  maxMs: 5 * 60 * 1_000,
});

/**
 * RT-224: the closed set of reasons the drain can be paused for. Today there is
 * one: the drain holds no sale credential at all — no operator envelope (no
 * session, or a cashier session, whose envelope is '') AND no device credential
 * (an unpaired terminal, or no device token).
 */
export const SALE_SYNC_PAUSED_REASONS = ['no_operator_credential'] as const;
export type SaleSyncPausedReason = (typeof SALE_SYNC_PAUSED_REASONS)[number];

/**
 * RT-224: one pause-state transition. `pending` is the current terminal's unsent
 * count at the transition, or null when that count could not be read (the
 * transition is still reported — the reason matters more than the count).
 * Nothing else — no token, no ids, no PII (P7).
 */
export interface SaleSyncPauseTransition {
  transition: 'paused' | 'resumed';
  reason: SaleSyncPausedReason;
  pending: number | null;
}

/** RT-224: the closed-set log messages for a pause transition. */
export const SALE_SYNC_PAUSED_LOG = 'sale_sync:paused_no_operator_credential';
export const SALE_SYNC_RESUMED_LOG = 'sale_sync:resumed_operator_credential';

/** The logger surface the pause log needs (pino's `warn` / `info`). */
export interface SaleSyncPauseLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

/**
 * RT-224: write one pause transition. The payload is built from an allowlist
 * ({ reason, pending }) — never by spreading the event — so nothing else can
 * reach the log line.
 */
export function logSaleSyncPauseTransition(
  logger: SaleSyncPauseLogger,
  event: SaleSyncPauseTransition,
): void {
  const payload = { reason: event.reason, pending: event.pending };
  if (event.transition === 'paused') {
    logger.warn(payload, SALE_SYNC_PAUSED_LOG);
  } else {
    logger.info(payload, SALE_SYNC_RESUMED_LOG);
  }
}

export interface SaleSyncEngineDeps {
  client: SaleSyncClient;
  stateRepo: SaleSyncStateRepo;
  salesRepo: SaleReadPort;
  tenantId: string;
  branchId: string;
  /**
   * RT-221: the CURRENT pairing's `terminal_id`, read live from the pairing
   * status on every tick (and before every POST); null when the terminal is
   * unpaired or its pairing is invalid. Only this terminal's outbox rows are
   * drained.
   */
  resolveTerminalId: () => string | null | Promise<string | null>;
  /** In-process read of 004's operator session token; null when no session. */
  getOperatorToken: () => string | null;
  /**
   * RT-224 step 2: whether the paired terminal's DEVICE credential is held right
   * now (the device-path bearer). Not wired → false (envelope path only).
   */
  hasDeviceCredential?: () => boolean | Promise<boolean>;
  /**
   * RT-224 step 2: the `users.id` of the cashier who made each sale, from its own
   * `payment.settled` payload (`createSellingUserIdResolver`); null → envelope
   * path. Never the current session's user. Resolved once per tick for all due
   * sales (one query for the sales not seen before; Codex P2) and forgotten when
   * a sale leaves the queue. Not wired → always null.
   */
  sellingUsers?: SellingUserIdResolver;
  /**
   * RT-224 step 2: a device-path 401. Called once per episode (until a
   * device-path answer that is not a 401). Receives nothing — no token, no ids.
   */
  onDeviceUnauthorized?: () => void;
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
  /**
   * RT-224: called ONCE when the drain enters the paused state (no sale
   * credential) and once when it resumes — never on every tick. The first tick
   * reports a pause if it starts paused; a drain that starts with a credential
   * reports nothing until it is first paused. If the hook throws, the transition
   * counts as unreported and is retried on the next tick; the tick itself goes on.
   */
  onPauseTransition?: (event: SaleSyncPauseTransition) => void;
}

export type TickAdmission =
  | { kind: 'started'; completed: Promise<void> }
  | { kind: 'already_running' };

export interface SaleSyncEngine {
  /** Admit one drain tick synchronously; the drain resolves on `completed`. */
  runTickOnce(): TickAdmission;
  /**
   * RT-224: why the drain cannot send right now, read live from the credentials
   * (not from the last tick); null when an envelope or a device credential is held.
   */
  pausedReason(): Promise<SaleSyncPausedReason | null>;
}

/** Exponential backoff: baseMs * 2^(attempt-1), capped at maxMs. `attempt` is 1-based. */
export function backoffMs(policy: BackoffPolicy, attempt: number): number {
  const raw = policy.baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(raw, policy.maxMs);
}

/**
 * RT-194: delay before the next attempt — the backoff, or the server's
 * `Retry-After` when that is longer (the retry must never come before it).
 */
export function retryDelayMs(
  policy: BackoffPolicy,
  attempt: number,
  result: Extract<SaleSyncResult, { kind: 'transient' | 'no_connection' | 'device_unauthorized' }>,
): number {
  const backoffDelay = backoffMs(policy, attempt);
  return result.kind === 'transient' && result.retryAfterMs !== undefined
    ? Math.max(backoffDelay, result.retryAfterMs)
    : backoffDelay;
}

/** A terminal outcome: the sale is synced or dead-lettered and never drained again. */
function leavesQueue(result: SaleSyncResult): boolean {
  return !RETRYABLE_KINDS.has(result.kind);
}

const RETRYABLE_KINDS: ReadonlySet<SaleSyncResult['kind']> = new Set([
  'transient',
  'no_connection',
  'device_unauthorized',
]);

/** The stored category of a retryable outcome. */
function transientCategory(
  kind: 'transient' | 'no_connection' | 'device_unauthorized',
): SaleSyncErrorCategory {
  return kind;
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function createSaleSyncEngine(deps: SaleSyncEngineDeps): SaleSyncEngine {
  const {
    client,
    stateRepo,
    salesRepo,
    tenantId,
    branchId,
    resolveTerminalId,
    getOperatorToken,
    now,
    backoff,
  } = deps;
  let inFlight = false;
  // RT-224 step 2: a device-path 401 was reported and no device-path answer
  // other than a 401 has come back since (one report per episode).
  let deviceUnauthorizedReported = false;

  /** The credentials held right now, read in-process (never bridged). */
  interface HeldCredentials {
    envelope: boolean;
    device: boolean;
  }

  /** The one credential a sale is sent with: the device path names its cashier. */
  type SaleCredential = { kind: 'envelope' } | { kind: 'device'; operatorUserId: string };

  /**
   * RT-224 step 2: choose the sale's ONE credential from the sale itself (its own
   * resolved `operatorUserId`), or null when that credential is not held now (the
   * sale is skipped, untouched).
   */
  function credentialFor(
    operatorUserId: string | null,
    held: HeldCredentials,
  ): SaleCredential | null {
    if (operatorUserId !== null) {
      return held.device ? { kind: 'device', operatorUserId } : null;
    }
    return held.envelope ? { kind: 'envelope' } : null;
  }

  /** Returns the POST outcome, or null when nothing was sent. */
  async function drainOne(
    sale: SaleRow,
    operatorUserId: string | null,
    held: HeldCredentials,
  ): Promise<SaleSyncResult | null> {
    const saleId = sale.sale_id;
    const credential = credentialFor(operatorUserId, held);
    if (credential === null) return null;

    let payload: CaptureSalePayload;
    try {
      payload = buildCapturePayload(sale, { tendersSince: deps.tendersSince });
    } catch (err) {
      if (!(err instanceof TenderNotSendableError)) throw err;
      // RT-10 D2: a sale whose tenders cannot be sent faithfully (voucher, unknown
      // method, corrupt amounts) is dead-lettered observably — never POSTed, never
      // given a fabricated method. The typed reason goes to `onDeadLetter`.
      stateRepo.markDeadLetter({ saleId, tenantId, branchId, now: now() });
      deps.sellingUsers?.forget(saleId);
      deps.onDeadLetter?.(saleId, err.message);
      return null;
    }
    const result =
      credential.kind === 'device'
        ? await client.postSaleAsCashier(payload, credential.operatorUserId)
        : await client.postSale(payload);
    recordOutcome(saleId, payload.externalId, result, now());
    if (leavesQueue(result)) deps.sellingUsers?.forget(saleId);
    if (credential.kind === 'device') noteDeviceAnswer(result);
    return result;
  }

  /** RT-224 step 2: report a device-path 401 once per episode. */
  function noteDeviceAnswer(result: SaleSyncResult): void {
    if (result.kind === 'no_connection') return; // no answer from the server
    if (result.kind !== 'device_unauthorized') {
      deviceUnauthorizedReported = false;
      return;
    }
    if (deviceUnauthorizedReported) return;
    deviceUnauthorizedReported = true;
    deps.onDeviceUnauthorized?.();
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
      case 'refused':
        // RT-224 step 2: the server refused THIS sale's cashier claim (device-path
        // 403). Terminal for the sale only — no revocation, no pause.
        stateRepo.markDeadLetter({
          saleId,
          tenantId,
          branchId,
          now: stamp,
          reason: CASHIER_CLAIM_REFUSED_REASON,
        });
        deps.onDeadLetter?.(saleId, CASHIER_CLAIM_REFUSED_REASON);
        return;
      case 'device_unauthorized':
      case 'transient':
      case 'no_connection': {
        const prior = stateRepo.read(saleId);
        const attempt = (prior?.attempt_count ?? 0) + 1;
        stateRepo.recordTransient({
          saleId,
          tenantId,
          branchId,
          now: stamp,
          nextRetryAt: addMs(stamp, retryDelayMs(backoff, attempt, result)),
          errorCategory: transientCategory(result.kind),
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

  /** RT-224 step 2: the device credential, read live; not wired → not held. */
  // Codex P2 (#547): a failing credential read is "not held" — it must never
  // abort the tick (and stop the envelope sales) or reject pausedReason().
  async function devicePresent(): Promise<boolean> {
    if (deps.hasDeviceCredential === undefined) return false;
    try {
      return await deps.hasDeviceCredential();
    } catch {
      return false;
    }
  }

  async function heldCredentials(): Promise<HeldCredentials> {
    return { envelope: envelopePresent(), device: await devicePresent() };
  }

  function reasonFor(held: HeldCredentials): SaleSyncPausedReason | null {
    return held.envelope || held.device ? null : 'no_operator_credential';
  }

  async function pausedReason(): Promise<SaleSyncPausedReason | null> {
    return reasonFor(await heldCredentials());
  }

  // RT-224: the last reported pause state. `null` = nothing reported yet, so the
  // first tick reports a pause but never a resume.
  let reportedPaused: boolean | null = null;

  /**
   * The current terminal's unsent count, for the transition report only; null
   * when it cannot be read (e.g. a transient SQLite error).
   */
  async function pendingCount(): Promise<number | null> {
    try {
      const terminalId = await resolveTerminalId();
      return stateRepo.readSyncStatus({ tenantId, branchId, terminalId }).pending;
    } catch {
      return null;
    }
  }

  /**
   * RT-224: deliver one transition. Returns true once it has been delivered (or
   * there is no hook). A throwing hook returns false, so the caller leaves the
   * transition unreported and the next tick retries it.
   */
  async function reportTransition(isPaused: boolean): Promise<boolean> {
    const onPauseTransition = deps.onPauseTransition;
    if (onPauseTransition === undefined) return true;
    const event: SaleSyncPauseTransition = {
      transition: isPaused ? 'paused' : 'resumed',
      reason: 'no_operator_credential',
      pending: await pendingCount(),
    };
    try {
      onPauseTransition(event);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * RT-224: read the credentials and report a transition when the pause state
   * changes. Returns the held credentials, or null when the drain is paused (it
   * holds neither). Reports at most once per transition, so a paused engine is
   * silent across ticks. The reported state is committed only AFTER the report is
   * delivered, so a failed report is retried on the next tick instead of being
   * lost (Codex P2).
   */
  async function credentialGate(): Promise<HeldCredentials | null> {
    const held = await heldCredentials();
    const isPaused = reasonFor(held) !== null;
    if (isPaused !== (reportedPaused ?? false) && (await reportTransition(isPaused))) {
      reportedPaused = isPaused;
    }
    return isPaused ? null : held;
  }

  async function runTick(): Promise<void> {
    try {
      // Credential gate (FR-3): neither an envelope (null or '') nor a device
      // credential → pause the whole drain.
      if ((await credentialGate()) === null) return;
      // RT-221: drain only the current pairing's rows; no pairing → nothing.
      const terminalId = await resolveTerminalId();
      if (terminalId === null) return;
      const sales = stateRepo
        .eligible({ tenantId, branchId, terminalId }, now())
        .map((due) => salesRepo.readById(due.sale_id))
        // An outbox row without a durable Sale is skipped (defensive).
        .filter((sale): sale is SaleRow => sale !== null);
      // RT-224 step 2 (Codex P2): every due sale's cashier in one lookup.
      const userIds = deps.sellingUsers?.resolve(sales, terminalId);
      // RT-224 step 2: after a device-path 401, no more device-path sends this tick.
      let deviceRejected = false;
      for (const sale of sales) {
        // Re-check before each POST so a mid-drain credential loss pauses cleanly.
        const held = await credentialGate();
        if (held === null) return;
        // RT-221: a re-pair mid-drain must not send the rest under the new identity.
        if ((await resolveTerminalId()) !== terminalId) return;
        const result = await drainOne(sale, userIds?.get(sale.sale_id) ?? null, {
          envelope: held.envelope,
          device: held.device && !deviceRejected,
        });
        if (result?.kind === 'device_unauthorized') deviceRejected = true;
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

  return { runTickOnce, pausedReason };
}
