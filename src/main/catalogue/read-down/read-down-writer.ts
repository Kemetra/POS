/**
 * 010-pos-catalog-read-down-consumption T024/T027/T032/T035 — `read-down-writer`.
 *
 * The OFFLINE correctness core of the read-down. Given a fetched snapshot (a list
 * of backend `SellableCatalogRow`s) plus the injected device-principal scope
 * (`tenantId`/`branchId`), it:
 *
 *   1. clears staging at the START of the run (so a prior failed run's rows can
 *      never leak into this promote — data-model invariant 2);
 *   2. maps + validates each row (mapping rejections and validation rejections
 *      are counted UNIFORMLY — FR-9 skip-and-count);
 *   3. applies the abort-threshold: if the rejected fraction is implausibly high
 *      (suggesting a source-format break, not one bad row) the run FAILS with no
 *      promote and the prior catalogue is preserved (FR-7 / SC-5);
 *   4. otherwise stages the validated rows, computing the fold columns with 009's
 *      `normalize()` per the R1 composition rule (so the stored fold matches
 *      009's query fold — fold-parity, SC-9);
 *   5. promotes in ONE better-sqlite3 transaction: DELETE the tenant's live rows +
 *      INSERT … SELECT from staging + write `last_success_at` INSIDE the same tx
 *      (atomic — a throw rolls back the whole thing, SC-4 / FR-6; freshness can
 *      never claim a promote that didn't commit, SC-10).
 *
 * Tenant-scoped throughout (P17): every staging/promote statement filters the
 * injected tenant; rows are STAMPED with `tenantId`/`branchId` (the source rows
 * carry no tenant of their own — scope comes from the device principal, R8/AD-8).
 * A run with no resolvable store scope (empty `branchId`) is rejected before any
 * write (the §A2 NOT-NULL staging contract).
 *
 * Idempotent full-replace: re-running with the same snapshot converges to
 * identical state (DELETE+INSERT, no dedupe) — SC-3. Duplicate barcodes are
 * preserved faithfully (FR-4 ambiguity block is the reader's job, not the
 * writer's — it must NOT collapse the conflict).
 *
 * DI'd `DatabaseHandle` + `CatalogueSyncStateRepo` so tests run on sql.js without
 * the native better-sqlite3 binding.
 */

import type { DatabaseHandle } from '../../db/client.js';
import { normalize } from '../normalize.js';
import type { CatalogueSyncStateRepo, CatalogueSyncOutcome } from '../catalogue-sync-state-repo.js';
import { mapSellableRow, type MappedRecord, type SellableCatalogRow } from './map-sellable-row.js';
import { validateRecord } from './validate-record.js';

/**
 * FR-9 / R-RISK-4 abort-threshold (the rejected FRACTION above which a run is
 * treated as a failed read-down rather than a skip-and-log).
 *
 * TODO(owner): abort-threshold value pending owner decision (R-RISK-4, S2 tuning
 * item). This 0.5 placeholder is CONSERVATIVE and NOT final — a run is failed
 * only when MORE THAN HALF the records are rejected (a strong signal of a
 * source-format break, not a handful of bad rows). The mechanism is implemented
 * and tested; the exact value is a deliberate placeholder. Do NOT treat this as
 * a ratified value.
 */
export const ABORT_THRESHOLD_REJECTED_FRACTION = 0.5;

export type ReadDownFailureCategory = 'no-store-scope' | 'threshold-exceeded' | 'db-error';

export interface ReadDownRunInput {
  /** Injected device-principal tenant scope (P17). */
  tenantId: string;
  /** Injected device-principal store/branch scope (NOT NULL in staging, §A2 D6). */
  branchId: string;
  /** Opaque backend snapshot/version id (provenance). */
  sourceSnapshotId: string | null;
  /** ISO-8601 UTC timestamp for this run (injected for determinism). */
  now: string;
  /** The fetched snapshot rows. */
  rows: SellableCatalogRow[];
}

export interface ReadDownRunResult {
  outcome: CatalogueSyncOutcome | 'failed';
  productsWritten: number;
  recordsRejected: number;
  failureCategory: ReadDownFailureCategory | null;
}

export interface CreateReadDownWriterDeps {
  db: DatabaseHandle;
  syncStateRepo: CatalogueSyncStateRepo;
}

/** Inputs for recording a transport-failed fetch (the driver's responsibility). */
export interface RecordFetchFailureInput {
  tenantId: string;
  branchId: string;
  /** ISO-8601 UTC timestamp of the failed attempt. */
  now: string;
}

export interface ReadDownWriter {
  run(input: ReadDownRunInput): ReadDownRunResult;
  /**
   * Record a FAILED fetch attempt (transport failure before any write). The
   * driver calls this when the client returns `no_connection` / `failed`: the
   * writer never runs, so the driver still needs the freshness clock to show a
   * failed attempt while `last_success_at` stays put (SC-10). Delegates to the
   * same diagnostics write `run()` uses for writer-side failures.
   */
  recordFetchFailure(input: RecordFetchFailureInput): void;
}

interface PrepareRun {
  run(...params: unknown[]): unknown;
}

// Explicit live/staging column lists (NOT `SELECT *`) so the promote INSERT…SELECT
// can never silently misalign if a future migration reorders columns.
const PRODUCT_COLUMNS = [
  'product_id',
  'tenant_id',
  'branch_id',
  'sku',
  'sku_norm',
  'name_ar',
  'name_en',
  'name_fold',
  'aliases_json',
  'alias_fold',
  'price_minor',
  'tax_category',
  'unit_pack_label',
  'active',
  'controlled_substance',
  'prescription_required',
  'row_version',
  'created_at',
  'updated_at',
] as const;

const BARCODE_COLUMNS = [
  'barcode_id',
  'product_id',
  'tenant_id',
  'barcode',
  'barcode_norm',
  'barcode_kind',
  'created_at',
] as const;

/**
 * R1 fold composition (verified against 009 `search.ts` — it LIKEs `name_fold`
 * and `alias_fold` as two separate columns, never concatenated):
 *   name_fold  = normalize(name_ar + ' ' + (name_en ?? ''))
 *   alias_fold = normalize(aliases.join(' '))  (null when no aliases)
 *   sku_norm / barcode_norm = normalize(raw value)
 */
function nameFold(nameAr: string, nameEn: string | null): string {
  return normalize(`${nameAr} ${nameEn ?? ''}`);
}

function aliasFold(aliasesJson: string | null): string | null {
  if (aliasesJson === null) return null;
  const aliases = JSON.parse(aliasesJson) as unknown;
  if (!Array.isArray(aliases) || aliases.length === 0) return null;
  return normalize((aliases as string[]).join(' '));
}

export function createReadDownWriter(deps: CreateReadDownWriterDeps): ReadDownWriter {
  const { db, syncStateRepo } = deps;

  function clearStaging(tenantId: string): void {
    (db.prepare('DELETE FROM products_staging WHERE tenant_id = ?') as PrepareRun).run(tenantId);
    (db.prepare('DELETE FROM product_barcodes_staging WHERE tenant_id = ?') as PrepareRun).run(
      tenantId,
    );
  }

  /**
   * Stage the full validated set in ONE transaction (#411 perf fix). The prior
   * per-row autocommit path issued ~2 INSERTs/row in autocommit mode (~100k
   * separate WAL commits at synchronous=FULL on a 50k snapshot), which blocked the
   * single shared main-thread connection for ~20 s — every barcode scan / lookup
   * froze behind it (T054 §A5, perf-bringup.md §6). Wrapping the loop in one
   * `db.transaction()` collapses those to a single commit (~20 s → ~1 s).
   *
   * Live tables are untouched here (staging only), so this does NOT affect FR-7
   * (the prior-catalogue-intact guarantee is a property of the promote tx alone —
   * the ONLY live-table writer). A throw mid-loop rolls back the whole staging tx;
   * `run()`'s outer catch still maps it to `failed` and `promote()` never runs, so
   * the observable outcome is unchanged (single-flight, single thread — no consumer
   * ever reads a half-populated staging). The two prepared statements are now
   * prepared ONCE (not per row) — a side win.
   */
  function stageAll(tenantId: string, branchId: string, recs: MappedRecord[]): void {
    const productStmt = db.prepare(`
      INSERT INTO products_staging (${PRODUCT_COLUMNS.join(', ')})
      VALUES (${PRODUCT_COLUMNS.map(() => '?').join(', ')})
    `) as PrepareRun;
    const barcodeStmt = db.prepare(`
      INSERT INTO product_barcodes_staging (${BARCODE_COLUMNS.join(', ')})
      VALUES (${BARCODE_COLUMNS.map(() => '?').join(', ')})
    `) as PrepareRun;

    const stageTx = db.transaction(() => {
      for (const rec of recs) {
        const p = rec.product;
        const fold = nameFold(p.name_ar, p.name_en);
        const aFold = aliasFold(p.aliases_json);
        const skuNorm = normalize(p.sku);
        productStmt.run(
          p.product_id,
          tenantId,
          branchId,
          p.sku,
          skuNorm,
          p.name_ar,
          p.name_en,
          fold,
          p.aliases_json,
          aFold,
          p.price_minor,
          p.tax_category,
          p.unit_pack_label,
          p.active,
          p.controlled_substance,
          p.prescription_required,
          p.row_version,
          p.created_at,
          p.updated_at,
        );

        // Explode the barcode records (duplicates preserved — no dedupe, FR-4).
        for (const b of rec.barcodes) {
          barcodeStmt.run(
            b.barcode_id,
            b.product_id,
            tenantId,
            b.barcode,
            normalize(b.barcode),
            b.barcode_kind,
            p.created_at,
          );
        }
      }
    });
    stageTx();
  }

  function promote(
    input: ReadDownRunInput,
    outcome: 'succeeded' | 'skipped_with_rejections',
  ): void {
    const { tenantId, branchId, sourceSnapshotId, now } = input;
    // Single transaction: DELETE live (tenant-scoped) + INSERT…SELECT from
    // staging + write freshness — all atomic. A throw rolls back the whole thing.
    const tx = db.transaction(() => {
      (db.prepare('DELETE FROM products WHERE tenant_id = ?') as PrepareRun).run(tenantId);
      (db.prepare('DELETE FROM product_barcodes WHERE tenant_id = ?') as PrepareRun).run(tenantId);
      (
        db.prepare(`
          INSERT INTO products (${PRODUCT_COLUMNS.join(', ')})
          SELECT ${PRODUCT_COLUMNS.join(', ')} FROM products_staging WHERE tenant_id = ?
        `) as PrepareRun
      ).run(tenantId);
      (
        db.prepare(`
          INSERT INTO product_barcodes (${BARCODE_COLUMNS.join(', ')})
          SELECT ${BARCODE_COLUMNS.join(', ')} FROM product_barcodes_staging WHERE tenant_id = ?
        `) as PrepareRun
      ).run(tenantId);
      // Clear staging INSIDE the same tx (atomic with the commit) so a successful
      // run leaves staging empty without any post-commit clear that could throw
      // and flip a committed promote to `failed`. The start-of-run clear already
      // guards leakage (data-model invariant 2); this keeps staging tidy too.
      (db.prepare('DELETE FROM products_staging WHERE tenant_id = ?') as PrepareRun).run(tenantId);
      (db.prepare('DELETE FROM product_barcodes_staging WHERE tenant_id = ?') as PrepareRun).run(
        tenantId,
      );
      // Freshness written INSIDE the tx (SC-10). `outcome` records whether the
      // promote was clean or dropped some rejected rows (FR-9), so the freshness
      // surface (FR-16) can tell them apart.
      syncStateRepo.recordSuccess({
        tenantId,
        branchId,
        lastSuccessAt: now,
        sourceSnapshotId,
        outcome,
      });
    });
    tx();
  }

  function recordFailure(input: ReadDownRunInput): void {
    // Diagnostics only — never advances last_success_at (SC-10). Best-effort:
    // a bookkeeping write failure must not mask the original failure.
    try {
      syncStateRepo.recordAttempt({
        tenantId: input.tenantId,
        branchId: input.branchId,
        lastAttemptAt: input.now,
        outcome: 'failed',
      });
    } catch {
      // swallow — the run/fetch is already failing; do not overwrite its cause.
    }
  }

  function run(input: ReadDownRunInput): ReadDownRunResult {
    // Reject a run with no resolvable store scope BEFORE any write (§A2 NOT NULL).
    if (input.tenantId.trim() === '' || input.branchId.trim() === '') {
      recordFailure(input);
      return {
        outcome: 'failed',
        productsWritten: 0,
        recordsRejected: 0,
        failureCategory: 'no-store-scope',
      };
    }

    try {
      // Step 1: clear staging at the START (no prior-run leakage).
      clearStaging(input.tenantId);

      // Step 2: map + validate; count mapping AND validation rejections uniformly.
      const validRecords: MappedRecord[] = [];
      let rejected = 0;
      for (const row of input.rows) {
        const mapped = mapSellableRow(row);
        if (!mapped.ok) {
          rejected += 1;
          continue;
        }
        const validated = validateRecord(mapped.value);
        if (!validated.ok) {
          rejected += 1;
          continue;
        }
        validRecords.push(validated.value);
      }

      // Step 3: abort-threshold (only meaningful when there were rows at all).
      const total = input.rows.length;
      if (total > 0 && rejected / total > ABORT_THRESHOLD_REJECTED_FRACTION) {
        recordFailure(input);
        return {
          outcome: 'failed',
          productsWritten: 0,
          recordsRejected: rejected,
          failureCategory: 'threshold-exceeded',
        };
      }

      // Step 4: stage the validated set (fold columns via normalize()) in ONE
      // transaction (#411 — collapses ~100k autocommit INSERTs to one commit).
      stageAll(input.tenantId, input.branchId, validRecords);

      // Step 5: promote atomically (DELETE live + INSERT…SELECT + freshness).
      // The committed outcome distinguishes a clean promote from one that dropped
      // some rejected rows (FR-9). Staging is NOT cleared after the promote: the
      // start-of-run clear (Step 1) already guarantees no leak (data-model
      // invariant 2), and clearing post-commit would risk flipping a committed
      // promote to `failed` in the outer catch if that clear ever threw.
      const outcome = rejected > 0 ? 'skipped_with_rejections' : 'succeeded';
      promote(input, outcome);

      return {
        outcome,
        productsWritten: validRecords.length,
        recordsRejected: rejected,
        failureCategory: null,
      };
    } catch {
      // Any DB error (incl. a rolled-back promote): the prior catalogue is
      // preserved by the transaction. Record the failure for diagnostics.
      recordFailure(input);
      return {
        outcome: 'failed',
        productsWritten: 0,
        recordsRejected: 0,
        failureCategory: 'db-error',
      };
    }
  }

  return { run, recordFetchFailure: recordFailure };
}
