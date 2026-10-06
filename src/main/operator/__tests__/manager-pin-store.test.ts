/**
 * RT-17 slice 4 part 2 — the local manager PIN store (option A, [GATED]
 * migration 0044, Jira RT-17 comment 10943), over the full migration stack
 * (sql.js) with the real Argon2id hashing and an authenticated safeStorage fake.
 *
 * Review round 1 (Codex P1 4193622781, review P2-1/P2-5, nits 6/7/9):
 *   • a PIN is verified against ONE record, named by its opaque handle
 *     (`managerRef`, never the users.id), with that record's own lockout (the
 *     cashier rule: 5 failures → 5 minutes). There is no matching by PIN alone,
 *     so two managers may share a PIN without either approving as the other;
 *   • a record is valid only within 30 days of the manager's last online
 *     sign-in on this terminal (`last_online_at`, refreshed by `touchOnline`);
 *     past that it is `expired`, and no attempt is counted;
 *   • `list` gives the scope's valid records as { managerRef, displayName };
 *   • `enrol` creates a record, or replaces its PIN only after the current PIN
 *     is verified (with lockout); a guard runs right before the write;
 *   • every attempt and enrolment is serialised, and an attempt's lockout
 *     write only lands on the secret it checked;
 *   • a re-pair purges the other terminals' records (RT-215 decision 5).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from './__helpers__/offline-grant-fixture.js';
import {
  MANAGER_ONLINE_VALIDITY_MS,
  createManagerPinStore,
  purgeOtherTerminalManagerPinRecords,
  type EnrolManagerPinInput,
  type ManagerPinScope,
  type ManagerPinStore,
} from '../manager-pin-store.js';

const SCOPE: ManagerPinScope = { tenantId: 't1', branchId: 'b1', terminalId: 'term-1' };
const MANAGER_A = '0190f5a2-3b4c-7d8e-9f01-00000000000a';
const MANAGER_B = '0190f5a2-3b4c-7d8e-9f01-00000000000b';
const PIN_A = '246810';
const PIN_B = '13579135';
const WRONG = '000000';
const ONLINE_AT = '2026-10-06T07:59:00.000Z';
const NOW = '2026-10-06T08:00:00.000Z';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

type EnrolOver = Partial<Omit<EnrolManagerPinInput, 'sealed' | 'userId'>>;

async function enrol(userId: string, pin: string, over: EnrolOver = {}): Promise<unknown> {
  return store.enrol({
    scope: SCOPE,
    userId,
    displayName: `Manager ${userId.slice(-1)}`,
    now: NOW,
    onlineAt: ONLINE_AT,
    guard: () => undefined,
    ...over,
    sealed: await store.seal(pin),
  });
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

function column(userId: string, name: string): unknown {
  return raw.exec(
    `SELECT ${name} FROM manager_pin_records WHERE user_id = ? ORDER BY terminal_id`,
    [userId],
  )[0]?.values[0]?.[0];
}

function refOf(userId: string): string {
  return column(userId, 'manager_ref') as string;
}

function failures(userId: string): unknown {
  return column(userId, 'failed_attempt_count');
}

function setLockout(userId: string, lockoutUntil: string, failed = 5): void {
  raw.run(
    'UPDATE manager_pin_records SET lockout_until = ?, failed_attempt_count = ? WHERE user_id = ?',
    [lockoutUntil, failed, userId],
  );
}

function verify(userId: string, pin: string, now = NOW): Promise<unknown> {
  return store.verify({ scope: SCOPE, managerRef: refOf(userId), pin, now });
}

const FUTURE = (): string => new Date(Date.now() + 60_000).toISOString();
const PAST = (): string => new Date(Date.now() - 1_000).toISOString();
const atOffset = (ms: number): string => new Date(Date.parse(ONLINE_AT) + ms).toISOString();

describe('enrolment', () => {
  it('stores the PIN sealed: no PHC string, no PIN at rest', async () => {
    await enrol(MANAGER_A, PIN_A);
    const stored = raw.exec('SELECT pin_hash, pin_salt FROM manager_pin_records')[0]?.values[0];
    const text = Buffer.from(stored?.[0] as Uint8Array).toString('latin1');
    expect(text).not.toContain('argon2');
    expect(text).not.toContain(PIN_A);
    expect((stored?.[1] as Uint8Array).length).toBeGreaterThan(0);
  });

  it('records the lower-cased users.id, an opaque handle, the name and both stamps', async () => {
    await expect(enrol(MANAGER_A.toUpperCase(), PIN_A)).resolves.toEqual({ kind: 'enrolled' });
    expect(rows()).toEqual([{ user_id: MANAGER_A, failed_attempt_count: 0, lockout_until: null }]);
    const ref = refOf(MANAGER_A);
    expect(ref).toMatch(UUID);
    expect(ref).not.toBe(MANAGER_A);
    expect(column(MANAGER_A, 'display_name')).toBe('Manager A');
    expect(column(MANAGER_A, 'enrolled_at')).toBe(NOW);
    expect(column(MANAGER_A, 'last_online_at')).toBe(ONLINE_AT);
  });

  it('gives each record its own handle', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_B);
    expect(refOf(MANAGER_A)).not.toBe(refOf(MANAGER_B));
  });

  it('refuses to replace a PIN without the current one', async () => {
    await enrol(MANAGER_A, PIN_A);
    await expect(enrol(MANAGER_A, PIN_B)).resolves.toEqual({ kind: 'current_pin_required' });
    await expect(verify(MANAGER_A, PIN_A)).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_A,
    });
  });

  it('replaces the PIN with the right current one, keeping the handle and clearing the lockout', async () => {
    await enrol(MANAGER_A, PIN_A);
    const ref = refOf(MANAGER_A);
    setLockout(MANAGER_A, PAST(), 3);
    const later = '2026-10-06T09:00:00.000Z';
    const signedInAgain = '2026-10-06T08:59:00.000Z';
    await expect(
      enrol(MANAGER_A, PIN_B, {
        currentPin: PIN_A,
        displayName: 'Mona',
        now: later,
        onlineAt: signedInAgain,
      }),
    ).resolves.toEqual({ kind: 'enrolled' });
    expect(column(MANAGER_A, 'last_online_at')).toBe(signedInAgain);
    expect(refOf(MANAGER_A)).toBe(ref);
    expect(rows()).toEqual([{ user_id: MANAGER_A, failed_attempt_count: 0, lockout_until: null }]);
    expect(column(MANAGER_A, 'display_name')).toBe('Mona');
    expect(column(MANAGER_A, 'enrolled_at')).toBe(later);
    await expect(verify(MANAGER_A, PIN_A)).resolves.toEqual({ kind: 'invalid' });
    await expect(verify(MANAGER_A, PIN_B)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('counts a wrong current PIN as a failed attempt and keeps the old PIN', async () => {
    await enrol(MANAGER_A, PIN_A);
    await expect(enrol(MANAGER_A, PIN_B, { currentPin: WRONG })).resolves.toEqual({
      kind: 'current_pin_invalid',
    });
    expect(failures(MANAGER_A)).toBe(1);
    await expect(verify(MANAGER_A, PIN_A)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('refuses a replacement when the record’s seal does not open, counting nothing', async () => {
    await enrol(MANAGER_A, PIN_A);
    raw.run('UPDATE manager_pin_records SET pin_hash = ?', [new Uint8Array([1, 2, 3])]);
    await expect(enrol(MANAGER_A, PIN_B, { currentPin: PIN_A })).resolves.toEqual({
      kind: 'current_pin_invalid',
    });
    expect(failures(MANAGER_A)).toBe(0);
    expect(column(MANAGER_A, 'pin_hash')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses a replacement while the record is locked out', async () => {
    await enrol(MANAGER_A, PIN_A);
    setLockout(MANAGER_A, FUTURE());
    await expect(enrol(MANAGER_A, PIN_B, { currentPin: PIN_A })).resolves.toEqual({
      kind: 'current_pin_locked',
    });
  });

  it('runs the guard right before the write, and writes nothing when it throws', async () => {
    await enrol(MANAGER_A, PIN_A);
    const seen: unknown[] = [];
    const guard = vi.fn(() => {
      seen.push(failures(MANAGER_A));
      throw new Error('session changed');
    });
    setLockout(MANAGER_A, PAST(), 2);
    await expect(enrol(MANAGER_A, PIN_B, { currentPin: PIN_A, guard })).rejects.toThrow(
      'session changed',
    );
    // The current PIN was verified (failures cleared) before the guard ran.
    expect(seen).toEqual([0]);
    await expect(verify(MANAGER_A, PIN_A)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('runs the guard before a first enrolment too', async () => {
    const guard = vi.fn(() => {
      throw new Error('locked');
    });
    await expect(enrol(MANAGER_A, PIN_A, { guard })).rejects.toThrow('locked');
    expect(rows()).toEqual([]);
  });

  it('does not run the guard when the current PIN is wrong', async () => {
    await enrol(MANAGER_A, PIN_A);
    const guard = vi.fn();
    await enrol(MANAGER_A, PIN_B, { currentPin: WRONG, guard });
    expect(guard).not.toHaveBeenCalled();
  });
});

describe('verification of one record, by its handle', () => {
  it('verifies the named manager with their own PIN', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_B);
    await expect(verify(MANAGER_B, PIN_B)).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_B,
    });
  });

  it('never approves as another manager, even with that manager’s PIN', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_B);
    await expect(verify(MANAGER_A, PIN_B)).resolves.toEqual({ kind: 'invalid' });
    expect(failures(MANAGER_A)).toBe(1);
    expect(failures(MANAGER_B)).toBe(0);
  });

  it('lets two managers share a PIN without one approving for the other (Codex P1)', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_A);
    setLockout(MANAGER_A, FUTURE());
    await expect(verify(MANAGER_A, PIN_A)).resolves.toEqual({ kind: 'locked' });
    await expect(verify(MANAGER_B, PIN_A)).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_B,
    });
  });

  it('answers invalid for an unknown handle, counting nothing', async () => {
    await enrol(MANAGER_A, PIN_A);
    await expect(
      store.verify({ scope: SCOPE, managerRef: MANAGER_A, pin: PIN_A, now: NOW }),
    ).resolves.toEqual({ kind: 'invalid' });
    expect(failures(MANAGER_A)).toBe(0);
  });

  it.each<[string, ManagerPinScope]>([
    ['another terminal', { ...SCOPE, terminalId: 'term-2' }],
    ['another branch', { ...SCOPE, branchId: 'b2' }],
    ['another tenant', { ...SCOPE, tenantId: 't2' }],
  ])('never verifies a record of %s', async (_name, other) => {
    await enrol(MANAGER_A, PIN_A, { scope: other });
    const managerRef = refOf(MANAGER_A);
    await expect(store.verify({ scope: SCOPE, managerRef, pin: PIN_A, now: NOW })).resolves.toEqual(
      { kind: 'invalid' },
    );
    expect(failures(MANAGER_A)).toBe(0);
  });

  it('skips a record whose seal does not open, counting nothing', async () => {
    await enrol(MANAGER_A, PIN_A);
    raw.run('UPDATE manager_pin_records SET pin_hash = ?', [new Uint8Array([1, 2, 3])]);
    await expect(verify(MANAGER_A, PIN_A)).resolves.toEqual({ kind: 'invalid' });
    expect(failures(MANAGER_A)).toBe(0);
  });
});

describe('expiry: 30 days after the last online sign-in on this terminal (P2-1)', () => {
  it('is 30 days', () => {
    expect(MANAGER_ONLINE_VALIDITY_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('verifies up to exactly 30 days, then answers expired without checking or counting', async () => {
    await enrol(MANAGER_A, PIN_A);
    await expect(verify(MANAGER_A, PIN_A, atOffset(MANAGER_ONLINE_VALIDITY_MS))).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_A,
    });
    const expired = atOffset(MANAGER_ONLINE_VALIDITY_MS + 1);
    await expect(verify(MANAGER_A, WRONG, expired)).resolves.toEqual({ kind: 'expired' });
    await expect(verify(MANAGER_A, PIN_A, expired)).resolves.toEqual({ kind: 'expired' });
    expect(failures(MANAGER_A)).toBe(0);
  });

  it('is refreshed by an online sign-in on this terminal (touchOnline)', async () => {
    await enrol(MANAGER_A, PIN_A);
    const signedIn = atOffset(MANAGER_ONLINE_VALIDITY_MS);
    store.touchOnline({ scope: SCOPE, userId: MANAGER_A.toUpperCase(), at: signedIn });
    expect(column(MANAGER_A, 'last_online_at')).toBe(signedIn);
    await expect(
      verify(MANAGER_A, PIN_A, atOffset(MANAGER_ONLINE_VALIDITY_MS + 1)),
    ).resolves.toMatchObject({ kind: 'verified' });
  });

  it('touches only the manager’s record in the scope', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_A, PIN_A, { scope: { ...SCOPE, terminalId: 'term-2' } });
    await enrol(MANAGER_B, PIN_B);
    store.touchOnline({ scope: SCOPE, userId: MANAGER_A, at: NOW });
    const stamps = raw.exec(
      'SELECT terminal_id, user_id, last_online_at FROM manager_pin_records ORDER BY terminal_id, user_id',
    )[0]?.values;
    expect(stamps).toEqual([
      ['term-1', MANAGER_A, NOW],
      ['term-1', MANAGER_B, ONLINE_AT],
      ['term-2', MANAGER_A, ONLINE_AT],
    ]);
  });
});

describe('list — the approver picker', () => {
  it('lists the scope’s valid records by name, with their handles only', async () => {
    await enrol(MANAGER_B, PIN_B, { displayName: 'Zeinab' });
    await enrol(MANAGER_A, PIN_A, { displayName: 'Adel' });
    await enrol(MANAGER_A, PIN_A, { scope: { ...SCOPE, terminalId: 'term-2' } });
    const listed = store.list({ scope: SCOPE, now: NOW });
    expect(listed).toEqual([
      { managerRef: refOf(MANAGER_A), displayName: 'Adel' },
      { managerRef: refOf(MANAGER_B), displayName: 'Zeinab' },
    ]);
    expect(JSON.stringify(listed)).not.toContain(MANAGER_A);
    expect(JSON.stringify(listed)).not.toContain(MANAGER_B);
  });

  it('leaves out an expired record, and keeps a locked one', async () => {
    await enrol(MANAGER_A, PIN_A);
    await enrol(MANAGER_B, PIN_B);
    setLockout(MANAGER_B, FUTURE());
    store.touchOnline({ scope: SCOPE, userId: MANAGER_B, at: atOffset(1) });
    const listed = store.list({ scope: SCOPE, now: atOffset(MANAGER_ONLINE_VALIDITY_MS + 1) });
    expect(listed.map((m) => m.displayName)).toEqual(['Manager b']);
  });
});

describe('lockout (the cashier PIN rule: 5 failures → 5 minutes), per record', () => {
  it('locks on the fifth failure, and then refuses even the right PIN', async () => {
    await enrol(MANAGER_A, PIN_A);
    for (let i = 0; i < 4; i += 1) await verify(MANAGER_A, WRONG);
    expect(rows()[0]?.lockout_until).toBeNull();
    await expect(verify(MANAGER_A, WRONG)).resolves.toEqual({ kind: 'invalid' });
    const lockedUntil = Date.parse(rows()[0]?.lockout_until ?? '');
    expect(lockedUntil - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(lockedUntil - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    await expect(verify(MANAGER_A, PIN_A)).resolves.toEqual({ kind: 'locked' });
    expect(failures(MANAGER_A)).toBe(5);
  });

  it('clears the record’s failures on a match', async () => {
    await enrol(MANAGER_A, PIN_A);
    await verify(MANAGER_A, WRONG);
    await verify(MANAGER_A, PIN_A);
    expect(failures(MANAGER_A)).toBe(0);
  });

  it('verifies again once the lockout has expired, and clears it', async () => {
    await enrol(MANAGER_A, PIN_A);
    setLockout(MANAGER_A, PAST());
    await expect(verify(MANAGER_A, PIN_A)).resolves.toMatchObject({ kind: 'verified' });
    expect(rows()[0]).toEqual({ user_id: MANAGER_A, failed_attempt_count: 0, lockout_until: null });
  });

  it('restarts the count after an expired lockout', async () => {
    await enrol(MANAGER_A, PIN_A);
    setLockout(MANAGER_A, PAST());
    await verify(MANAGER_A, WRONG);
    expect(rows()[0]).toEqual({ user_id: MANAGER_A, failed_attempt_count: 1, lockout_until: null });
  });

  it('serialises attempts: concurrent wrong PINs each count', async () => {
    await enrol(MANAGER_A, PIN_A);
    await Promise.all([
      verify(MANAGER_A, WRONG),
      verify(MANAGER_A, '111111'),
      verify(MANAGER_A, '222222'),
    ]);
    expect(failures(MANAGER_A)).toBe(3);
  });

  /** A replacement of MANAGER_A's PIN by PIN_B, sealed up front (no await before it starts). */
  async function replacer(): Promise<(currentPin: string) => Promise<unknown>> {
    const sealed = await store.seal(PIN_B);
    return (currentPin) =>
      store.enrol({
        scope: SCOPE,
        userId: MANAGER_A,
        displayName: 'Manager A',
        currentPin,
        now: NOW,
        onlineAt: ONLINE_AT,
        guard: () => undefined,
        sealed,
      });
  }

  it('serialises enrolments with attempts: concurrent wrong current PINs each count (nit 9)', async () => {
    await enrol(MANAGER_A, PIN_A);
    const replace = await replacer();
    await Promise.all([verify(MANAGER_A, WRONG), replace('111111'), replace('222222')]);
    expect(failures(MANAGER_A)).toBe(3);
  });

  it('serialises an enrolment behind an attempt in flight (nit 9)', async () => {
    await enrol(MANAGER_A, PIN_A);
    const replace = await replacer();
    const attempt = verify(MANAGER_A, WRONG);
    const replaced = replace(PIN_A);
    await attempt;
    await expect(replaced).resolves.toEqual({ kind: 'enrolled' });
    expect(failures(MANAGER_A)).toBe(0);
    await expect(verify(MANAGER_A, PIN_B)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('never writes an attempt’s result over a newer secret (nit 7)', async () => {
    const ss = aeadSafeStorage();
    let during: () => void = () => undefined;
    store = createManagerPinStore({
      db: handleFor(raw),
      safeStorage: {
        ...ss,
        decryptString: (buf: Buffer) => {
          const plain = ss.decryptString(buf);
          during();
          return plain;
        },
      },
    });
    await enrol(MANAGER_A, PIN_A);
    const sealed = await store.seal(PIN_B);
    setLockout(MANAGER_A, PAST(), 2);
    // Another writer replaces the secret after the attempt read the record.
    during = () => {
      during = () => undefined;
      raw.run(
        'UPDATE manager_pin_records SET pin_hash = ?, pin_salt = ?, failed_attempt_count = 0',
        [sealed.pin_hash, sealed.pin_salt],
      );
    };
    await expect(verify(MANAGER_A, WRONG)).resolves.toEqual({ kind: 'invalid' });
    expect(failures(MANAGER_A)).toBe(0);
  });

  it('keeps serving after an attempt fails unexpectedly', async () => {
    await enrol(MANAGER_A, PIN_A);
    const managerRef = refOf(MANAGER_A);
    raw.exec('ALTER TABLE manager_pin_records RENAME TO manager_pin_records_gone');
    await expect(
      store.verify({ scope: SCOPE, managerRef, pin: PIN_A, now: NOW }),
    ).rejects.toThrow();
    raw.exec('ALTER TABLE manager_pin_records_gone RENAME TO manager_pin_records');
    await expect(verify(MANAGER_A, PIN_A)).resolves.toMatchObject({ kind: 'verified' });
  });
});

describe('purgeOtherTerminalManagerPinRecords (RT-215 decision 5)', () => {
  it('deletes the records of every other terminal and keeps the current one', async () => {
    const old = { ...SCOPE, terminalId: 'term-old' };
    await enrol(MANAGER_A, PIN_A, { scope: old });
    await enrol(MANAGER_B, PIN_B, { scope: old });
    await enrol(MANAGER_A, PIN_A);
    expect(purgeOtherTerminalManagerPinRecords(handleFor(raw), SCOPE.terminalId)).toBe(2);
    expect(rows().map((r) => r.user_id)).toEqual([MANAGER_A]);
  });

  it('refuses an empty terminal id (it would match every record)', () => {
    expect(() => purgeOtherTerminalManagerPinRecords(handleFor(raw), '')).toThrow(/required/);
  });
});
