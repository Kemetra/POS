import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { Logger } from 'pino';

import { freshGrantDb, handleFor, initGrantSql } from './__helpers__/offline-grant-fixture.js';
import {
  CashierPinStatusHandler,
  type CashierPinStatusHandlerDeps,
} from '../cashier-pin-status.js';
import type { CashierRosterEntry, CashierRosterResult } from '../cashier-admission-client.js';
import type { OperatorSessionRecord } from '../session-manager.js';
import type { PairingStatus } from '../../../shared/pairing-types.js';

/**
 * RT-424 (RT-251 doc 19 §2) — the manager-only cashier PIN-status read.
 *
 * Runs on the full migration stack (sql.js) through the production
 * `DatabaseHandle` adapter, so the PIN-record schema after 0036 (nullable
 * `cashier_clerk_user_id`, `user_id` NOT NULL) is the real one.
 */

const TENANT = 'tenant-PINSTATUS-1';
const BRANCH = 'branch-PINSTATUS-1';
const TERMINAL = 'terminal-PINSTATUS-1';
const NOW = new Date('2026-10-12T12:00:00.000Z');

const AMIRA = {
  user_id: 'user-neutral-AMIRA',
  operator_id: 'user_clerk_AMIRA',
  display_name: 'أميرة',
};
const BASSEM = {
  user_id: 'user-neutral-BASSEM',
  operator_id: 'user_clerk_BASSEM',
  display_name: 'باسم',
};
const CHADI = {
  user_id: 'user-neutral-CHADI',
  operator_id: 'user_clerk_CHADI',
  display_name: 'شادي',
};

let raw: SqlJsDatabase;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  raw = freshGrantDb();
});

afterEach(() => {
  raw.close();
});

interface SeedRow {
  clerk: string | null;
  user_id: string;
  failed?: number;
  lockout_until?: string | null;
  tenant?: string;
  branch?: string;
  terminal?: string;
}

function seedPin(row: SeedRow): void {
  raw.run(
    `INSERT INTO cashier_pin_records
       (tenant_id, branch_id, terminal_id, user_id, cashier_clerk_user_id, pin_hash, pin_salt,
        failed_attempt_count, lockout_until, created_at, created_by_operator_id)
     VALUES (?, ?, ?, ?, ?, X'DEADBEEF', X'C0FFEE', ?, ?, '2026-10-01T00:00:00Z', 'user_mgr')`,
    [
      row.tenant ?? TENANT,
      row.branch ?? BRANCH,
      row.terminal ?? TERMINAL,
      row.user_id,
      row.clerk,
      row.failed ?? 0,
      row.lockout_until ?? null,
    ],
  );
}

function pinRows(): unknown[][] {
  return (
    raw.exec(
      `SELECT terminal_id, user_id, cashier_clerk_user_id, hex(pin_hash), hex(pin_salt),
              failed_attempt_count, lockout_until
         FROM cashier_pin_records ORDER BY terminal_id, user_id`,
    )[0]?.values ?? []
  );
}

function managerSession(over: Partial<OperatorSessionRecord> = {}): OperatorSessionRecord {
  return {
    id: 'session-mgr-1',
    operator_id: 'user_clerk_MANAGER',
    display_name: 'Manager',
    role: 'manager',
    tenant_id: TENANT,
    branch_id: BRANCH,
    backend_session_id: 'bsess-1',
    started_at: '2026-10-12T08:00:00.000Z',
    last_activity_at: '2026-10-12T08:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
    ...over,
  };
}

const PAIRED: PairingStatus = {
  kind: 'paired',
  tenant_id: TENANT,
  branch_id: BRANCH,
  terminal_id: TERMINAL,
  terminal_label: 'Till 1',
  paired_at: 0,
};

function roster(...cashiers: CashierRosterEntry[]): CashierRosterResult {
  return { kind: 'roster', cashiers };
}

interface Harness {
  handler: CashierPinStatusHandler;
  listRoster: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  setSession: (s: OperatorSessionRecord | null) => void;
}

function harness(
  opts: {
    session?: OperatorSessionRecord | null;
    roster?: CashierRosterResult;
    pairing?: PairingStatus;
    onRoster?: () => void;
    onPairing?: () => void;
    logger?: Pick<Logger, 'info'>;
  } = {},
): Harness {
  let session: OperatorSessionRecord | null =
    opts.session === undefined ? managerSession() : opts.session;
  const listRoster = vi.fn(() => {
    opts.onRoster?.();
    return Promise.resolve(opts.roster ?? roster(AMIRA, BASSEM, CHADI));
  });
  const getStatus = vi.fn(() => {
    opts.onPairing?.();
    return Promise.resolve(opts.pairing ?? PAIRED);
  });
  const deps: CashierPinStatusHandlerDeps = {
    db: handleFor(raw),
    sessionManager: { getCurrent: () => session },
    pairingStore: { getStatus },
    cashierAdmissions: { listRoster },
    now: () => NOW,
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  };
  return {
    handler: new CashierPinStatusHandler(deps),
    listRoster,
    getStatus,
    setSession: (s) => {
      session = s;
    },
  };
}

describe('RT-424 CashierPinStatusHandler — role gate and scope', () => {
  it('refuses a cashier session with role_mismatch before reading anything', async () => {
    const h = harness({ session: managerSession({ role: 'cashier' }) });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'refused',
      category: 'role_mismatch',
    });
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.listRoster).not.toHaveBeenCalled();
  });

  it('refuses with not_signed_in when no operator is signed in', async () => {
    const h = harness({ session: null });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.listRoster).not.toHaveBeenCalled();
  });

  it('serves an admin session', async () => {
    const h = harness({ session: managerSession({ role: 'admin' }) });
    const res = await h.handler.listCashierPinStatus();
    expect(res.kind).toBe('cashiers');
  });

  it('refuses an unpaired terminal with invalid_input and never reads the roster', async () => {
    const h = harness({ pairing: { kind: 'unpaired' } });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
    expect(h.listRoster).not.toHaveBeenCalled();
  });
});

describe('RT-424 CashierPinStatusHandler — roster outcomes', () => {
  it.each(['no_connection', 'unavailable'] as const)(
    'maps a %s roster to no_connection',
    async (kind) => {
      const h = harness({ roster: { kind } });
      await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
        kind: 'refused',
        category: 'no_connection',
      });
    },
  );

  it.each(['device_unauthorized', 'no_token', 'rejected'] as const)(
    'maps a %s roster to invalid_input',
    async (kind) => {
      const h = harness({ roster: { kind } });
      await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
        kind: 'refused',
        category: 'invalid_input',
      });
    },
  );

  it('answers an empty roster with an empty list', async () => {
    const h = harness({ roster: roster() });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'cashiers',
      cashiers: [],
    });
  });
});

describe('RT-424 CashierPinStatusHandler — the state of each roster entry', () => {
  it('reads no_pin, ready and locked, in roster order', async () => {
    seedPin({ clerk: BASSEM.operator_id, user_id: BASSEM.user_id });
    seedPin({
      clerk: CHADI.operator_id,
      user_id: CHADI.user_id,
      failed: 5,
      lockout_until: '2026-10-12T12:04:00.000Z',
    });
    const h = harness();
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'cashiers',
      cashiers: [
        { id: AMIRA.operator_id, display_name: AMIRA.display_name, pin: 'no_pin' },
        { id: BASSEM.operator_id, display_name: BASSEM.display_name, pin: 'ready' },
        {
          id: CHADI.operator_id,
          display_name: CHADI.display_name,
          pin: 'locked',
          locked_until: '2026-10-12T12:04:00.000Z',
        },
      ],
    });
  });

  it('reads 1–4 failures with no lockout as ready', async () => {
    seedPin({ clerk: AMIRA.operator_id, user_id: AMIRA.user_id, failed: 4 });
    const h = harness({ roster: roster(AMIRA) });
    const res = await h.handler.listCashierPinStatus();
    expect(res).toEqual({
      kind: 'cashiers',
      cashiers: [{ id: AMIRA.operator_id, display_name: AMIRA.display_name, pin: 'ready' }],
    });
  });

  it.each([
    ['ends exactly now', '2026-10-12T12:00:00.000Z'],
    ['ended a second ago', '2026-10-12T11:59:59.000Z'],
  ])('reads a lock that %s as ready (locked means lockout_until > now)', async (_label, until) => {
    seedPin({ clerk: AMIRA.operator_id, user_id: AMIRA.user_id, failed: 5, lockout_until: until });
    const h = harness({ roster: roster(AMIRA) });
    const res = await h.handler.listCashierPinStatus();
    expect(res).toEqual({
      kind: 'cashiers',
      cashiers: [{ id: AMIRA.operator_id, display_name: AMIRA.display_name, pin: 'ready' }],
    });
  });

  // Sign-in parity: `new Date('not-a-date') > now` is false, so sign-in treats the
  // row as not locked and lets the cashier try a PIN. The read must agree.
  it('reads an unparseable lockout_until as ready, as sign-in does', async () => {
    seedPin({
      clerk: AMIRA.operator_id,
      user_id: AMIRA.user_id,
      failed: 5,
      lockout_until: 'not-a-date',
    });
    const res = await harness({ roster: roster(AMIRA) }).handler.listCashierPinStatus();
    expect(res).toEqual({
      kind: 'cashiers',
      cashiers: [{ id: AMIRA.operator_id, display_name: AMIRA.display_name, pin: 'ready' }],
    });
  });

  it('carries locked_until only on a locked row', async () => {
    seedPin({ clerk: BASSEM.operator_id, user_id: BASSEM.user_id });
    seedPin({
      clerk: CHADI.operator_id,
      user_id: CHADI.user_id,
      failed: 5,
      lockout_until: '2026-10-12T12:01:00.000Z',
    });
    const res = await harness().handler.listCashierPinStatus();
    if (res.kind !== 'cashiers') throw new Error('expected cashiers');
    const withUntil = res.cashiers.filter((c) => 'locked_until' in c).map((c) => c.id);
    expect(withUntil).toEqual([CHADI.operator_id]);
  });

  it('never matches a row of another terminal, branch or tenant', async () => {
    seedPin({ clerk: AMIRA.operator_id, user_id: AMIRA.user_id, terminal: 'terminal-OTHER' });
    seedPin({ clerk: AMIRA.operator_id, user_id: 'u-b', branch: 'branch-OTHER' });
    seedPin({ clerk: AMIRA.operator_id, user_id: 'u-t', tenant: 'tenant-OTHER' });
    const res = await harness({ roster: roster(AMIRA) }).handler.listCashierPinStatus();
    expect(res).toEqual({
      kind: 'cashiers',
      cashiers: [{ id: AMIRA.operator_id, display_name: AMIRA.display_name, pin: 'no_pin' }],
    });
  });

  // Doc 19 §2 rule 5: the match is the sign-in match (cashier_clerk_user_id = id).
  // A row keyed by user_id alone cannot be signed in with, so it reads no_pin.
  // The 019 provision writer never creates one (017 OQ-D6-1); if one shows up
  // in the field, RT-424 stops and asks rather than inventing a state.
  it('pins the user_id-only row: it reads as no_pin, the same as sign-in sees it', async () => {
    seedPin({ clerk: null, user_id: AMIRA.user_id });
    const res = await harness({ roster: roster(AMIRA) }).handler.listCashierPinStatus();
    expect(res).toEqual({
      kind: 'cashiers',
      cashiers: [{ id: AMIRA.operator_id, display_name: AMIRA.display_name, pin: 'no_pin' }],
    });
  });
});

describe('RT-424 CashierPinStatusHandler — the session during the awaits', () => {
  const mutations: [string, (h: Harness) => void][] = [
    [
      'locks',
      (h) => {
        h.setSession(managerSession({ lock_state: 'locked' }));
      },
    ],
    [
      'signs out',
      (h) => {
        h.setSession(null);
      },
    ],
    [
      'changes backend session',
      (h) => {
        h.setSession(managerSession({ backend_session_id: 'bsess-OTHER' }));
      },
    ],
    [
      'is replaced',
      (h) => {
        h.setSession(managerSession({ id: 'session-OTHER' }));
      },
    ],
    [
      'is latched',
      (h) => {
        h.setSession(managerSession({ authority_latch: 'account_disabled_mid_session' }));
      },
    ],
  ];

  it.each(mutations)(
    'answers not_signed_in when the session %s during the roster await',
    async (_label, mutate) => {
      seedPin({ clerk: AMIRA.operator_id, user_id: AMIRA.user_id });
      const box: { h?: Harness } = {};
      box.h = harness({
        onRoster: () => {
          mutate(box.h as Harness);
        },
      });
      await expect(box.h.handler.listCashierPinStatus()).resolves.toEqual({
        kind: 'refused',
        category: 'not_signed_in',
      });
    },
  );

  it.each(mutations)(
    'answers not_signed_in when the session %s during the pairing await',
    async (_label, mutate) => {
      const box: { h?: Harness } = {};
      box.h = harness({
        onPairing: () => {
          mutate(box.h as Harness);
        },
      });
      await expect(box.h.handler.listCashierPinStatus()).resolves.toEqual({
        kind: 'refused',
        category: 'not_signed_in',
      });
      expect(box.h.listRoster).not.toHaveBeenCalled();
    },
  );

  it('refuses a session that is already locked at entry', async () => {
    const h = harness({ session: managerSession({ lock_state: 'locked' }) });
    await expect(h.handler.listCashierPinStatus()).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    expect(h.listRoster).not.toHaveBeenCalled();
  });
});

describe('RT-424 CashierPinStatusHandler — what crosses the bridge', () => {
  it('carries no secret, count, user_id or scope id, and writes nothing', async () => {
    seedPin({ clerk: BASSEM.operator_id, user_id: BASSEM.user_id, failed: 2 });
    seedPin({
      clerk: CHADI.operator_id,
      user_id: CHADI.user_id,
      failed: 5,
      lockout_until: '2026-10-12T12:04:00.000Z',
    });
    const before = pinRows();
    const res = await harness().handler.listCashierPinStatus();
    const wire = JSON.stringify(res);

    for (const forbidden of [
      TENANT,
      BRANCH,
      TERMINAL,
      AMIRA.user_id,
      BASSEM.user_id,
      CHADI.user_id,
      'DEADBEEF',
      'deadbeef',
      'C0FFEE',
      'c0ffee',
      'pin_hash',
      'pin_salt',
      'failed_attempt_count',
      'lockout_until',
      'user_id',
      'tenant_id',
      'branch_id',
      'terminal_id',
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    if (res.kind !== 'cashiers') throw new Error('expected cashiers');
    expect(Object.keys(res).sort()).toEqual(['cashiers', 'kind']);
    for (const c of res.cashiers) {
      for (const key of Object.keys(c)) {
        expect(['id', 'display_name', 'pin', 'locked_until']).toContain(key);
      }
    }
    expect(pinRows()).toEqual(before);
  });

  it('logs only the count, never a name or an id', async () => {
    const info = vi.fn();
    await harness({ logger: { info } }).handler.listCashierPinStatus();
    const logged = JSON.stringify(info.mock.calls);
    for (const v of [AMIRA, BASSEM, CHADI].flatMap((c) => Object.values(c))) {
      expect(logged).not.toContain(v);
    }
    expect(info).toHaveBeenCalledWith(
      { event: 'operator.cashier_pin_status.read', count: 3 },
      'cashier pin status read',
    );
  });
});
