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
 * Shutdown (RT-198, as the shift sync engine and the returns resolver): once
 * `isStopped()` is true a tick reads and writes nothing more. It is checked before
 * the tick's first read and again when every await resumes, so a send in flight at
 * stop settles WITHOUT `markSynced` / `recordTransient` / `markDeadLetter` (or any
 * other store call) — the DB closes right after the synchronous worker stop. The
 * sale stays `pending` with its stored bytes and key; the next start re-sends it
 * (an idempotent replay if the server recorded it). `drain(timeoutMs)` resolves
 * once the tick in flight has settled, or after `timeoutMs`, whichever is first.
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
import type { SaleRoute, SellingUserIdResolver } from './selling-user-id.js';
import { settledWithin } from './settled-within.js';
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
  /**
   * Codex P2 (beb7b72): an injected dependency (a store, a reader, a clock, the
   * client, the resolver) threw. Only what it touched is skipped — the sale stays
   * queued, the other sales go on, the tick resolves. Called once per episode
   * (re-armed by a tick without a failure). Receives nothing.
   */
  onDependencyFailure?: () => void;
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
  /** RT-198: true once the worker is stopping (app shutdown); default never. */
  isStopped?: () => boolean;
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
  /** Settles when the tick in flight has settled, or after `timeoutMs` (RT-198). */
  drain(timeoutMs: number): Promise<void>;
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

const ENVELOPE_ROUTE: SaleRoute = Object.freeze({ kind: 'envelope' });
const HOLD_ROUTE: SaleRoute = Object.freeze({ kind: 'hold' });

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
  const isStopped = deps.isStopped ?? (() => false);
  // The tick in flight (single-flight admission, and what `drain` waits for).
  let inFlight: Promise<void> | null = null;
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
   * RT-224 step 2: the sale's ONE credential from its own route, or null when the
   * sale is held or its credential is not held now (skipped, untouched).
   */
  function credentialFor(route: SaleRoute, held: HeldCredentials): SaleCredential | null {
    if (route.kind === 'device') {
      return held.device ? { kind: 'device', operatorUserId: route.operatorUserId } : null;
    }
    return route.kind === 'envelope' && held.envelope ? { kind: 'envelope' } : null;
  }

  /** Returns the POST outcome, or null when nothing was sent. */
  async function drainOne(
    sale: SaleRow,
    route: SaleRoute,
    held: HeldCredentials,
  ): Promise<SaleSyncResult | null> {
    const saleId = sale.sale_id;
    const credential = credentialFor(route, held);
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
      notify(() => deps.onDeadLetter?.(saleId, err.message));
      return null;
    }
    const result =
      credential.kind === 'device'
        ? await client.postSaleAsCashier(payload, credential.operatorUserId)
        : await client.postSale(payload);
    // Stopped while the request was in flight: touch nothing local (RT-198). The
    // sale stays pending and is re-sent, same bytes and key, on the next start.
    if (isStopped()) return null;
    recordOutcome(saleId, payload.externalId, result, now());
    if (leavesQueue(result)) deps.sellingUsers?.forget(saleId);
    if (credential.kind === 'device') noteDeviceAnswer(result);
    return result;
  }

  /** The sale is synced or dead-lettered (it will not be drained again). */
  function leftQueue(saleId: string): boolean {
    const status = stateRepo.read(saleId)?.sync_status;
    return status === 'synced' || status === 'dead_letter';
  }

  /**
   * Codex P2 (bf5960d): a notification hook is a side channel (a log line). A
   * throwing hook must never abort the tick; the transition it reports is
   * already persisted.
   */
  function notify(call: () => void): void {
    try {
      call();
    } catch {
      // A failing log sink must not stop the drain.
    }
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
    notify(() => deps.onDeviceUnauthorized?.());
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
          notify(() => deps.onSaleRefMismatch?.({ externalId }));
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
        notify(() => deps.onPayloadDivergence?.({ externalId, errorCode: result.errorCode }));
        return;
      case 'permanent':
        stateRepo.markDeadLetter({ saleId, tenantId, branchId, now: stamp });
        notify(() => deps.onDeadLetter?.(saleId));
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
        notify(() => deps.onDeadLetter?.(saleId, CASHIER_CLAIM_REFUSED_REASON));
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
    try {
      const token = getOperatorToken();
      return token !== null && token.length > 0;
    } catch {
      dependencyFailed();
      return false;
    }
  }

  /** RT-224 step 2: the device credential, read live; not wired → not held. */
  // Codex P2 (#547): a failing credential read is "not held" — it must never
  // abort the tick (and stop the envelope sales) or reject pausedReason().
  async function devicePresent(): Promise<boolean> {
    if (deps.hasDeviceCredential === undefined) return false;
    try {
      return await deps.hasDeviceCredential();
    } catch {
      dependencyFailed();
      return false;
    }
  }

  async function heldCredentials(): Promise<HeldCredentials> {
    return { envelope: envelopePresent(), device: await devicePresent() };
  }

  // rev547 F1: the number of due sales routed to the envelope at the last tick.
  // While no envelope is held they are blocked even when the device path flows,
  // so they keep the pause visible.
  // Codex P2 (bf5960d): the ids, not a start-of-tick number — a sale leaves the
  // set as soon as it leaves the queue (synced or dead-lettered).
  const envelopeDue = new Set<string>();

  /**
   * Paused when the drain holds no credential at all, or holds no envelope while
   * sales routed to the envelope are due (rev547 F1).
   */
  function reasonFor(held: HeldCredentials, envelopeDue: number): SaleSyncPausedReason | null {
    if (held.envelope) return null;
    return !held.device || envelopeDue > 0 ? 'no_operator_credential' : null;
  }

  async function pausedReason(): Promise<SaleSyncPausedReason | null> {
    return reasonFor(await heldCredentials(), envelopeDue.size);
  }

  // RT-224: the last reported pause state. `null` = nothing reported yet, so the
  // first tick reports a pause but never a resume.
  let reportedPaused: boolean | null = null;

  /**
   * The sales the missing credential blocks, for the transition report only:
   * with a device credential, the due envelope-routed sales (rev547 F1); without
   * one, the current terminal's whole unsent count (null when it cannot be read,
   * e.g. a transient SQLite error).
   */
  async function pendingCount(held: HeldCredentials): Promise<number | null> {
    if (held.device) return envelopeDue.size;
    try {
      const terminalId = await resolveTerminalId();
      if (isStopped()) return null;
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
  async function reportTransition(isPaused: boolean, held: HeldCredentials): Promise<boolean> {
    const onPauseTransition = deps.onPauseTransition;
    if (onPauseTransition === undefined) return true;
    const pending = await pendingCount(held);
    // Stopped while counting: report nothing (RT-198); the next start re-reports.
    if (isStopped()) return false;
    const event: SaleSyncPauseTransition = {
      transition: isPaused ? 'paused' : 'resumed',
      reason: 'no_operator_credential',
      pending,
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
   * changes. Returns the held credentials, or null when the drain can send
   * nothing (it holds neither credential). Reports at most once per transition,
   * so a paused engine is silent across ticks. The reported state is committed
   * only AFTER the report is delivered, so a failed report is retried on the next
   * check instead of being lost (Codex P2). rev547 F1: with a device credential
   * the drain still sends cashier sales, yet it is reported paused while
   * envelope-routed sales are due and no envelope is held.
   */
  async function credentialGate(): Promise<HeldCredentials | null> {
    const held = await heldCredentials();
    if (isStopped()) return null;
    const isPaused = reasonFor(held, envelopeDue.size) !== null;
    if (isPaused !== (reportedPaused ?? false) && (await reportTransition(isPaused, held))) {
      reportedPaused = isPaused;
    }
    return held.envelope || held.device ? held : null;
  }

  /**
   * rev547 F6: route every due sale; a resolver that throws holds them all this
   * tick (never the envelope) and the next tick retries.
   */
  function routesFor(
    sales: readonly SaleRow[],
    terminalId: string,
  ): ReadonlyMap<string, SaleRoute> {
    const resolver = deps.sellingUsers;
    if (resolver === undefined) return new Map(sales.map((sale) => [sale.sale_id, ENVELOPE_ROUTE]));
    // rev547 F6 / Codex P2: a resolver that throws ends the tick through the
    // tick-level catch — nothing is sent (never the envelope), the failure is
    // reported, and the next tick retries.
    return resolver.resolve(sales, terminalId);
  }

  /** The current terminal's due sales with their durable Sale (defensive skip). */
  function dueSales(terminalId: string): SaleRow[] {
    return stateRepo
      .eligible({ tenantId, branchId, terminalId }, now())
      .map((due) => readSale(due.sale_id))
      .filter((sale): sale is SaleRow => sale !== null);
  }

  /** One durable Sale; a failing read skips that sale only (it stays queued). */
  function readSale(saleId: string): SaleRow | null {
    try {
      return salesRepo.readById(saleId);
    } catch {
      dependencyFailed();
      return null;
    }
  }

  /**
   * One sale, isolated: a throwing dependency (store, clock, client, resolver)
   * skips this sale only — it stays queued — and the drain goes on.
   */
  async function drainSafely(
    sale: SaleRow,
    route: SaleRoute,
    held: HeldCredentials,
  ): Promise<SaleSyncResult | null> {
    try {
      const result = await drainOne(sale, route, held);
      if (isStopped()) return null;
      settleAfterSend(sale.sale_id);
      return result;
    } catch {
      dependencyFailed();
      return null;
    }
  }

  /** rev547 F1: the due sales that need the envelope (the pause's subset). */
  function trackEnvelopeDue(
    sales: readonly SaleRow[],
    routeOf: (sale: SaleRow) => SaleRoute,
  ): void {
    envelopeDue.clear();
    for (const sale of sales) {
      if (routeOf(sale).kind === 'envelope') envelopeDue.add(sale.sale_id);
    }
  }

  /** Codex P2 (bf5960d): a sale that left the queue leaves the envelope-due set. */
  function settleAfterSend(saleId: string): void {
    if (!leftQueue(saleId)) return;
    envelopeDue.delete(saleId);
  }

  /** Send the due sales in order; stops on a credential loss or a re-pair. */
  async function drainAll(
    sales: readonly SaleRow[],
    terminalId: string,
    routeOf: (sale: SaleRow) => SaleRoute,
  ): Promise<void> {
    // RT-224 step 2: after a device-path 401, no more device-path sends this tick.
    let deviceRejected = false;
    for (const sale of sales) {
      if (isStopped()) return;
      // Re-check before each POST so a mid-drain credential loss pauses cleanly.
      const held = await credentialGate();
      if (held === null) return;
      // RT-221: a re-pair mid-drain must not send the rest under the new identity.
      if ((await resolveTerminalId()) !== terminalId || isStopped()) return;
      const result = await drainSafely(sale, routeOf(sale), {
        envelope: held.envelope,
        device: held.device && !deviceRejected,
      });
      deviceRejected ||= result?.kind === 'device_unauthorized';
    }
  }

  /**
   * Whether the tick may go on: not stopped, and holding a credential. Credential
   * gate (FR-3): neither an envelope (null or '') nor a device credential → pause
   * the whole drain. (The envelope-subset pause, rev547 F1, is judged later once
   * this tick's routes are known.)
   */
  async function admitTick(): Promise<boolean> {
    if (isStopped()) return false;
    const atStart = await heldCredentials();
    if (isStopped()) return false;
    if (atStart.envelope || atStart.device) return true;
    await credentialGate();
    return false;
  }

  async function runTick(): Promise<void> {
    try {
      if (!(await admitTick())) return;
      // RT-221: drain only the current pairing's rows; no pairing → nothing.
      const terminalId = await resolveTerminalId();
      if (terminalId === null || isStopped()) return;
      const sales = dueSales(terminalId);
      // RT-224 step 2 (Codex P2): every due sale's route in one lookup.
      const routes = routesFor(sales, terminalId);
      const routeOf = (sale: SaleRow): SaleRoute => routes.get(sale.sale_id) ?? HOLD_ROUTE;
      trackEnvelopeDue(sales, routeOf);
      // Report the (envelope-subset) pause state now, even for an empty queue.
      if ((await credentialGate()) === null) return;
      await drainAll(sales, terminalId, routeOf);
    } catch {
      // Codex P2 (beb7b72): a tick-level dependency (the pairing read, the queue
      // read, the clock, the route resolver) threw — nothing more can be drained
      // this tick; the tick still resolves and the next tick retries.
      dependencyFailed();
    } finally {
      endTick();
    }
  }

  // Codex P2 (beb7b72): failure reporting, once per episode.
  let failedThisTick = false;
  let failureReported = false;

  function dependencyFailed(): void {
    failedThisTick = true;
    if (failureReported) return;
    failureReported = true;
    notify(() => deps.onDependencyFailure?.());
  }

  /** A tick without a failure re-arms the report. */
  function endTick(): void {
    if (!failedThisTick) failureReported = false;
    failedThisTick = false;
    inFlight = null;
  }

  function runTickOnce(): TickAdmission {
    if (inFlight !== null) return { kind: 'already_running' };
    // `runTick` always awaits before its `finally`, so `inFlight` is set first.
    const completed = runTick();
    inFlight = completed;
    return { kind: 'started', completed };
  }

  function drain(timeoutMs: number): Promise<void> {
    return inFlight === null ? Promise.resolve() : settledWithin(inFlight, timeoutMs);
  }

  return { runTickOnce, pausedReason, drain };
}
