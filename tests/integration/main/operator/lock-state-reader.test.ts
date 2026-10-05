import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';
import {
  SessionManager,
  type CreateSessionInput,
} from '../../../../src/main/operator/session-manager.js';
import {
  createLockStateReader,
  createSafePointProbe,
} from '../../../../src/main/operator/lock-state-reader.js';
import { CashierAdmissionKeeper } from '../../../../src/main/operator/cashier-admission-keeper.js';
import {
  ADMITTED,
  FAKE_ADMISSION_ID,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';

/**
 * RT-117 (RT-116 §7.2) — `operator.getLockState()`: the only read served while
 * locked. It reports the preserved sale as TOTALS ONLY (line count, total,
 * applied tender, live-tender flag) for the lock screen — never line items,
 * names or credentials.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(dir, '..', '..', '..', '..');
const MIGRATIONS = [
  '0001_init.sql',
  '0002_secrets.sql',
  '0003_terminal_assignment.sql',
  '0004_audit_events.sql',
  '0005_operator_sessions.sql',
  '0006_cashier_pin_records.sql',
  '0007_shifts.sql',
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0015_create_payment_action_outbox.sql',
  '0016_payment_action_outbox_append_only_trigger.sql',
  '0017_extend_audit_event_categories.sql',
  '0018_audit_event_tender_reversal_pending.sql',
  '0019_extend_payment_failure_reason_enum.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

const NOW = '2026-10-01T10:00:00.000Z';
const TERMINAL = 'term-1';

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
afterEach(() => {
  db.close();
});

const CASHIER_ONE: CreateSessionInput = {
  operator_id: 'op-1',
  display_name: 'Cashier One',
  role: 'cashier',
  tenant_id: 't1',
  branch_id: 'b1',
  backend_session_id: '',
  started_at: NOW,
};

function signedIn(input: CreateSessionInput = CASHIER_ONE): SessionManager {
  const sm = new SessionManager();
  sm.create(input);
  return sm;
}

interface CartRow {
  cart_id: string;
  session_id: string;
  state: string;
  subtotal: number;
  created_at?: string;
}

function insertCart(row: CartRow): void {
  const at = row.created_at ?? NOW;
  db.run(
    `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
       operator_session_id, state, cart_subtotal_minor, created_at, updated_at)
     VALUES (?, 't1', 'b1', ?, 'op-1', ?, ?, ?, ?, ?)`,
    [row.cart_id, TERMINAL, row.session_id, row.state, row.subtotal, at, at],
  );
}

interface LineRow {
  line_id: string;
  cart_id: string;
  subtotal: number;
  removed?: boolean;
}

function insertLine(row: LineRow): void {
  db.run(
    `INSERT INTO cart_lines (line_id, cart_id, item_ref, display_name, quantity,
       unit_price_minor, line_subtotal_minor, last_action_id, created_at, updated_at, removed_at)
     VALUES (?, ?, 'SKU', 'Item', 1, ?, ?, 'a', ?, ?, ?)`,
    [row.line_id, row.cart_id, row.subtotal, row.subtotal, NOW, NOW, row.removed ? NOW : null],
  );
}

interface AttemptRow {
  id: string;
  session_id: string;
  cart_id: string;
}

function insertStartedAttempt(row: AttemptRow): void {
  db.run(
    `INSERT INTO payment_attempts (payment_attempt_id, tenant_id, branch_id, terminal_id,
       acting_operator_id, operator_session_id, envelope_handoff_action_id, envelope_cart_id,
       envelope_subtotal_minor, state, started_at, last_action_id)
     VALUES (?, 't1', 'b1', ?, 'op-1', ?, 'h1', ?, 2550, 'started', ?, 'a')`,
    [row.id, TERMINAL, row.session_id, row.cart_id, NOW],
  );
}

interface TenderRow {
  id: string;
  attempt: string;
  type: string;
  amount: number;
  state: string;
}

function insertTender(row: TenderRow): void {
  db.run(
    `INSERT INTO payment_tender_lines (tender_line_id, payment_attempt_id, tender_type,
       amount_applied_minor, state, attribution_operator_id, apply_order, last_action_id)
     VALUES (?, ?, ?, ?, ?, 'op-1', 1, 'a')`,
    [row.id, row.attempt, row.type, row.amount, row.state],
  );
}

function reader(sm: SessionManager) {
  return createLockStateReader({
    db: makeSqlJsHandle(db),
    sessionManager: sm,
    resolveTerminalId: () => TERMINAL,
  });
}

describe('RT-117 createLockStateReader', () => {
  it('reports signed_out with no summary when there is no session', () => {
    expect(reader(new SessionManager())()).toEqual({
      state: 'signed_out',
      locked_at: null,
      role: null,
      display_name: null,
      summary: null,
    });
  });

  it('reports the locked state, role and a null summary when there is no open cart', () => {
    const sm = signedIn();
    sm.lock('2026-10-01T10:10:00.000Z');

    expect(reader(sm)()).toEqual({
      state: 'locked',
      locked_at: '2026-10-01T10:10:00.000Z',
      role: 'cashier',
      display_name: 'Cashier One',
      summary: null,
    });
  });

  it('summarizes a draft cart as totals only (removed lines excluded)', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart({ cart_id: 'cart-1', session_id: sid, state: 'editing', subtotal: 5275 });
    insertLine({ line_id: 'l1', cart_id: 'cart-1', subtotal: 2000 });
    insertLine({ line_id: 'l2', cart_id: 'cart-1', subtotal: 725 });
    insertLine({ line_id: 'l3', cart_id: 'cart-1', subtotal: 2550 });
    insertLine({ line_id: 'l4', cart_id: 'cart-1', subtotal: 999, removed: true });
    sm.lock('2026-10-01T10:10:00.000Z');

    expect(reader(sm)().summary).toEqual({
      line_count: 3,
      total_minor: 5275,
      tender_applied_minor: 0,
      has_live_tender: false,
    });
  });

  it('includes applied tender and the live-tender flag for a handed-off cart', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart({ cart_id: 'cart-1', session_id: sid, state: 'frozen_handed_off', subtotal: 2550 });
    insertLine({ line_id: 'l1', cart_id: 'cart-1', subtotal: 2550 });
    insertStartedAttempt({ id: 'pa-1', session_id: sid, cart_id: 'cart-1' });
    insertTender({ id: 'tl-1', attempt: 'pa-1', type: 'cash', amount: 1000, state: 'applied' });
    insertTender({ id: 'tl-2', attempt: 'pa-1', type: 'cash', amount: 500, state: 'refused' });
    sm.lock('2026-10-01T10:10:00.000Z');

    expect(reader(sm)().summary).toEqual({
      line_count: 1,
      total_minor: 2550,
      tender_applied_minor: 1000,
      has_live_tender: true,
    });
  });

  it("ignores another session's cart", () => {
    const sm = signedIn();
    insertCart({
      cart_id: 'cart-other',
      session_id: 'some-other-session',
      state: 'editing',
      subtotal: 9999,
    });
    insertLine({ line_id: 'l1', cart_id: 'cart-other', subtotal: 9999 });

    expect(reader(sm)().summary).toBeNull();
  });

  it('ignores a cancelled cart', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart({ cart_id: 'cart-1', session_id: sid, state: 'cancelled', subtotal: 500 });

    expect(reader(sm)().summary).toBeNull();
  });

  // A settled sale keeps its cart `frozen_handed_off` (005 has no completed
  // state). Locking on the completion screen must not present that finished
  // sale as an open, preserved one.
  it('does not summarize a cart whose sale already settled', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart({
      cart_id: 'cart-done',
      session_id: sid,
      state: 'frozen_handed_off',
      subtotal: 2550,
    });
    insertLine({ line_id: 'l1', cart_id: 'cart-done', subtotal: 2550 });
    db.run(
      `INSERT INTO payment_attempts (payment_attempt_id, tenant_id, branch_id, terminal_id,
         acting_operator_id, operator_session_id, envelope_handoff_action_id, envelope_cart_id,
         envelope_subtotal_minor, state, started_at, settled_at, last_action_id)
       VALUES ('pa-done', 't1', 'b1', ?, 'op-1', ?, 'h1', 'cart-done', 2550, 'settled', ?, ?, 'a')`,
      [TERMINAL, sid, NOW, NOW],
    );

    expect(reader(sm)().summary).toBeNull();
  });

  it('does not summarize an empty cart', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart({ cart_id: 'cart-empty', session_id: sid, state: 'empty', subtotal: 0 });

    expect(reader(sm)().summary).toBeNull();
  });

  it('reports active for an unlocked session', () => {
    const sm = signedIn({ ...CASHIER_ONE, role: 'manager' });
    expect(reader(sm)()).toMatchObject({ state: 'active', locked_at: null, role: 'manager' });
  });
});

function probe(sm: SessionManager) {
  return createSafePointProbe({
    db: makeSqlJsHandle(db),
    sessionManager: sm,
    resolveTerminalId: () => TERMINAL,
  });
}

/** A handed-off cart of the session with a started payment attempt holding live tender. */
function handedOffWithLiveTender(sid: string, cart_id = 'cart-1', created_at = NOW): void {
  insertCart({ cart_id, session_id: sid, state: 'frozen_handed_off', subtotal: 2550, created_at });
  insertLine({ line_id: `${cart_id}-l1`, cart_id, subtotal: 2550 });
  insertStartedAttempt({ id: `${cart_id}-pa`, session_id: sid, cart_id });
  insertTender({
    id: `${cart_id}-tl`,
    attempt: `${cart_id}-pa`,
    type: 'cash',
    amount: 1000,
    state: 'applied',
  });
}

/**
 * RT-113 P2 (adversarial review of 024f07c, items 2 and 5) — the PRODUCTION
 * safe-point predicate that the cashier admission keeper ends a latched
 * session on. Ending is safe only when no open sale has lines AND no started
 * payment attempt of the session, on ANY cart, holds live tender.
 */
describe('RT-113 P2 createSafePointProbe', () => {
  it('no session, no cart, or only an empty cart: safe', () => {
    expect(probe(new SessionManager())()).toBe(true);
    const sm = signedIn();
    expect(probe(sm)()).toBe(true);
    insertCart({
      cart_id: 'cart-empty',
      session_id: sm.getCurrent()?.id ?? '',
      state: 'empty',
      subtotal: 0,
    });
    expect(probe(sm)()).toBe(true);
  });

  it('an open sale with lines: not safe', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart({ cart_id: 'cart-1', session_id: sid, state: 'editing', subtotal: 500 });
    insertLine({ line_id: 'l1', cart_id: 'cart-1', subtotal: 500 });
    expect(probe(sm)()).toBe(false);
  });

  it('a handed-off cart with live tender: not safe; once the attempt settles: safe', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    handedOffWithLiveTender(sid);
    expect(probe(sm)()).toBe(false);
    db.run(
      `UPDATE payment_attempts SET state = 'settled', settled_at = ? WHERE payment_attempt_id = 'cart-1-pa'`,
      [NOW],
    );
    expect(probe(sm)()).toBe(true);
  });

  it('item 5: a NEWER empty cart does not hide an older handed-off cart with live tender', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    handedOffWithLiveTender(sid, 'cart-old', '2026-10-01T10:00:00.000Z');
    insertCart({
      cart_id: 'cart-new',
      session_id: sid,
      state: 'empty',
      subtotal: 0,
      created_at: '2026-10-01T10:05:00.000Z',
    });
    // The live tender on the older cart keeps the session alive.
    expect(probe(sm)()).toBe(false);
  });

  it('Codex P1 4179918798: an older cart with active lines (no tender) plus a newer empty cart: not safe', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart({
      cart_id: 'cart-old',
      session_id: sid,
      state: 'frozen_handed_off',
      subtotal: 700,
      created_at: '2026-10-01T10:00:00.000Z',
    });
    insertLine({ line_id: 'l-old', cart_id: 'cart-old', subtotal: 700 });
    insertCart({
      cart_id: 'cart-new',
      session_id: sid,
      state: 'empty',
      subtotal: 0,
      created_at: '2026-10-01T10:05:00.000Z',
    });
    expect(probe(sm)()).toBe(false);
  });

  it('Codex P1 4179918798: every cart settled or cancelled (even with lines): safe', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    handedOffWithLiveTender(sid, 'cart-settled', '2026-10-01T10:00:00.000Z');
    db.run(
      `UPDATE payment_attempts SET state = 'settled', settled_at = ? WHERE payment_attempt_id = 'cart-settled-pa'`,
      [NOW],
    );
    insertCart({
      cart_id: 'cart-void',
      session_id: sid,
      state: 'cancelled',
      subtotal: 300,
      created_at: '2026-10-01T10:05:00.000Z',
    });
    insertLine({ line_id: 'l-void', cart_id: 'cart-void', subtotal: 300 });
    expect(probe(sm)()).toBe(true);
  });

  it('Codex P1 4179918798, lock screen: a newer empty cart does not hide the older open sale', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart({
      cart_id: 'cart-old',
      session_id: sid,
      state: 'editing',
      subtotal: 700,
      created_at: '2026-10-01T10:00:00.000Z',
    });
    insertLine({ line_id: 'l-old', cart_id: 'cart-old', subtotal: 700 });
    insertCart({
      cart_id: 'cart-new',
      session_id: sid,
      state: 'empty',
      subtotal: 0,
      created_at: '2026-10-01T10:05:00.000Z',
    });
    sm.lock('2026-10-01T10:10:00.000Z');
    expect(reader(sm)().summary).toEqual({
      line_count: 1,
      total_minor: 700,
      tender_applied_minor: 0,
      has_live_tender: false,
    });
  });

  it('live tender alone keeps the session alive, even when its cart no longer counts as an open sale', () => {
    // Defence in depth: the live-tender check stands on its own. A started
    // attempt still holding tender on a cart that reads cancelled must never
    // let the session end (cancel normally refuses while tender is live).
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart({ cart_id: 'cart-1', session_id: sid, state: 'cancelled', subtotal: 2550 });
    insertStartedAttempt({ id: 'pa-1', session_id: sid, cart_id: 'cart-1' });
    insertTender({
      id: 'tl-1',
      attempt: 'pa-1',
      type: 'external_card_terminal',
      amount: 2550,
      state: 'reversal_pending',
    });
    expect(probe(sm)()).toBe(false);
  });

  it("another session's live tender does not count", () => {
    const sm = signedIn();
    handedOffWithLiveTender('some-other-session');
    expect(probe(sm)()).toBe(true);
  });

  it('end to end with the real keeper: a latched session holding live tender does NOT end; it ends once the tender settles', async () => {
    vi.useFakeTimers();
    try {
      const sm = new SessionManager();
      const fake = fakeCashierAdmission({ ...ADMITTED, admission_ttl_seconds: 600 });
      const ends: (string | undefined)[] = [];
      sm.onEnded((_r, cause) => ends.push(cause));
      const keeper = new CashierAdmissionKeeper({
        sessionManager: sm,
        admission: fake.deps,
        isAtSafePoint: probe(sm),
      });
      const record = sm.create({
        ...CASHIER_ONE,
        cashier_admission: {
          user_id: FAKE_USER_ID,
          admission_id: FAKE_ADMISSION_ID,
          admission_ttl_seconds: 600,
          offline_grace_seconds: 86_400,
        },
      });
      handedOffWithLiveTender(record.id);

      fake.setAdmit({ kind: 'active_elsewhere' });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(sm.getCurrent()?.authority_latch).toBe('superseded_by_takeover');
      await vi.advanceTimersByTimeAsync(60_000); // many backstop re-checks
      expect(ends).toEqual([]);
      expect(sm.getCurrent()?.id).toBe(record.id);

      db.run(
        `UPDATE payment_attempts SET state = 'settled', settled_at = ? WHERE payment_attempt_id = 'cart-1-pa'`,
        [NOW],
      );
      keeper.recheckSafePoint();
      expect(ends).toEqual(['superseded_by_takeover']);
      keeper.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Codex P1 4179918798 — end to end: a latched session does not strand an older open sale', () => {
  it('older sale with lines plus a newer empty cart: no end until the older sale is voided', async () => {
    vi.useFakeTimers();
    try {
      const sm = new SessionManager();
      const fake = fakeCashierAdmission({ ...ADMITTED, admission_ttl_seconds: 600 });
      const ends: (string | undefined)[] = [];
      sm.onEnded((_r, cause) => ends.push(cause));
      const keeper = new CashierAdmissionKeeper({
        sessionManager: sm,
        admission: fake.deps,
        isAtSafePoint: probe(sm),
      });
      const record = sm.create({
        ...CASHIER_ONE,
        cashier_admission: {
          user_id: FAKE_USER_ID,
          admission_id: FAKE_ADMISSION_ID,
          admission_ttl_seconds: 600,
          offline_grace_seconds: 86_400,
        },
      });
      insertCart({
        cart_id: 'cart-old',
        session_id: record.id,
        state: 'editing',
        subtotal: 700,
        created_at: '2026-10-01T10:00:00.000Z',
      });
      insertLine({ line_id: 'l-old', cart_id: 'cart-old', subtotal: 700 });
      insertCart({
        cart_id: 'cart-new',
        session_id: record.id,
        state: 'empty',
        subtotal: 0,
        created_at: '2026-10-01T10:05:00.000Z',
      });

      fake.setAdmit({ kind: 'active_elsewhere' });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(sm.getCurrent()?.authority_latch).toBe('superseded_by_takeover');
      await vi.advanceTimersByTimeAsync(60_000); // many backstop re-checks
      expect(ends).toEqual([]);

      db.run(`UPDATE carts SET state = 'cancelled' WHERE cart_id = 'cart-old'`); // voided
      keeper.recheckSafePoint();
      expect(ends).toEqual(['superseded_by_takeover']);
      keeper.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
