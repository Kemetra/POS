/**
 * 011-sale-sync-capture-up T021 — `sale-sync-state-repo`.
 *
 * Tenant-scoped read/write of the `sale_sync_state` bookkeeping table (migration
 * 0034; data-model.md §"sale_sync_state"). This is 011's OWN mutable state store;
 * 008's `sale_sync_outbox` is read-only here and is never written (it is
 * enqueue-only — CHECK + UPDATE/DELETE-refusing triggers, 008 AD-3).
 *
 * The `eligible()` query is the heart of the drain. It MUST start from the
 * outbox, not from `sale_sync_state`: a freshly-finalized sale has an outbox row
 * but NO state row yet (the state row is created on first attempt). A query that
 * read only `sale_sync_state` would skip every brand-new sale forever. So:
 *
 *   sale_sync_outbox  LEFT JOIN  sale_sync_state  ON sale_id
 *   WHERE no state row yet  OR  (pending AND next_retry_at due/null)
 *   ORDER BY enqueued_at   (FIFO)
 *
 * Mirrors 010's `catalogue-sync-state-repo` DI discipline — `DatabaseHandle` is
 * injected so tests run on sql.js without the native better-sqlite3 binding.
 *
 * No secrets: timestamps + an opaque error category only (P7).
 *
 * RT-15 S1 (migration 0038): `server_sale_ref` holds the Backend-Core `saleRef`
 * (UUID) from a 200/201 capture answer. It is written only by `markSynced` and
 * FIRST WRITE WINS: once stored it is never cleared and never replaced. A later
 * write with no reference (a malformed body, a transient/dead-letter
 * transition) keeps it, and so does a later DIFFERENT reference —
 * Backend-Core's saleRef is stable per sale, so a different value is an anomaly;
 * `markSynced` reports it (`saleRefMismatch`) for the caller to log. NULL means
 * "not known" — every pre-S1 row, and any sale whose capture answer carried no
 * usable reference.
 *
 * RT-190: a dead-lettered row records WHY in `last_error_category` (free TEXT
 * since 0034 — no migration): `permanent` (a 4xx or a sale the POS refused to
 * send) or `payload_divergence` (a capture 409 — the server holds a different
 * sale for this provenance). Both are terminal `dead_letter`: never eligible,
 * never retried. `readSyncStatus` counts both in `deadLetter` and the
 * divergences again in `payloadDivergence`. RT-224 step 2 adds
 * `cashier_claim_refused` (a device-path 403: the server refused the sale's
 * cashier claim), also terminal and counted in `deadLetter`. A pending row's
 * category may now also be `device_unauthorized` (a device-path 401; retried).
 *
 * RT-221: the drain is scoped to the CURRENT pairing's `terminal_id` as well as
 * (tenant_id, branch_id) — the outbox index on (tenant_id, branch_id,
 * terminal_id, state, enqueued_at) from 0024 covers it, so no migration. After a
 * re-pair into the same store the terminal has a new device identity; RT-138 L6
 * forbids replaying the earlier pairing's sales under it. Those rows are HELD:
 * never eligible, never deleted or mutated (the outbox is append-only anyway),
 * and counted in `heldPreviousPairing`. A null `terminalId` (unpaired / invalid
 * terminal) makes nothing eligible. Recovering held rows is a support flow.
 */

import type { DatabaseHandle } from '../db/client.js';

export type SaleSyncStatus = 'pending' | 'synced' | 'dead_letter';
export type SaleSyncErrorCategory =
  | 'transient'
  | 'permanent'
  | 'no_connection'
  | 'device_unauthorized';

/** RT-190: the reason stored with a dead-letter (`last_error_category`). */
export type SaleSyncDeadLetterReason = 'permanent' | 'payload_divergence' | 'cashier_claim_refused';
export const PAYLOAD_DIVERGENCE_REASON = 'payload_divergence' satisfies SaleSyncDeadLetterReason;
/** RT-224 step 2: a device-path 403 `refused` — this sale's cashier claim was refused. */
export const CASHIER_CLAIM_REFUSED_REASON =
  'cashier_claim_refused' satisfies SaleSyncDeadLetterReason;

/** The stored bookkeeping row (one per sale that has begun syncing). */
export interface SaleSyncStateRow {
  sale_id: string;
  tenant_id: string;
  branch_id: string;
  sync_status: SaleSyncStatus;
  attempt_count: number;
  next_retry_at: string | null;
  last_error_category: string | null;
  last_attempt_at: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
  /** RT-15 S1: Backend-Core `saleRef` (UUID); null when not known. */
  server_sale_ref: string | null;
}

/** A sale that is due for a (re)send: an outbox row, FIFO-ordered by enqueue time. */
export interface EligibleSale {
  sale_id: string;
  tenant_id: string;
  branch_id: string;
  enqueued_at: string;
}

export interface TenantScope {
  tenantId: string;
  branchId: string;
}

/**
 * RT-221: the drain scope — tenant/branch plus the CURRENT pairing's
 * `terminal_id`. Null when the terminal is not paired (or its pairing is
 * invalid): nothing is eligible then.
 */
export interface DrainScope extends TenantScope {
  terminalId: string | null;
}

export interface MarkSyncedInput extends TenantScope {
  saleId: string;
  /** ISO-8601 UTC. */
  now: string;
  /**
   * RT-15 S1: the Backend-Core `saleRef` from the capture answer. Stored only if
   * none is stored yet (first write wins); null/omitted never clears one.
   */
  serverSaleRef?: string | null;
}

/** RT-15 S1: what `markSynced` did with the incoming `serverSaleRef`. */
export interface MarkSyncedResult {
  /**
   * True when a non-null incoming reference differs from the one already stored.
   * The stored value is kept; the caller logs the anomaly (no PII).
   */
  saleRefMismatch: boolean;
}

export interface MarkDeadLetterInput extends TenantScope {
  saleId: string;
  now: string;
  /** RT-190: why the sale is terminal. Defaults to `permanent`. */
  reason?: SaleSyncDeadLetterReason;
}

export interface RecordTransientInput extends TenantScope {
  saleId: string;
  now: string;
  /** ISO-8601 UTC when this sale becomes eligible again (backoff). */
  nextRetryAt: string;
  errorCategory: SaleSyncErrorCategory;
}

/** Read-only counts for the renderer's sync-status surface (P7: no secrets). */
export interface SaleSyncStatusCounts {
  /** Unsent sales of the CURRENT terminal (RT-221) — the ones the drain will send. */
  pending: number;
  /**
   * RT-221: unsent sales of this tenant/branch queued under an EARLIER pairing
   * (a different `terminal_id`, or every unsent sale while the terminal has no
   * current pairing). They are held: never sent, never deleted. Recovering them
   * is a support flow.
   */
  heldPreviousPairing: number;
  /** Every dead-lettered sale, divergences included. */
  deadLetter: number;
  /** RT-190: the dead-lettered sales whose capture answered 409 (payload divergence). */
  payloadDivergence: number;
  lastSuccessAt: string | null;
}

export interface SaleSyncStateRepo {
  read(saleId: string): SaleSyncStateRow | null;
  /**
   * Sales due for a send now: the current terminal's outbox rows with no terminal
   * state and (if pending) a due retry. Empty when `scope.terminalId` is null.
   */
  eligible(scope: DrainScope, now: string): EligibleSale[];
  /** Tenant-scoped counts for the read-only status surface (pending per terminal). */
  readSyncStatus(scope: DrainScope): SaleSyncStatusCounts;
  markSynced(input: MarkSyncedInput): MarkSyncedResult;
  markDeadLetter(input: MarkDeadLetterInput): void;
  recordTransient(input: RecordTransientInput): void;
  /**
   * RT-15 S1: the stored Backend-Core `saleRef` of a SYNCED sale in this scope,
   * else null (unknown sale, other tenant/branch, not synced, or pre-S1 row).
   * Read helper for the return flow (S2); no IPC exposes it in S1.
   */
  findServerSaleRefBySaleId(scope: TenantScope, saleId: string): string | null;
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}
interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}
interface PrepareRun {
  run(...params: unknown[]): unknown;
}

export function createSaleSyncStateRepo(db: DatabaseHandle): SaleSyncStateRepo {
  function read(saleId: string): SaleSyncStateRow | null {
    const stmt = db.prepare(
      `SELECT sale_id, tenant_id, branch_id, sync_status, attempt_count, next_retry_at,
              last_error_category, last_attempt_at, synced_at, created_at, updated_at,
              server_sale_ref
       FROM sale_sync_state WHERE sale_id = ?`,
    ) as PrepareGet<SaleSyncStateRow>;
    return stmt.get(saleId) ?? null;
  }

  function eligible(scope: DrainScope, now: string): EligibleSale[] {
    // RT-221: no current pairing → nothing is eligible.
    if (scope.terminalId === null) return [];
    // Start from the outbox so first-drain (no state row) is included. A sale is
    // due when it has no state row, OR it is still pending and its next_retry_at
    // is null/<= now. synced / dead_letter are terminal → excluded. FIFO.
    // RT-221: only the current terminal's rows — an earlier pairing's are held.
    const stmt = db.prepare(
      `SELECT o.sale_id AS sale_id, o.tenant_id AS tenant_id, o.branch_id AS branch_id,
              o.enqueued_at AS enqueued_at
       FROM sale_sync_outbox o
       LEFT JOIN sale_sync_state s ON s.sale_id = o.sale_id
       WHERE o.tenant_id = ? AND o.branch_id = ? AND o.terminal_id = ?
         AND (
           s.sale_id IS NULL
           OR (s.sync_status = 'pending' AND (s.next_retry_at IS NULL OR s.next_retry_at <= ?))
         )
       ORDER BY o.enqueued_at ASC`,
    ) as PrepareAll<EligibleSale>;
    return stmt.all(scope.tenantId, scope.branchId, scope.terminalId, now);
  }

  /** UPSERT the terminal/transition state for a sale, tenant-scoped. */
  function upsert(
    input: TenantScope & {
      saleId: string;
      status: SaleSyncStatus;
      now: string;
      bumpAttempt: boolean;
      nextRetryAt: string | null;
      errorCategory: string | null;
      syncedAt: string | null;
      serverSaleRef: string | null;
    },
  ): void {
    // PK is sale_id (globally unique per sale); tenant_id is fixed for a given
    // sale, so no tenant guard is needed on the conflict path. Tenant scoping is
    // enforced on the READ side (eligible()).
    const stmt = db.prepare(
      `INSERT INTO sale_sync_state
         (sale_id, tenant_id, branch_id, sync_status, attempt_count, next_retry_at,
          last_error_category, last_attempt_at, synced_at, created_at, updated_at,
          server_sale_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sale_id) DO UPDATE SET
         sync_status         = excluded.sync_status,
         attempt_count       = sale_sync_state.attempt_count + ?,
         next_retry_at       = excluded.next_retry_at,
         last_error_category = excluded.last_error_category,
         last_attempt_at     = excluded.last_attempt_at,
         synced_at           = COALESCE(excluded.synced_at, sale_sync_state.synced_at),
         server_sale_ref     = COALESCE(sale_sync_state.server_sale_ref, excluded.server_sale_ref),
         updated_at          = excluded.updated_at`,
    ) as PrepareRun;
    const initialAttempt = input.bumpAttempt ? 1 : 0;
    const conflictBump = input.bumpAttempt ? 1 : 0;
    stmt.run(
      input.saleId,
      input.tenantId,
      input.branchId,
      input.status,
      initialAttempt,
      input.nextRetryAt,
      input.errorCategory,
      input.now,
      input.syncedAt,
      input.now,
      input.now,
      input.serverSaleRef,
      conflictBump,
    );
  }

  function markSynced(input: MarkSyncedInput): MarkSyncedResult {
    // Read-then-upsert is safe: the DB handle is synchronous and the engine is
    // single-flight, so nothing interleaves between the two statements.
    const incoming = input.serverSaleRef ?? null;
    const stored = incoming === null ? null : (read(input.saleId)?.server_sale_ref ?? null);
    upsert({
      ...input,
      status: 'synced',
      bumpAttempt: false,
      nextRetryAt: null,
      errorCategory: null,
      syncedAt: input.now,
      serverSaleRef: incoming,
    });
    return { saleRefMismatch: stored !== null && stored !== incoming };
  }

  function markDeadLetter(input: MarkDeadLetterInput): void {
    upsert({
      ...input,
      status: 'dead_letter',
      bumpAttempt: false,
      nextRetryAt: null,
      errorCategory: input.reason ?? 'permanent',
      syncedAt: null,
      serverSaleRef: null,
    });
  }

  function readSyncStatus(scope: DrainScope): SaleSyncStatusCounts {
    // Unsent = outbox rows that are not yet terminal (no state row, or state
    // pending). RT-221 splits them by terminal: `pending` = the current
    // terminal's; `held` = every other terminal's (all of them when there is no
    // current terminal — `IS` / `IS NOT` treat a NULL binding as a value).
    const unsentStmt = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN o.terminal_id IS ? THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN o.terminal_id IS NOT ? THEN 1 ELSE 0 END), 0) AS held
       FROM sale_sync_outbox o
       LEFT JOIN sale_sync_state s ON s.sale_id = o.sale_id
       WHERE o.tenant_id = ? AND o.branch_id = ?
         AND (s.sale_id IS NULL OR s.sync_status = 'pending')`,
    ) as PrepareGet<{ pending: number; held: number }>;
    const deadStmt = db.prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN last_error_category = ? THEN 1 ELSE 0 END), 0) AS d
       FROM sale_sync_state
       WHERE tenant_id = ? AND branch_id = ? AND sync_status = 'dead_letter'`,
    ) as PrepareGet<{ n: number; d: number }>;
    const lastStmt = db.prepare(
      `SELECT MAX(synced_at) AS t FROM sale_sync_state
       WHERE tenant_id = ? AND branch_id = ? AND sync_status = 'synced'`,
    ) as PrepareGet<{ t: string | null }>;
    const unsent = unsentStmt.get(
      scope.terminalId,
      scope.terminalId,
      scope.tenantId,
      scope.branchId,
    );
    const dead = deadStmt.get(PAYLOAD_DIVERGENCE_REASON, scope.tenantId, scope.branchId);
    const lastSuccessAt = lastStmt.get(scope.tenantId, scope.branchId)?.t ?? null;
    return {
      pending: unsent?.pending ?? 0,
      heldPreviousPairing: unsent?.held ?? 0,
      deadLetter: dead?.n ?? 0,
      payloadDivergence: dead?.d ?? 0,
      lastSuccessAt,
    };
  }

  function recordTransient(input: RecordTransientInput): void {
    upsert({
      tenantId: input.tenantId,
      branchId: input.branchId,
      saleId: input.saleId,
      status: 'pending',
      bumpAttempt: true,
      nextRetryAt: input.nextRetryAt,
      errorCategory: input.errorCategory,
      now: input.now,
      syncedAt: null,
      serverSaleRef: null,
    });
  }

  function findServerSaleRefBySaleId(scope: TenantScope, saleId: string): string | null {
    const stmt = db.prepare(
      `SELECT server_sale_ref FROM sale_sync_state
       WHERE sale_id = ? AND tenant_id = ? AND branch_id = ? AND sync_status = 'synced'`,
    ) as PrepareGet<{ server_sale_ref: string | null }>;
    return stmt.get(saleId, scope.tenantId, scope.branchId)?.server_sale_ref ?? null;
  }

  return {
    read,
    eligible,
    readSyncStatus,
    markSynced,
    markDeadLetter,
    recordTransient,
    findServerSaleRefBySaleId,
  };
}
