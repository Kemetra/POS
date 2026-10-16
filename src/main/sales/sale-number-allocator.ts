/**
 * T085 — 008 Slice 1b AD-7 sale-number allocator.
 *
 * Per spec §FR-010 + plan §AD-7 + data-model.md §"Entity: SaleNumberSequences"
 * + `visual-direction/README.md` (a) composition decision #4.
 *
 * Allocates the canonical sale-number string for a given
 * (terminal_id, terminal_label, local_calendar_day) tuple:
 *
 *   sale_number = `<terminal_label>-<YYYY-MM-DD>-<NNNNNN>`
 *
 *   • `<terminal_label>` is embedded verbatim. The caller is responsible for
 *     having validated the label against `^[A-Z0-9-]{1,16}$` at terminal-
 *     pairing time (002). No runtime regex check here — trust internal
 *     code, validate at boundaries (Constitution + CLAUDE.md).
 *   • `<YYYY-MM-DD>` is passed in by the caller. RT-551: AD-2 finalize
 *     derives it as the store business day (Africa/Cairo) of `finalized_at`
 *     (`sale-number-day-rule.ts`). It is also the counter key, so a sale
 *     number's date always equals its counter row's day.
 *   • `<NNNNNN>` is the per-terminal per-day monotonic counter, zero-
 *     padded to 6 digits.
 *
 * **Caller contract:** the allocator MUST run inside an outer transaction
 * (the AD-2 atomic finalize transaction). The allocator does NOT open its
 * own BEGIN/COMMIT — that would break the rollback-safety guarantee
 * (see T043). SQLite's UPSERT semantics + the composite primary key on
 * (terminal_id, calendar_day_local) make the increment atomic within the
 * caller's transaction.
 *
 * Pattern mirrors `src/main/payments/repositories/payment-attempts.repository.ts`
 * (006 S3a T111) — narrow `DatabaseHandle` interface adapter; no business
 * logic beyond the UPSERT-and-increment + the format-string composition.
 */

import type { DatabaseHandle } from '../db/client.js';

// Narrow better-sqlite3 surfaces (R1: no native binding required at test time).
interface PrepareRun {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

export interface AllocateSaleNumberInput {
  terminal_id: string;
  /** Human-readable label, embedded verbatim into the sale_number string. */
  terminal_label: string;
  /** Sale-number day, `YYYY-MM-DD`: the counter key and the embedded date (RT-551). */
  local_calendar_day: string;
}

export interface SaleNumberAllocator {
  /**
   * Allocate the next sale-number for the given key.
   *
   * **Must be called inside an outer transaction.** The caller (AD-2
   * finalize) opens BEGIN, calls allocate(), persists the Sale row, and
   * commits or rolls back the whole bundle as one unit. A rollback also
   * reverts this allocation, leaving the sequence-table row as-was.
   */
  allocate(input: AllocateSaleNumberInput): string;
}

/**
 * Pad a positive integer to a 6-digit zero-padded string.
 *
 * For values ≥ 1_000_000, the natural string representation is returned
 * unchanged. The schema CHECK on `next_sequence >= 1` is the lower bound;
 * the upper bound is unconstrained (operational reality: a single terminal
 * issuing > 999,999 sales in one day would be a degenerate event worth
 * an incident report, not a runtime crash).
 */
function pad6(value: number): string {
  return String(value).padStart(6, '0');
}

/**
 * Compose the canonical sale-number string from the three components.
 */
function composeSaleNumber(
  terminal_label: string,
  local_calendar_day: string,
  sequence: number,
): string {
  return `${terminal_label}-${local_calendar_day}-${pad6(sequence)}`;
}

/**
 * Bind the allocator to a `DatabaseHandle`. Returns an object exposing
 * the `allocate` method; production wiring binds to the real
 * better-sqlite3 handle, tests bind to the sql.js adapter.
 *
 * The SQL flow is:
 *
 *   1. UPSERT-and-increment via `INSERT … ON CONFLICT … DO UPDATE`.
 *      • Inserts (terminal_id, calendar_day_local, 1, now) if the row
 *        doesn't exist (next_sequence = 1 → first allocation issues
 *        sequence 1, then sets next_sequence to 2 in the same UPSERT).
 *      • Updates next_sequence = next_sequence + 1 if the row already
 *        exists.
 *   2. RETURNING captures the post-write next_sequence value.
 *   3. The allocated number is `next_sequence - 1` (the value that was
 *      effectively "just used"; what's left in the table is the NEXT
 *      value to allocate).
 *
 * SQLite's transaction-level isolation guarantees atomicity within the
 * outer transaction the caller has opened.
 */
export function bindSaleNumberAllocator(db: DatabaseHandle): SaleNumberAllocator {
  return {
    allocate(input: AllocateSaleNumberInput): string {
      const upsertStmt = db.prepare(
        `INSERT INTO sale_number_sequences
           (terminal_id, calendar_day_local, next_sequence, updated_at)
         VALUES (?, ?, 2, ?)
         ON CONFLICT (terminal_id, calendar_day_local) DO UPDATE
           SET next_sequence = next_sequence + 1,
               updated_at = excluded.updated_at`,
      ) as PrepareRun;

      const nowIso = new Date().toISOString();
      upsertStmt.run(input.terminal_id, input.local_calendar_day, nowIso);

      const readStmt = db.prepare(
        `SELECT next_sequence
           FROM sale_number_sequences
          WHERE terminal_id = ?
            AND calendar_day_local = ?`,
      ) as PrepareGet<{ next_sequence: number }>;

      const row = readStmt.get(input.terminal_id, input.local_calendar_day);
      /* c8 ignore start — defensive branch genuinely unreachable. The
       * UPSERT above guarantees the row exists before the SELECT runs;
       * the only way `row === undefined` could fire is a database that
       * has lost durability between two synchronous statements in the
       * same transaction, which violates SQLite's transactional model.
       * Kept as a runtime guard rather than removed so a future schema
       * change that breaks the invariant fails loudly instead of
       * silently composing a malformed sale_number string. */
      if (row === undefined) {
        throw new Error(
          `sale_number_sequences row missing after UPSERT for ` +
            `(${input.terminal_id}, ${input.local_calendar_day})`,
        );
      }
      /* c8 ignore stop */

      // The allocated number is the value we just consumed: next_sequence - 1.
      // The UPSERT either inserted with next_sequence=2 (meaning we
      // allocated sequence 1) or incremented from N to N+1 (meaning we
      // allocated sequence N).
      const allocatedSequence = row.next_sequence - 1;
      return composeSaleNumber(input.terminal_label, input.local_calendar_day, allocatedSequence);
    },
  };
}
