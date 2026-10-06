/**
 * RT-17 slice 4 part 2 — the local manager PIN store (option A, [GATED]
 * migration 0044, Jira RT-17 comment 10943), over the full migration stack
 * (sql.js) with the real Argon2id hashing and an authenticated safeStorage fake.
 *
 *   • `seal` + `save` enrol (or replace) a manager's PIN in a scope (tenant,
 *     branch, terminal — the cashier PIN records' scope): the secret is the
 *     Argon2id PHC string, sealed at rest; a replace resets the lockout.
 *   • `verify` finds the approver by the PIN alone among the scope's records
 *     (the close payload carries no manager identifier, so nothing tells which
 *     managers exist): exactly one match is the verified manager's `users.id`.
 *     A wrong PIN is a failed attempt on every record it was checked against
 *     (the cashier lockout: 5 failures → 5 minutes); a record under lockout
 *     is never checked. Two matches are ambiguous and fail closed.
 *   • Attempts are serialised, so concurrent wrong PINs cannot share one
 *     failure count.
 *   • A re-pair purges the other terminals' records (RT-215 decision 5).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from './__helpers__/offline-grant-fixture.js';
import {
  createManagerPinStore,
  purgeOtherTerminalManagerPinRecords,
  type ManagerPinScope,
  type ManagerPinStore,
} from '../manager-pin-store.js';

const SCOPE: ManagerPinScope = { tenantId: 't1', branchId: 'b1', terminalId: 'term-1' };
const MANAGER_A = '0190f5a2-3b4c-7d8e-9f01-00000000000a';
const MANAGER_B = '0190f5a2-3b4c-7d8e-9f01-00000000000b';
const PIN_A = '246810';
const PIN_B = '13579135';
const WRONG = '000000';
const NOW = '2026-10-06T08:00:00.000Z';

let raw: SqlJsDatabase;
let store: ManagerPinStore;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  raw = freshGrantDb();
  store = createManagerPinStore({ db: handleFor(raw), safeStorage: aeadSafeStorage() });
});

afterEach(() => {
  raw.close();
});

async function enrol(userId: string, pin: string, scope: ManagerPinScope = SCOPE): Promise<void> {
  store.save({ scope, userId, sealed: await store.seal(pin), now: NOW });
}

interface Row {
  user_id: string;
  failed_attempt_count: number;
  lockout_until: string | null;
}

function rows(): Row[] {
  const result = raw.exec(
    `SELECT user_id, failed_attempt_count, lockout_until
       FROM manager_pin_records ORDER BY terminal_id, user_id`,
  )[0];
  return (result?.values ?? []).map(([user_id, failed_attempt_count, lockout_until]) => ({
    user_id: user_id as string,
    failed_attempt_count: failed_attempt_count as number,
    lockout_until: lockout_until as string | null,
  }));
}

function failures(userId: string): number | undefined {
  return rows().find((r) => r.user_id === userId)?.failed_attempt_count;
}

function setLockout(userId: string, lockoutUntil: string, failed = 5): void {
  raw.run(
    'UPDATE manager_pin_records SET lockout_until = ?, failed_attempt_count = ? WHERE user_id = ?',
    [lockoutUntil, failed, userId],
  );
}

const FUTURE = (): string => new Date(Date.now() + 60_000).toISOString();
const PAST = (): string => new Date(Date.now() - 1_000).toISOString();

describe('enrolment', () => {
  it('stores the PIN sealed: no PHC string, no PIN at rest', async () => {
    await enrol(MANAGER_A, PIN_A);
    const stored = raw.exec('SELECT pin_hash, pin_salt FROM manager_pin_records')[0]?.values[0];
    const text = Buffer.from(stored?.[0] as Uint8Array).toString('latin1');
    expect(text).not.toContain('argon2');
    expect(text).not.toContain(PIN_A);
    expect((stored?.[1] as Uint8Array).length).toBeGreaterThan(0);
  });

  it('stores the users.id lower-cased', async () => {
    await enrol(MANAGER_A.toUpperCase(), PIN_A);
    expect(rows()).toEqual([{ user_id: MANAGER_A, failed_attempt_count: 0, lockout_until: null }]);
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_A,
    });
  });

  it('replaces the PIN and clears the lockout on a re-enrolment', async () => {
    await enrol(MANAGER_A, PIN_A);
    setLockout(MANAGER_A, FUTURE());
    await enrol(MANAGER_A, PIN_B);
    expect(rows()).toEqual([{ user_id: MANAGER_A, failed_attempt_count: 0, lockout_until: null }]);
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).resolves.toEqual({ kind: 'invalid' });
    await expect(store.verify({ scope: SCOPE, pin: PIN_B })).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_A,
    });
  });
});

describe('verification by the PIN alone, in the scope', () => {
  it('verifies the one manager whose PIN it is', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_B);
    await expect(store.verify({ scope: SCOPE, pin: PIN_B })).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_B,
    });
  });

  it('answers invalid with no record in the scope', async () => {
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).resolves.toEqual({ kind: 'invalid' });
  });

  it.each<[string, ManagerPinScope]>([
    ['another terminal', { ...SCOPE, terminalId: 'term-2' }],
    ['another branch', { ...SCOPE, branchId: 'b2' }],
    ['another tenant', { ...SCOPE, tenantId: 't2' }],
  ])('never checks a record of %s, nor counts against it', async (_name, other) => {
    await enrol(MANAGER_A, PIN_A, other);
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).resolves.toEqual({ kind: 'invalid' });
    await expect(store.verify({ scope: SCOPE, pin: WRONG })).resolves.toEqual({ kind: 'invalid' });
    expect(failures(MANAGER_A)).toBe(0);
  });

  it('counts a wrong PIN as a failed attempt on every record it was checked against', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_B);
    await expect(store.verify({ scope: SCOPE, pin: WRONG })).resolves.toEqual({ kind: 'invalid' });
    expect(rows().map((r) => r.failed_attempt_count)).toEqual([1, 1]);
  });

  it('clears the matched record’s failures and leaves the others as they were', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_B);
    await store.verify({ scope: SCOPE, pin: WRONG });
    await store.verify({ scope: SCOPE, pin: PIN_A });
    expect(failures(MANAGER_A)).toBe(0);
    expect(failures(MANAGER_B)).toBe(1);
  });

  it('fails closed when the PIN matches two managers (ambiguous), counting nothing', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_A);
    await store.verify({ scope: SCOPE, pin: WRONG });
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).resolves.toEqual({ kind: 'invalid' });
    expect(rows().map((r) => r.failed_attempt_count)).toEqual([1, 1]);
  });

  it('skips a record whose seal does not open, without throwing', async () => {
    await enrol(MANAGER_A, PIN_A);
    raw.run('UPDATE manager_pin_records SET pin_hash = ?', [new Uint8Array([1, 2, 3])]);
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).resolves.toEqual({ kind: 'invalid' });
    expect(failures(MANAGER_A)).toBe(0);
  });
});

describe('lockout (the cashier PIN rule: 5 failures → 5 minutes)', () => {
  it('locks a record on the fifth failure, and then refuses even its right PIN', async () => {
    await enrol(MANAGER_A, PIN_A);
    for (let i = 0; i < 4; i += 1) await store.verify({ scope: SCOPE, pin: WRONG });
    expect(rows()[0]?.lockout_until).toBeNull();
    await expect(store.verify({ scope: SCOPE, pin: WRONG })).resolves.toEqual({ kind: 'invalid' });
    const lockedUntil = Date.parse(rows()[0]?.lockout_until ?? '');
    expect(lockedUntil - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(lockedUntil - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).resolves.toEqual({ kind: 'locked' });
    expect(failures(MANAGER_A)).toBe(5);
  });

  it('answers locked only when every record in the scope is locked', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_B);
    setLockout(MANAGER_A, FUTURE());
    await expect(store.verify({ scope: SCOPE, pin: WRONG })).resolves.toEqual({ kind: 'invalid' });
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).resolves.toEqual({ kind: 'invalid' });
    await expect(store.verify({ scope: SCOPE, pin: PIN_B })).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_B,
    });
    setLockout(MANAGER_B, FUTURE());
    await expect(store.verify({ scope: SCOPE, pin: PIN_B })).resolves.toEqual({ kind: 'locked' });
  });

  it('never counts a failure against a locked record', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_B);
    const until = FUTURE();
    setLockout(MANAGER_A, until);
    await store.verify({ scope: SCOPE, pin: WRONG });
    expect(rows()[0]).toEqual({ user_id: MANAGER_A, failed_attempt_count: 5, lockout_until: until });
  });

  it('verifies again once the lockout has expired, and clears it', async () => {
    await enrol(MANAGER_A, PIN_A);
    setLockout(MANAGER_A, PAST());
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_A,
    });
    expect(rows()[0]).toEqual({ user_id: MANAGER_A, failed_attempt_count: 0, lockout_until: null });
  });

  it('restarts the count after an expired lockout', async () => {
    await enrol(MANAGER_A, PIN_A);
    setLockout(MANAGER_A, PAST());
    await store.verify({ scope: SCOPE, pin: WRONG });
    expect(rows()[0]).toEqual({ user_id: MANAGER_A, failed_attempt_count: 1, lockout_until: null });
  });

  it('serialises attempts: concurrent wrong PINs each count', async () => {
    await enrol(MANAGER_A, PIN_A);
    await Promise.all([
      store.verify({ scope: SCOPE, pin: WRONG }),
      store.verify({ scope: SCOPE, pin: '111111' }),
      store.verify({ scope: SCOPE, pin: '222222' }),
    ]);
    expect(failures(MANAGER_A)).toBe(3);
  });

  it('keeps serving after an attempt fails unexpectedly', async () => {
    await enrol(MANAGER_A, PIN_A);
    raw.exec('ALTER TABLE manager_pin_records RENAME TO manager_pin_records_gone');
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).rejects.toThrow();
    raw.exec('ALTER TABLE manager_pin_records_gone RENAME TO manager_pin_records');
    await expect(store.verify({ scope: SCOPE, pin: PIN_A })).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_A,
    });
  });
});

describe('purgeOtherTerminalManagerPinRecords (RT-215 decision 5)', () => {
  it('deletes the records of every other terminal and keeps the current one', async () => {
    await enrol(MANAGER_A, PIN_A, { ...SCOPE, terminalId: 'term-old' });
    await enrol(MANAGER_B, PIN_B, { ...SCOPE, terminalId: 'term-old' });
    await enrol(MANAGER_A, PIN_A);
    expect(purgeOtherTerminalManagerPinRecords(handleFor(raw), SCOPE.terminalId)).toBe(2);
    expect(rows().map((r) => r.user_id)).toEqual([MANAGER_A]);
  });

  it('refuses an empty terminal id (it would match every record)', () => {
    expect(() => purgeOtherTerminalManagerPinRecords(handleFor(raw), '')).toThrow(/required/);
  });
});
