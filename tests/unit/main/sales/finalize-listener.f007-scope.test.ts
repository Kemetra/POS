/**
 * #380 (F-007 FIXED) — AD-2 scan scope must match what 006 writes into
 * `audit_events.originating_terminal_id`.
 *
 * Post-#380, 006's `paymentsSessionAdapter` sources the payment attempt's
 * `terminal_id` from the pairing row's REAL terminal_id (via
 * `pairingStore.getCurrentTerminalId()`), NOT `session.branch_id`.
 * `payments-confirm` emits `payment.settled` with `originating_terminal_id =
 * row.terminal_id` — now the real terminal_id value.
 *
 * The AD-2 worker scans `WHERE originating_terminal_id = ?`. index.ts MUST
 * therefore scope the finalize-listener with the SAME real terminal_id
 * (`pairingStatus.terminal_id`), in lockstep with the adapter flip. If it
 * still scoped with branch_id (the pre-#380 F-007 shortcut), the scan would
 * match ZERO settled rows and finalize nothing — the same silent break, just
 * with the polarity reversed. Every unit fixture elsewhere uses a
 * self-consistent terminal_id, so this cross-component disagreement is
 * invisible to them.
 *
 * This test pins the seam with DISTINCT branch_id and terminal_id values:
 *   • Positive: scoping the listener with the REAL terminal_id (matching the
 *     post-#380 adapter) dispatches the settled row.
 *   • Negative: scoping with the branch_id value (the retired F-007
 *     shortcut) matches nothing — the regression this guards against.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFinalizeListener } from '../../../../src/main/sales/finalize-listener.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0004_audit_events.sql',
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

// DISTINCT identifiers — this is the whole point of the test.
const TENANT_ID = 'tenant-1';
const BRANCH_ID = 'branch-XYZ';
const REAL_TERMINAL_ID = 'terminal-ABC'; // pairing row's real terminal_id

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
});

/**
 * Seed a `payment.settled` audit row EXACTLY as 006 writes it POST-#380: the
 * `originating_terminal_id` column holds the REAL terminal_id value (sourced
 * from the pairing row), NOT branch_id.
 */
function seedSettledAs006Writes(handoff_action_id: string): void {
  const payload = JSON.stringify({
    handoff_action_id,
    payment_attempt_id: `pa-${handoff_action_id}`,
    cart_id: `cart-${handoff_action_id}`,
    settled_at: '2026-05-28T10:00:00.000Z',
  });
  db.run(
    `INSERT INTO audit_events (
       event_id, tenant_id, branch_id, originating_terminal_id, acting_operator_id,
       session_id, action_category, created_at, payload
     ) VALUES (?, ?, ?, ?, 'op-abc', 'sess-1', 'payment.settled', '2026-05-28T10:00:00.000Z', ?)`,
    [`evt-${handoff_action_id}`, TENANT_ID, BRANCH_ID, REAL_TERMINAL_ID, payload],
  );
}

describe('#380 — AD-2 scan scope alignment with 006 (F-007 fixed)', () => {
  it('dispatches when the listener is scoped with the REAL terminal_id (matches post-#380 006)', () => {
    seedSettledAs006Writes('handoff-1');
    const dispatched: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: TENANT_ID,
      branch_id: BRANCH_ID,
      // index.ts scopes with the real terminal_id (the value 006 now writes).
      terminal_id: REAL_TERMINAL_ID,
      dispatch: (handoff) => dispatched.push(handoff),
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:01.000Z',
    });
    listener.runTickOnce();
    expect(dispatched).toEqual(['handoff-1']);
  });

  it('matches NOTHING when scoped with branch_id (the retired F-007 shortcut)', () => {
    seedSettledAs006Writes('handoff-1');
    const dispatched: string[] = [];
    const listener = createFinalizeListener({
      db: makeSqlJsHandle(db),
      tenant_id: TENANT_ID,
      branch_id: BRANCH_ID,
      // The WRONG scope post-#380 — branch_id, which 006 no longer writes
      // into originating_terminal_id. Proves the lockstep flip is required.
      terminal_id: BRANCH_ID,
      dispatch: (handoff) => dispatched.push(handoff),
      tickIntervalMs: 200,
      now: () => '2026-05-28T10:00:01.000Z',
    });
    listener.runTickOnce();
    expect(dispatched).toEqual([]);
  });
});
