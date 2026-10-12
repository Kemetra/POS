import { describe, expect, it, beforeAll, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CashierPinStatusHandler } from '../cashier-pin-status-handler.js';
import type { CashierPinStatusHandlerDeps } from '../cashier-pin-status-handler.js';
import type { CashierRosterResult } from '../cashier-admission-client.js';
import type { OperatorSessionRecord } from '../session-manager.js';
import type { DatabaseHandle } from '../../db/client.js';
import type { PairingStatus } from '../../../shared/pairing-types.js';

/**
 * RT-424 (D-M1, docs/design/vnext/19-d-m1-cashier-pin-status.md §2) — the
 * manager-only PIN-status read behind the Cashiers screen.
 *
 * Real schema: migrations 0006 + 0035 + 0036 on sql.js, so the nullable
 * `cashier_clerk_user_id` bridge column and the `user_id` PK are the ones
 * production runs on.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0006_cashier_pin_records.sql',
  '0035_add_user_id_to_cashier_pin_records.sql',
  '0036_reanchor_cashier_pin_records.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  return db;
}

function bindHandle(db: SqlJsDatabase): DatabaseHandle {
  return {
    pragma: () => undefined,
    exec: (sql: string) => db.run(sql),
    transaction: <T extends (...args: never[]) => unknown>(fn: T): T => fn,
    close: () => undefined,
    prepare(sql: string) {
      return {
        get(...params: unknown[]): Record<string, unknown> | undefined {
          const stmt = db.prepare(sql);
          stmt.bind(params as NonNullable<Parameters<typeof stmt.bind>[0]>);
          const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : undefined;
          stmt.free();
          return row;
        },
      };
    },
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-10-12T10:00:00.000Z');
const SCOPE = { tenant_id: 'tenant-1', branch_id: 'branch-1', terminal_id: 'terminal-001' };

function paired(): PairingStatus {
  return { kind: 'paired', ...SCOPE, terminal_label: 'Terminal 1', paired_at: 0 };
}

function session(overrides: Partial<OperatorSessionRecord> = {}): OperatorSessionRecord {
  return {
    id: 'session-mgr-1',
    operator_id: 'mgr-operator-1',
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: SCOPE.tenant_id,
    branch_id: SCOPE.branch_id,
    backend_session_id: 'bsess-1',
    started_at: '2026-10-12T08:00:00.000Z',
    last_activity_at: '2026-10-12T08:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
    ...overrides,
  };
}

interface Cashier {
  operator_id: string;
  user_id: string;
  display_name: string;
}

const NO_PIN: Cashier = { operator_id: 'op-a', user_id: 'uid-a', display_name: 'Amal' };
const READY: Cashier = { operator_id: 'op-b', user_id: 'uid-b', display_name: 'Basma' };
const FAILING: Cashier = { operator_id: 'op-c', user_id: 'uid-c', display_name: 'Camilia' };
const LOCKED: Cashier = { operator_id: 'op-d', user_id: 'uid-d', display_name: 'Dalia' };
const EXPIRED: Cashier = { operator_id: 'op-e', user_id: 'uid-e', display_name: 'Eman' };

function roster(...cashiers: Cashier[]): CashierRosterResult {
  return { kind: 'roster', cashiers };
}

interface PinRow {
  user_id: string;
  cashier_clerk_user_id: string | null;
  failed_attempt_count?: number;
  lockout_until?: string | null;
  terminal_id?: string;
  tenant_id?: string;
}

function insertPin(db: SqlJsDatabase, row: PinRow): void {
  db.run(
    `INSERT INTO cashier_pin_records
       (tenant_id, branch_id, terminal_id, user_id, cashier_clerk_user_id,
        pin_hash, pin_salt, failed_attempt_count, lockout_until,
        created_at, created_by_operator_id)
     VALUES (?, ?, ?, ?, ?, X'00', X'00', ?, ?, '2026-10-01T00:00:00.000Z', 'mgr')`,
    [
      row.tenant_id ?? SCOPE.tenant_id,
      SCOPE.branch_id,
      row.terminal_id ?? SCOPE.terminal_id,
      row.user_id,
      row.cashier_clerk_user_id,
      row.failed_attempt_count ?? 0,
      row.lockout_until ?? null,
    ],
  );
}

function pinFor(c: Cashier, extra: Partial<PinRow> = {}): PinRow {
  return { user_id: c.user_id, cashier_clerk_user_id: c.operator_id, ...extra };
}

/** The five states of doc 19 §2 rule 4, each in scope on this terminal. */
function seedAllStates(db: SqlJsDatabase): void {
  insertPin(db, pinFor(READY));
  insertPin(db, pinFor(FAILING, { failed_attempt_count: 4 }));
  insertPin(
    db,
    pinFor(LOCKED, { failed_attempt_count: 5, lockout_until: '2026-10-12T10:04:00.000Z' }),
  );
  insertPin(
    db,
    pinFor(EXPIRED, { failed_attempt_count: 5, lockout_until: '2026-10-12T09:59:59.000Z' }),
  );
}

interface Harness {
  handler: CashierPinStatusHandler;
  listRoster: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
}

function makeHandler(opts: {
  db?: SqlJsDatabase;
  current?: () => OperatorSessionRecord | null;
  rosterResult?: CashierRosterResult | (() => Promise<CashierRosterResult>);
  pairing?: () => Promise<PairingStatus>;
}): Harness {
  const db = opts.db ?? freshDb();
  const rosterResult = opts.rosterResult ?? roster(NO_PIN, READY, FAILING, LOCKED, EXPIRED);
  const listRoster = vi.fn(
    typeof rosterResult === 'function' ? rosterResult : () => Promise.resolve(rosterResult),
  );
  const getStatus = vi.fn(opts.pairing ?? (() => Promise.resolve(paired())));
  const info = vi.fn();
  const current = opts.current ?? (() => session());
  const deps: CashierPinStatusHandlerDeps = {
    db: bindHandle(db),
    sessionManager: { getCurrent: current },
    pairingStore: { getStatus },
    cashierAdmissions: { listRoster },
    nowMs: () => NOW_MS,
    logger: { info },
  };
  return { handler: new CashierPinStatusHandler(deps), listRoster, getStatus, info };
}

// ─── Role gate and scope ─────────────────────────────────────────────────────

describe('RT-424 listCashierPinStatus — role gate first (AD-1)', () => {
  it('a cashier session is refused role_mismatch before any read', async () => {
    const h = makeHandler({ current: () => session({ role: 'cashier' }) });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'refused',
      category: 'role_mismatch',
    });
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.listRoster).not.toHaveBeenCalled();
  });

  it('no session is refused not_signed_in before any read', async () => {
    const h = makeHandler({ current: () => null });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    expect(h.listRoster).not.toHaveBeenCalled();
  });

  it.each(['manager', 'admin'] as const)('a %s session is served', async (role) => {
    const h = makeHandler({ current: () => session({ role }) });
    const res = await h.handler.listCashierPinStatus();
    expect(res.kind).toBe('cashiers');
  });

  it('an unpaired terminal is refused invalid_input and never fetches the roster', async () => {
    const h = makeHandler({ pairing: () => Promise.resolve({ kind: 'unpaired' }) });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
    expect(h.listRoster).not.toHaveBeenCalled();
  });
});

// ─── Roster outcomes ─────────────────────────────────────────────────────────

describe('RT-424 listCashierPinStatus — device roster outcomes', () => {
  it.each([
    [{ kind: 'no_connection' } as const, 'no_connection'],
    [{ kind: 'unavailable' } as const, 'no_connection'],
    [{ kind: 'rejected' } as const, 'invalid_input'],
    [{ kind: 'device_unauthorized' } as const, 'invalid_input'],
    [{ kind: 'no_token' } as const, 'invalid_input'],
  ])('%o → %s', async (rosterResult, category) => {
    const h = makeHandler({ rosterResult });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'refused',
      category,
    });
  });

  it('an empty roster is an empty list, not a refusal', async () => {
    const h = makeHandler({ rosterResult: roster() });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'cashiers',
      cashiers: [],
    });
  });
});

// ─── States (doc 19 §2 rule 4) ───────────────────────────────────────────────

describe('RT-424 listCashierPinStatus — state per roster entry', () => {
  it('derives no_pin / ready / locked in roster order', async () => {
    const db = freshDb();
    seedAllStates(db);
    const h = makeHandler({ db });

    const res = await h.handler.listCashierPinStatus();

    expect(res).toEqual({
      kind: 'cashiers',
      cashiers: [
        { id: 'op-a', display_name: 'Amal', pin: 'no_pin' },
        { id: 'op-b', display_name: 'Basma', pin: 'ready' },
        // 1–4 failures with no lockout still sign in.
        { id: 'op-c', display_name: 'Camilia', pin: 'ready' },
        {
          id: 'op-d',
          display_name: 'Dalia',
          pin: 'locked',
          locked_until: '2026-10-12T10:04:00.000Z',
        },
        // A lockout ends on its own: lockout_until <= now reads as ready.
        { id: 'op-e', display_name: 'Eman', pin: 'ready' },
      ],
    });
  });

  it('a lockout ending exactly now is ready (locked means lockout_until > now)', async () => {
    const db = freshDb();
    insertPin(db, pinFor(LOCKED, { lockout_until: new Date(NOW_MS).toISOString() }));
    const h = makeHandler({ db, rosterResult: roster(LOCKED) });
    const res = await h.handler.listCashierPinStatus();
    expect(res).toEqual({
      kind: 'cashiers',
      cashiers: [{ id: 'op-d', display_name: 'Dalia', pin: 'ready' }],
    });
  });

  it('locked_until is present only on a locked row', async () => {
    const db = freshDb();
    seedAllStates(db);
    const h = makeHandler({ db });
    const res = await h.handler.listCashierPinStatus();
    if (res.kind !== 'cashiers') throw new Error('expected cashiers');
    for (const c of res.cashiers) {
      expect('locked_until' in c).toBe(c.pin === 'locked');
    }
  });

  it("another terminal's or tenant's row never matches (scope isolation)", async () => {
    const db = freshDb();
    insertPin(db, pinFor(NO_PIN, { terminal_id: 'terminal-OTHER' }));
    insertPin(
      db,
      pinFor(READY, { tenant_id: 'tenant-OTHER', lockout_until: '2026-10-12T11:00:00.000Z' }),
    );
    const h = makeHandler({ db, rosterResult: roster(NO_PIN, READY) });
    const res = await h.handler.listCashierPinStatus();
    expect(res).toEqual({
      kind: 'cashiers',
      cashiers: [
        { id: 'op-a', display_name: 'Amal', pin: 'no_pin' },
        { id: 'op-b', display_name: 'Basma', pin: 'no_pin' },
      ],
    });
  });

  // Doc 19 §2 rule 5: the match is the SIGN-IN match (cashier_clerk_user_id = id).
  // A row keyed by user_id alone cannot sign in, so it reads as no_pin. The 019
  // provision writer cannot create such a row (017 OQ-D6-1); this pins the
  // behaviour so a change to either side is caught.
  it('a row keyed by user_id alone (no clerk bridge id) reads as no_pin, like sign-in', async () => {
    const db = freshDb();
    insertPin(db, { user_id: NO_PIN.user_id, cashier_clerk_user_id: null });
    const h = makeHandler({ db, rosterResult: roster(NO_PIN) });
    const res = await h.handler.listCashierPinStatus();
    expect(res).toEqual({
      kind: 'cashiers',
      cashiers: [{ id: 'op-a', display_name: 'Amal', pin: 'no_pin' }],
    });
  });
});

// ─── Session re-checks after each await ──────────────────────────────────────

describe('RT-424 listCashierPinStatus — the session is re-checked after every await', () => {
  function sessionThatChangesDuringRoster(
    next: OperatorSessionRecord | null,
  ): Pick<Harness, 'handler'> {
    let current: OperatorSessionRecord | null = session();
    return makeHandler({
      current: () => current,
      rosterResult: () => {
        current = next;
        return Promise.resolve(roster(READY));
      },
    });
  }

  it.each([
    ['signed out', null],
    ['locked', session({ lock_state: 'locked', locked_at: '2026-10-12T10:00:00.000Z' })],
    [
      'replaced by another session',
      session({ id: 'session-other', backend_session_id: 'bsess-2' }),
    ],
    ['latched', session({ authority_latch: 'account_disabled_mid_session' })],
  ])('%s during the roster await → not_signed_in, no rows', async (_label, next) => {
    const h = sessionThatChangesDuringRoster(next);
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
  });

  it('signed out during the pairing await → not_signed_in, roster never fetched', async () => {
    let current: OperatorSessionRecord | null = session();
    const h = makeHandler({
      current: () => current,
      pairing: () => {
        current = null;
        return Promise.resolve(paired());
      },
    });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    expect(h.listRoster).not.toHaveBeenCalled();
  });
});

// ─── Minimum disclosure and read-only ────────────────────────────────────────

describe('RT-424 listCashierPinStatus — nothing secret crosses the bridge', () => {
  it('each entry carries only id, display_name, pin and (locked) locked_until', async () => {
    const db = freshDb();
    seedAllStates(db);
    const h = makeHandler({ db });
    const res = await h.handler.listCashierPinStatus();
    if (res.kind !== 'cashiers') throw new Error('expected cashiers');
    for (const c of res.cashiers) {
      const allowed =
        c.pin === 'locked'
          ? ['display_name', 'id', 'locked_until', 'pin']
          : ['display_name', 'id', 'pin'];
      expect(Object.keys(c).sort()).toEqual(allowed);
    }
    const wire = JSON.stringify(res);
    for (const forbidden of [
      'uid-',
      'tenant-1',
      'branch-1',
      'terminal-001',
      'failed',
      'hash',
      'salt',
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it('logs only the count — no names, ids or states', async () => {
    const db = freshDb();
    seedAllStates(db);
    const h = makeHandler({ db });
    await h.handler.listCashierPinStatus();
    expect(h.info).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(h.info.mock.calls);
    expect(logged).toContain('"count":5');
    for (const forbidden of ['Amal', 'op-a', 'uid-a', 'locked_until', 'terminal-001']) {
      expect(logged).not.toContain(forbidden);
    }
  });

  it('writes nothing: the PIN rows are byte-identical after the read', async () => {
    const db = freshDb();
    seedAllStates(db);
    const snapshot = (): unknown =>
      db.exec('SELECT * FROM cashier_pin_records ORDER BY user_id')[0]?.values;
    const before = JSON.stringify(snapshot());
    const h = makeHandler({ db });
    await h.handler.listCashierPinStatus();
    expect(JSON.stringify(snapshot())).toBe(before);
  });
});
