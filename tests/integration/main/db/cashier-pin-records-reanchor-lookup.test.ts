import { describe, expect, it, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * 017-offline-pin-reanchor T040 — offline-unlock lookup survives the 0036 re-key.
 *
 * DESIGN (owner-decided 2026-06-14): the PK is provider-NEUTRAL (`user_id`,
 * migration 0036), but the OFFLINE cashier-unlock LOOKUP keys on the retained
 * `cashier_clerk_user_id` BRIDGE column — because at offline unlock the renderer
 * can only supply the cashier's Clerk id (`sign-in.tsx:131` → `cashier.id`);
 * `user_id` is main-side-only (Constitution VII) and there is no roster fetch
 * offline. So `CashierSignInHandler`'s `SELECT … WHERE … cashier_clerk_user_id = ?`
 * MUST keep working after 0036 demotes that column from PK to a non-key bridge.
 *
 * This corrects the merged spec §6 (line 126) / tasks T042 framing of "a migrated
 * row unlocks on user_id": post-OQ-D6-1-collapse there are no clerk-only legacy
 * rows, and the offline lookup cannot key on user_id from caller input. G-1
 * (remove provider lock-in from the *schema identity*) is satisfied by the
 * neutral PK; the runtime handle stays the bridge.
 *
 * This test pins that contract: a born-neutral row (as 019 writes it) remains
 * findable by the EXACT sign-in-handler SELECT shape after the full migration
 * chain — so no production change to that SELECT is required.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');

function sql(file: string): string {
  return readFileSync(path.join(REPO_ROOT, 'migrations', file), 'utf8');
}

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

/** Full chain through the 0036 re-key, mirroring the ordered runner. */
function migratedDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(sql('0006_cashier_pin_records.sql'));
  db.run(sql('0035_add_user_id_to_cashier_pin_records.sql'));
  db.run(sql('0036_reanchor_cashier_pin_records.sql'));
  return db;
}

/** Insert a born-neutral row exactly as 019's provision handler does. */
function seedBornNeutral(db: SqlJsDatabase): void {
  db.run(
    `INSERT INTO cashier_pin_records
       (tenant_id, branch_id, terminal_id, cashier_clerk_user_id, user_id,
        pin_hash, pin_salt, failed_attempt_count, lockout_until,
        created_at, created_by_operator_id)
     VALUES ('t', 'b', 'term', 'clerk-A', 'neutral-A', X'aabb', X'ccdd', 0, NULL,
             '2026-01-01T00:00:00.000Z', 'mgr')`,
  );
}

describe('017 T040 — offline-unlock lookup via the clerk bridge survives 0036', () => {
  it('the exact CashierSignInHandler SELECT (WHERE cashier_clerk_user_id = ?) finds a born-neutral row', () => {
    const db = migratedDb();
    seedBornNeutral(db);
    // The sign-in-handler SELECT (CashierSignInHandler.loadPinRow), keyed on
    // the demoted bridge column the renderer can supply offline. RT-113 P2
    // also reads user_id: it is the admission's `user_id`.
    const r = db.exec(
      `SELECT tenant_id, branch_id, terminal_id, cashier_clerk_user_id, user_id,
              pin_hash, pin_salt, failed_attempt_count, lockout_until
         FROM cashier_pin_records
        WHERE tenant_id='t' AND branch_id='b' AND terminal_id='term'
          AND cashier_clerk_user_id='clerk-A'`,
    );
    expect(r[0]?.values).toHaveLength(1);
    expect(r[0]?.values[0]?.[4]).toBe('neutral-A');
    db.close();
  });

  it('the row also carries its provider-neutral user_id (for audit / future use)', () => {
    const db = migratedDb();
    seedBornNeutral(db);
    const r = db.exec(
      `SELECT user_id FROM cashier_pin_records WHERE cashier_clerk_user_id='clerk-A'`,
    );
    expect(r[0]?.values[0]?.[0]).toBe('neutral-A');
    db.close();
  });

  it('the persistLockoutState UPDATE (WHERE cashier_clerk_user_id = ?) still targets the row', () => {
    const db = migratedDb();
    seedBornNeutral(db);
    db.run(
      `UPDATE cashier_pin_records
          SET failed_attempt_count = 2, lockout_until = '2026-03-03T03:03:03.000Z'
        WHERE tenant_id='t' AND branch_id='b' AND terminal_id='term'
          AND cashier_clerk_user_id='clerk-A'`,
    );
    const r = db.exec(
      `SELECT failed_attempt_count, lockout_until FROM cashier_pin_records WHERE cashier_clerk_user_id='clerk-A'`,
    );
    expect(r[0]?.values[0]?.[0]).toBe(2);
    expect(r[0]?.values[0]?.[1]).toBe('2026-03-03T03:03:03.000Z');
    db.close();
  });
});
