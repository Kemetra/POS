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
  admissionRefusal,
  createSessionAdmission,
  registerSupersededSessionSignOut,
} from '../../../../src/main/operator/session-admission.js';
import { bindSessionHasLiveTender } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { SessionEndCause } from '../../../../src/shared/operator/session-end-cause.js';

/**
 * RT-444 (RT-116 S3, §4) — the sign-in admission guard, one test per §4 cell,
 * plus end-before-create and the non-disclosing refusal.
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
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

const NOW = '2026-10-13T10:00:00.000Z';
const TERMINAL = 'term-1';
const OWNER = 'op-owner';
const OTHER_CASHIER = 'op-other-cashier';
const MANAGER = 'op-manager';
const SECRET_NAME = 'Owner Display Name';
const AMOUNT = 123_450;

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

function ownerSession(): CreateSessionInput {
  return {
    operator_id: OWNER,
    display_name: SECRET_NAME,
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    started_at: NOW,
  };
}

function insertCart(cart_id: string, session_id: string, state = 'editing'): void {
  db.run(
    `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
       operator_session_id, state, cart_subtotal_minor, created_at, updated_at)
     VALUES (?, 't1', 'b1', ?, ?, ?, ?, ?, ?, ?)`,
    [cart_id, TERMINAL, OWNER, session_id, state, AMOUNT, NOW, NOW],
  );
}

/** A started attempt by the owner; `tender` is its one line's state, or none. */
function insertStartedAttempt(session_id: string, tender: string | null): void {
  insertCart('cart-1', session_id, 'frozen_handed_off');
  db.run(
    `INSERT INTO payment_attempts (payment_attempt_id, tenant_id, branch_id, terminal_id,
       acting_operator_id, operator_session_id, envelope_handoff_action_id, envelope_cart_id,
       envelope_subtotal_minor, state, started_at, last_action_id)
     VALUES ('att-1', 't1', 'b1', ?, ?, ?, 'h1', 'cart-1', ?, 'started', ?, 'a')`,
    [TERMINAL, OWNER, session_id, AMOUNT, NOW],
  );
  if (tender === null) return;
  db.run(
    `INSERT INTO payment_tender_lines (tender_line_id, payment_attempt_id, tender_type,
       amount_applied_minor, state, attribution_operator_id, apply_order, last_action_id)
     VALUES ('tl-1', 'att-1', 'cash', ?, ?, ?, 1, 'a')`,
    [AMOUNT, tender, OWNER],
  );
}

interface Harness {
  sm: SessionManager;
  admission: ReturnType<typeof createSessionAdmission>;
  audit: AuditEvent[];
  logs: unknown[];
  ends: { session_id: string; cause: SessionEndCause | undefined }[];
}

function harness(sm = new SessionManager()): Harness {
  const audit: AuditEvent[] = [];
  const logs: unknown[] = [];
  const ends: Harness['ends'] = [];
  sm.onEnded((record, cause) => {
    ends.push({ session_id: record.id, cause });
  });
  const admission = createSessionAdmission({
    db: makeSqlJsHandle(db),
    sessionManager: sm,
    resolveTerminalId: () => TERMINAL,
    auditEmitter: {
      emit: (event) => {
        audit.push(event);
      },
    },
    logger: {
      info: (...args: unknown[]) => {
        logs.push(args);
      },
      error: vi.fn(),
    },
    uuid: () => 'evt-1',
    clock: () => new Date(NOW),
  });
  return { sm, admission, audit, logs, ends };
}

/** The owner signed in, then locked. */
function lockedOwner(): Harness {
  const h = harness();
  h.sm.create(ownerSession());
  h.sm.lock(NOW);
  return h;
}

/** The role each test operator signs in with. */
function who(operator_id: string): { operator_id: string; role: 'cashier' | 'manager' } {
  return { operator_id, role: operator_id === MANAGER ? 'manager' : 'cashier' };
}

const CANDIDATES = [
  ['another cashier', OTHER_CASHIER],
  ['another manager', MANAGER],
] as const;

describe('RT-444 §4 — terminal holds nothing', () => {
  it.each([['the owner', OWNER], ...CANDIDATES])('admits %s', (_label, operator_id) => {
    const h = harness();
    expect(h.admission.admit(who(operator_id))).toEqual({ kind: 'admitted' });
    expect(h.ends).toEqual([]);
  });
});

describe('RT-444 §4 — held carts only, or zero funds', () => {
  it.each([['the owner', OWNER], ...CANDIDATES])(
    'held drafts never block: admits %s',
    (_label, operator_id) => {
      insertCart('held-1', 'dead-session');
      expect(harness().admission.admit(who(operator_id))).toEqual({ kind: 'admitted' });
    },
  );

  it.each([['the owner', OWNER], ...CANDIDATES])(
    'a started attempt with no tender is not live tender: admits %s',
    (_label, operator_id) => {
      insertStartedAttempt('dead-session', null);
      expect(harness().admission.admit(who(operator_id))).toEqual({ kind: 'admitted' });
    },
  );

  it.each(['reversed', 'refused'])(
    'a %s line is not live tender: admits another cashier',
    (state) => {
      insertStartedAttempt('dead-session', state);
      const verdict = harness().admission.admit(who(OTHER_CASHIER));
      expect(verdict).toEqual({ kind: 'admitted' });
    },
  );
});

describe('RT-444 §4 — locked session of another operator, no live tender', () => {
  it.each(CANDIDATES)(
    'admits %s and ends the locked session superseded_at_lock first',
    (_label, operator_id) => {
      const h = lockedOwner();
      const locked = h.sm.getCurrent();
      insertCart('draft-1', locked?.id ?? '');

      expect(h.admission.admit(who(operator_id))).toEqual({ kind: 'admitted' });
      expect(h.ends).toEqual([{ session_id: locked?.id, cause: 'superseded_at_lock' }]);
      expect(h.sm.getCurrent()).toBeNull();
      expect(h.sm.getLastEndCause()).toBe('superseded_at_lock');
    },
  );

  it('the read-only check never ends the locked session', () => {
    const h = lockedOwner();
    expect(h.admission.check(who(OTHER_CASHIER))).toEqual({ kind: 'admitted' });
    expect(h.ends).toEqual([]);
    expect(h.sm.getCurrent()?.lock_state).toBe('locked');
  });

  it('end() precedes the create() that follows, with onEnded before onStarted', () => {
    const h = lockedOwner();
    const order: string[] = [];
    h.sm.onEnded((_r, cause) => order.push(`ended:${String(cause)}`));
    h.sm.onStarted((r) => order.push(`started:${r.operator_id}`));

    h.admission.admit(who(OTHER_CASHIER));
    h.sm.create({ ...ownerSession(), operator_id: OTHER_CASHIER });

    expect(order).toEqual(['ended:superseded_at_lock', `started:${OTHER_CASHIER}`]);
  });
});

describe('RT-444 §4 — locked session of another operator WITH live tender', () => {
  it('refuses another cashier and leaves the locked session untouched', () => {
    const h = lockedOwner();
    const locked = h.sm.getCurrent();
    insertStartedAttempt(locked?.id ?? '', 'applied');

    expect(h.admission.admit(who(OTHER_CASHIER))).toEqual({
      kind: 'refused',
      refusal: { kind: 'refused', category: 'terminal_has_unresolved_payment' },
    });
    expect(h.ends).toEqual([]);
    expect(h.sm.getCurrent()).toBe(locked);
    expect(h.sm.getCurrent()?.lock_state).toBe('locked');
  });

  it('RT-441: admits another manager in recovery mode for that payment, ending the lock first', () => {
    const h = lockedOwner();
    const locked = h.sm.getCurrent();
    insertStartedAttempt(locked?.id ?? '', 'applied');

    expect(h.admission.admit(who(MANAGER))).toEqual({ kind: 'admitted', recovery_of: 'att-1' });
    expect(h.ends).toEqual([{ session_id: locked?.id, cause: 'superseded_at_lock' }]);
    expect(h.audit).toEqual([]);
  });

  it.each(['applying', 'applied', 'reversal_pending'])('%s counts as live tender', (state) => {
    const h = lockedOwner();
    insertStartedAttempt(h.sm.getCurrent()?.id ?? '', state);
    expect(h.admission.check(who(OTHER_CASHIER)).kind).toBe('refused');
  });
});

describe('RT-444 §4 — stuck attempt (its session already ended)', () => {
  it('admits the owner (re-attach and resume are S5)', () => {
    insertStartedAttempt('dead-session', 'applied');
    expect(harness().admission.admit(who(OWNER))).toEqual({ kind: 'admitted' });
  });

  it('refuses another cashier', () => {
    insertStartedAttempt('dead-session', 'applied');
    expect(harness().admission.admit(who(OTHER_CASHIER)).kind).toBe('refused');
  });

  it('RT-441: admits another manager in recovery mode only', () => {
    insertStartedAttempt('dead-session', 'applied');
    expect(harness().admission.admit(who(MANAGER))).toEqual({
      kind: 'admitted',
      recovery_of: 'att-1',
    });
  });

  it('the owner signing in over their own locked session is admitted; the session ends first', () => {
    const h = lockedOwner();
    insertStartedAttempt(h.sm.getCurrent()?.id ?? '', 'applied');
    expect(h.admission.admit(who(OWNER))).toEqual({ kind: 'admitted' });
    expect(h.ends.map((e) => e.cause)).toEqual(['superseded_at_lock']);
  });
});

describe('RT-444 — an ACTIVE session is never silently replaced (M15)', () => {
  it('refuses state_invalid and ends nothing', () => {
    const h = harness();
    h.sm.create(ownerSession());
    expect(h.admission.admit(who(OTHER_CASHIER))).toEqual({
      kind: 'refused',
      refusal: { kind: 'refused', category: 'state_invalid' },
    });
    expect(h.ends).toEqual([]);
    expect(h.audit).toEqual([]);
  });
});

describe('RT-444 — the refusal discloses nothing (FR-013)', () => {
  it('audits operator.signin.refused_unresolved_payment with an empty payload', () => {
    const h = lockedOwner();
    insertStartedAttempt(h.sm.getCurrent()?.id ?? '', 'applied');
    h.admission.check(who(OTHER_CASHIER));

    expect(h.audit).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: 't1',
        branch_id: 'b1',
        originating_terminal_id: TERMINAL,
        acting_operator_id: OTHER_CASHIER,
        session_id: null,
        shift_id: null,
        action_category: 'operator.signin.refused_unresolved_payment',
        created_at: NOW,
        approving_supervisor_id: null,
        payload: {},
      },
    ]);
  });

  it('names neither the owner nor the amount in the response or the log', () => {
    const h = lockedOwner();
    insertStartedAttempt(h.sm.getCurrent()?.id ?? '', 'applied');
    const verdict = h.admission.admit(who(OTHER_CASHIER));
    const said = JSON.stringify([verdict, h.logs]);
    for (const secret of [OWNER, SECRET_NAME, String(AMOUNT), '1,234.50', 'att-1']) {
      expect(said).not.toContain(secret);
    }
  });

  it('an audit failure never turns the refusal into an admission', () => {
    const sm = new SessionManager();
    insertStartedAttempt('dead-session', 'applied');
    const admission = createSessionAdmission({
      db: makeSqlJsHandle(db),
      sessionManager: sm,
      resolveTerminalId: () => TERMINAL,
      auditEmitter: {
        emit: () => {
          throw new Error('disk full');
        },
      },
    });
    expect(admission.admit(who(OTHER_CASHIER)).kind).toBe('refused');
  });
});

describe('RT-444 — unpaired terminal and the call-site seam', () => {
  it('an unpaired terminal has no attempts to check: admits', () => {
    insertStartedAttempt('dead-session', 'applied');
    const admission = createSessionAdmission({
      db: makeSqlJsHandle(db),
      sessionManager: new SessionManager(),
      resolveTerminalId: () => null,
      auditEmitter: { emit: vi.fn() },
    });
    expect(admission.check(who(OTHER_CASHIER))).toEqual({ kind: 'admitted' });
  });

  it('admissionRefusal returns the refusal, null when admitted, null without a guard', () => {
    insertStartedAttempt('dead-session', 'applied');
    const { admission } = harness();
    expect(admissionRefusal(admission, 'check', who(OTHER_CASHIER))).toEqual({
      kind: 'refused',
      category: 'terminal_has_unresolved_payment',
    });
    expect(admissionRefusal(admission, 'check', who(OWNER))).toBeNull();
    expect(admissionRefusal(undefined, 'admit', who(OTHER_CASHIER))).toBeNull();
  });
});

describe('RT-444 §3.4 — bindSessionHasLiveTender', () => {
  it.each([
    ['applied', true],
    ['applying', true],
    ['reversal_pending', true],
    ['reversed', false],
    ['refused', false],
  ])('a %s line → %s', (state, expected) => {
    insertStartedAttempt('sess-1', state);
    expect(bindSessionHasLiveTender(makeSqlJsHandle(db))('sess-1')).toBe(expected);
  });

  it('only for that session, and only for a started attempt', () => {
    insertStartedAttempt('sess-1', 'applied');
    const has = bindSessionHasLiveTender(makeSqlJsHandle(db));
    expect(has('sess-2')).toBe(false);
    db.run(`UPDATE payment_attempts SET state = 'settled' WHERE payment_attempt_id = 'att-1'`);
    expect(has('sess-1')).toBe(false);
  });
});

describe('RT-444 §3.3 — a superseded manager session signs out of the backend', () => {
  function wired(jwt: string | null) {
    const sm = new SessionManager();
    const signOut = vi.fn(() => Promise.resolve({ kind: 'signed_out' as const }));
    const clearCredentials = vi.fn();
    registerSupersededSessionSignOut({
      sessionManager: sm,
      backend: { signOut },
      jwtFor: () => jwt,
      clearCredentials,
    });
    return { sm, signOut, clearCredentials };
  }

  const manager: CreateSessionInput = {
    ...ownerSession(),
    operator_id: MANAGER,
    role: 'manager',
    backend_session_id: 'bs-1',
  };

  it('signs the backend session out and clears its credentials', () => {
    const { sm, signOut, clearCredentials } = wired('jwt-1');
    sm.create(manager);
    sm.end('superseded_at_lock');
    expect(clearCredentials).toHaveBeenCalledWith('bs-1');
    expect(signOut).toHaveBeenCalledWith({ session_id: 'bs-1' }, 'jwt-1');
  });

  it.each<SessionEndCause | undefined>([undefined, 'superseded_by_takeover'])(
    'leaves other ends to their own paths (%s)',
    (cause) => {
      const { sm, signOut, clearCredentials } = wired('jwt-1');
      sm.create(manager);
      sm.end(cause);
      expect(signOut).not.toHaveBeenCalled();
      expect(clearCredentials).not.toHaveBeenCalled();
    },
  );

  it('a cashier session has no backend session to sign out', () => {
    const { sm, signOut } = wired('jwt-1');
    sm.create(ownerSession());
    sm.end('superseded_at_lock');
    expect(signOut).not.toHaveBeenCalled();
  });
});
