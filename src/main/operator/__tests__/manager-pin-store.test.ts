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
 *
 * Review round 2: a last online sign-in in the future (a clock corrected
 * backwards, Codex P2 4194169617) makes the record expired, never longer-lived.
 * The helpers take typed fixtures (`Manager`, option objects), not positional
 * strings.
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

/** A manager fixture: their users.id and the PIN they enrol with. */
interface Manager {
  userId: string;
  pin: string;
}

const A: Manager = { userId: MANAGER_A, pin: PIN_A };
const B: Manager = { userId: MANAGER_B, pin: PIN_B };

/** A record column a test reads back. */
type Column =
  | 'manager_ref'
  | 'display_name'
  | 'enrolled_at'
  | 'last_online_at'
  | 'failed_attempt_count'
  | 'pin_hash';

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

/** Enrols `manager` with their PIN (sealed first), defaults overridable. */
async function enrol(manager: Manager, over: EnrolOver = {}): Promise<unknown> {
  const { userId } = manager;
  return store.enrol({
    scope: SCOPE,
    userId,
    displayName: `Manager ${userId.slice(-1)}`,
    now: NOW,
    onlineAt: ONLINE_AT,
    guard: () => undefined,
    ...over,
    sealed: await store.seal(manager.pin),
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

/** `name` of `of`'s record (the first terminal's, when several). */
function column(query: { of: Manager; name: Column }): unknown {
  return raw.exec(
    `SELECT ${query.name} FROM manager_pin_records WHERE user_id = ? ORDER BY terminal_id`,
    [query.of.userId],
  )[0]?.values[0]?.[0];
}

function refOf(of: Manager): string {
  return column({ of, name: 'manager_ref' }) as string;
}

function failures(of: Manager): unknown {
  return column({ of, name: 'failed_attempt_count' });
}

function setLockout(input: { of: Manager; until: string; failed?: number }): void {
  raw.run(
    'UPDATE manager_pin_records SET lockout_until = ?, failed_attempt_count = ? WHERE user_id = ?',
    [input.until, input.failed ?? 5, input.of.userId],
  );
}

/** Sets the record's last online sign-in directly (e.g. after a clock correction). */
function setLastOnline(input: { of: Manager; at: string }): void {
  raw.run('UPDATE manager_pin_records SET last_online_at = ? WHERE user_id = ?', [
    input.at,
    input.of.userId,
  ]);
}

/** An attempt on `manager`'s record with `pin` (default: their own) at `now`. */
function verify(manager: Manager, attempt: { pin?: string; now?: string } = {}): Promise<unknown> {
  return store.verify({
    scope: SCOPE,
    managerRef: refOf(manager),
    pin: attempt.pin ?? manager.pin,
    now: attempt.now ?? NOW,
  });
}

const FUTURE = (): string => new Date(Date.now() + 60_000).toISOString();
const PAST = (): string => new Date(Date.now() - 1_000).toISOString();
const atOffset = (ms: number): string => new Date(Date.parse(ONLINE_AT) + ms).toISOString();

describe('enrolment', () => {
  it('stores the PIN sealed: no PHC string, no PIN at rest', async () => {
    await enrol(A);
    const stored = raw.exec('SELECT pin_hash, pin_salt FROM manager_pin_records')[0]?.values[0];
    const text = Buffer.from(stored?.[0] as Uint8Array).toString('latin1');
    expect(text).not.toContain('argon2');
    expect(text).not.toContain(PIN_A);
    expect((stored?.[1] as Uint8Array).length).toBeGreaterThan(0);
  });

  it('records the lower-cased users.id, an opaque handle, the name and both stamps', async () => {
    await expect(enrol({ ...A, userId: MANAGER_A.toUpperCase() })).resolves.toEqual({
      kind: 'enrolled',
    });
    expect(rows()).toEqual([{ user_id: MANAGER_A, failed_attempt_count: 0, lockout_until: null }]);
    const ref = refOf(A);
    expect(ref).toMatch(UUID);
    expect(ref).not.toBe(MANAGER_A);
    expect(column({ of: A, name: 'display_name' })).toBe('Manager A');
    expect(column({ of: A, name: 'enrolled_at' })).toBe(NOW);
    expect(column({ of: A, name: 'last_online_at' })).toBe(ONLINE_AT);
  });

  it('gives each record its own handle', async () => {
    await enrol(A);
    await enrol(B);
    expect(refOf(A)).not.toBe(refOf(B));
  });

  it('refuses to replace a PIN without the current one', async () => {
    await enrol(A);
    await expect(enrol({ ...A, pin: PIN_B })).resolves.toEqual({ kind: 'current_pin_required' });
    await expect(verify(A)).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_A,
    });
  });

  it('replaces the PIN with the right current one, keeping the handle and clearing the lockout', async () => {
    await enrol(A);
    const ref = refOf(A);
    setLockout({ of: A, until: PAST(), failed: 3 });
    const later = '2026-10-06T09:00:00.000Z';
    const signedInAgain = '2026-10-06T08:59:00.000Z';
    await expect(
      enrol(
        { ...A, pin: PIN_B },
        {
          currentPin: PIN_A,
          displayName: 'Mona',
          now: later,
          onlineAt: signedInAgain,
        },
      ),
    ).resolves.toEqual({ kind: 'enrolled' });
    expect(column({ of: A, name: 'last_online_at' })).toBe(signedInAgain);
    expect(refOf(A)).toBe(ref);
    expect(rows()).toEqual([{ user_id: MANAGER_A, failed_attempt_count: 0, lockout_until: null }]);
    expect(column({ of: A, name: 'display_name' })).toBe('Mona');
    expect(column({ of: A, name: 'enrolled_at' })).toBe(later);
    await expect(verify(A, { now: later })).resolves.toEqual({ kind: 'invalid' });
    await expect(verify(A, { pin: PIN_B, now: later })).resolves.toMatchObject({
      kind: 'verified',
    });
  });

  it('counts a wrong current PIN as a failed attempt and keeps the old PIN', async () => {
    await enrol(A);
    await expect(enrol({ ...A, pin: PIN_B }, { currentPin: WRONG })).resolves.toEqual({
      kind: 'current_pin_invalid',
    });
    expect(failures(A)).toBe(1);
    await expect(verify(A)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('refuses a replacement when the record’s seal does not open, counting nothing', async () => {
    await enrol(A);
    raw.run('UPDATE manager_pin_records SET pin_hash = ?', [new Uint8Array([1, 2, 3])]);
    await expect(enrol({ ...A, pin: PIN_B }, { currentPin: PIN_A })).resolves.toEqual({
      kind: 'current_pin_invalid',
    });
    expect(failures(A)).toBe(0);
    expect(column({ of: A, name: 'pin_hash' })).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses a replacement while the record is locked out', async () => {
    await enrol(A);
    setLockout({ of: A, until: FUTURE() });
    await expect(enrol({ ...A, pin: PIN_B }, { currentPin: PIN_A })).resolves.toEqual({
      kind: 'current_pin_locked',
    });
  });

  it('runs the guard right before the write, and writes nothing when it throws', async () => {
    await enrol(A);
    const seen: unknown[] = [];
    const guard = vi.fn(() => {
      seen.push(failures(A));
      throw new Error('session changed');
    });
    setLockout({ of: A, until: PAST(), failed: 2 });
    await expect(enrol({ ...A, pin: PIN_B }, { currentPin: PIN_A, guard })).rejects.toThrow(
      'session changed',
    );
    // The current PIN was verified (failures cleared) before the guard ran.
    expect(seen).toEqual([0]);
    await expect(verify(A)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('runs the guard before a first enrolment too', async () => {
    const guard = vi.fn(() => {
      throw new Error('locked');
    });
    await expect(enrol(A, { guard })).rejects.toThrow('locked');
    expect(rows()).toEqual([]);
  });

  it('does not run the guard when the current PIN is wrong', async () => {
    await enrol(A);
    const guard = vi.fn();
    await enrol({ ...A, pin: PIN_B }, { currentPin: WRONG, guard });
    expect(guard).not.toHaveBeenCalled();
  });
});

describe('verification of one record, by its handle', () => {
  it('verifies the named manager with their own PIN', async () => {
    await enrol(A);
    await enrol(B);
    await expect(verify(B)).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_B,
    });
  });

  it('never approves as another manager, even with that manager’s PIN', async () => {
    await enrol(A);
    await enrol(B);
    await expect(verify(A, { pin: PIN_B })).resolves.toEqual({ kind: 'invalid' });
    expect(failures(A)).toBe(1);
    expect(failures(B)).toBe(0);
  });

  it('lets two managers share a PIN without one approving for the other (Codex P1)', async () => {
    await enrol(A);
    await enrol({ ...B, pin: PIN_A });
    setLockout({ of: A, until: FUTURE() });
    await expect(verify(A)).resolves.toEqual({ kind: 'locked' });
    await expect(verify(B, { pin: PIN_A })).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_B,
    });
  });

  it('answers invalid for an unknown handle, counting nothing', async () => {
    await enrol(A);
    await expect(
      store.verify({ scope: SCOPE, managerRef: MANAGER_A, pin: PIN_A, now: NOW }),
    ).resolves.toEqual({ kind: 'invalid' });
    expect(failures(A)).toBe(0);
  });

  it.each<[string, ManagerPinScope]>([
    ['another terminal', { ...SCOPE, terminalId: 'term-2' }],
    ['another branch', { ...SCOPE, branchId: 'b2' }],
    ['another tenant', { ...SCOPE, tenantId: 't2' }],
  ])('never verifies a record of %s', async (_name, other) => {
    await enrol(A, { scope: other });
    const managerRef = refOf(A);
    await expect(store.verify({ scope: SCOPE, managerRef, pin: PIN_A, now: NOW })).resolves.toEqual(
      { kind: 'invalid' },
    );
    expect(failures(A)).toBe(0);
  });

  it('skips a record whose seal does not open, counting nothing', async () => {
    await enrol(A);
    raw.run('UPDATE manager_pin_records SET pin_hash = ?', [new Uint8Array([1, 2, 3])]);
    await expect(verify(A)).resolves.toEqual({ kind: 'invalid' });
    expect(failures(A)).toBe(0);
  });
});

describe('expiry: 30 days after the last online sign-in on this terminal (P2-1)', () => {
  it('is 30 days', () => {
    expect(MANAGER_ONLINE_VALIDITY_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('verifies up to exactly 30 days, then answers expired without checking or counting', async () => {
    await enrol(A);
    await expect(verify(A, { now: atOffset(MANAGER_ONLINE_VALIDITY_MS) })).resolves.toEqual({
      kind: 'verified',
      userId: MANAGER_A,
    });
    const expired = atOffset(MANAGER_ONLINE_VALIDITY_MS + 1);
    await expect(verify(A, { pin: WRONG, now: expired })).resolves.toEqual({ kind: 'expired' });
    await expect(verify(A, { now: expired })).resolves.toEqual({ kind: 'expired' });
    expect(failures(A)).toBe(0);
  });

  it('verifies at the instant of the last online sign-in (elapsed 0)', async () => {
    await enrol(A);
    setLastOnline({ of: A, at: NOW });
    await expect(verify(A)).resolves.toEqual({ kind: 'verified', userId: MANAGER_A });
  });

  // Codex P2 (4194169617): a clock corrected backwards leaves the last
  // sign-in in the future; it must not extend the record's lifetime.
  it.each<[string, number]>([
    ['1 ms', 1],
    ['10 days', 10 * 24 * 60 * 60 * 1000],
  ])(
    'answers expired, without checking or counting, for a last sign-in %s in the future',
    async (_name, aheadMs) => {
      await enrol(A);
      setLastOnline({ of: A, at: new Date(Date.parse(NOW) + aheadMs).toISOString() });
      await expect(verify(A, { pin: WRONG })).resolves.toEqual({ kind: 'expired' });
      await expect(verify(A)).resolves.toEqual({ kind: 'expired' });
      expect(failures(A)).toBe(0);
      expect(store.list({ scope: SCOPE, now: NOW })).toEqual([]);
    },
  );

  it('is valid again after an online sign-in at the corrected time', async () => {
    await enrol(A);
    setLastOnline({ of: A, at: atOffset(MANAGER_ONLINE_VALIDITY_MS) });
    await expect(verify(A)).resolves.toEqual({ kind: 'expired' });
    store.touchOnline({ scope: SCOPE, userId: MANAGER_A, at: NOW });
    await expect(verify(A)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('is refreshed by an online sign-in on this terminal (touchOnline)', async () => {
    await enrol(A);
    const signedIn = atOffset(MANAGER_ONLINE_VALIDITY_MS);
    store.touchOnline({ scope: SCOPE, userId: MANAGER_A.toUpperCase(), at: signedIn });
    expect(column({ of: A, name: 'last_online_at' })).toBe(signedIn);
    await expect(
      verify(A, { now: atOffset(MANAGER_ONLINE_VALIDITY_MS + 1) }),
    ).resolves.toMatchObject({ kind: 'verified' });
  });

  it('touches only the manager’s record in the scope', async () => {
    await enrol(A);
    await enrol(A, { scope: { ...SCOPE, terminalId: 'term-2' } });
    await enrol(B);
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
    await enrol(B, { displayName: 'Zeinab' });
    await enrol(A, { displayName: 'Adel' });
    await enrol(A, { scope: { ...SCOPE, terminalId: 'term-2' } });
    const listed = store.list({ scope: SCOPE, now: NOW });
    expect(listed).toEqual([
      { managerRef: refOf(A), displayName: 'Adel' },
      { managerRef: refOf(B), displayName: 'Zeinab' },
    ]);
    expect(JSON.stringify(listed)).not.toContain(MANAGER_A);
    expect(JSON.stringify(listed)).not.toContain(MANAGER_B);
  });

  it('leaves out an expired record, and keeps a locked one', async () => {
    await enrol(A);
    await enrol(B);
    setLockout({ of: B, until: FUTURE() });
    store.touchOnline({ scope: SCOPE, userId: MANAGER_B, at: atOffset(1) });
    const listed = store.list({ scope: SCOPE, now: atOffset(MANAGER_ONLINE_VALIDITY_MS + 1) });
    expect(listed.map((m) => m.displayName)).toEqual(['Manager b']);
  });
});

describe('lockout (the cashier PIN rule: 5 failures → 5 minutes), per record', () => {
  it('locks on the fifth failure, and then refuses even the right PIN', async () => {
    await enrol(A);
    for (let i = 0; i < 4; i += 1) await verify(A, { pin: WRONG });
    expect(rows()[0]?.lockout_until).toBeNull();
    await expect(verify(A, { pin: WRONG })).resolves.toEqual({ kind: 'invalid' });
    const lockedUntil = Date.parse(rows()[0]?.lockout_until ?? '');
    expect(lockedUntil - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(lockedUntil - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    await expect(verify(A)).resolves.toEqual({ kind: 'locked' });
    expect(failures(A)).toBe(5);
  });

  it('clears the record’s failures on a match', async () => {
    await enrol(A);
    await verify(A, { pin: WRONG });
    await verify(A);
    expect(failures(A)).toBe(0);
  });

  it('verifies again once the lockout has expired, and clears it', async () => {
    await enrol(A);
    setLockout({ of: A, until: PAST() });
    await expect(verify(A)).resolves.toMatchObject({ kind: 'verified' });
    expect(rows()[0]).toEqual({ user_id: MANAGER_A, failed_attempt_count: 0, lockout_until: null });
  });

  it('restarts the count after an expired lockout', async () => {
    await enrol(A);
    setLockout({ of: A, until: PAST() });
    await verify(A, { pin: WRONG });
    expect(rows()[0]).toEqual({ user_id: MANAGER_A, failed_attempt_count: 1, lockout_until: null });
  });

  it('serialises attempts: concurrent wrong PINs each count', async () => {
    await enrol(A);
    await Promise.all([
      verify(A, { pin: WRONG }),
      verify(A, { pin: '111111' }),
      verify(A, { pin: '222222' }),
    ]);
    expect(failures(A)).toBe(3);
  });

  /** A replacement of MANAGER_A's PIN by PIN_B, sealed up front (no await before it starts). */
  async function replacer(): Promise<(attempt: { currentPin: string }) => Promise<unknown>> {
    const sealed = await store.seal(PIN_B);
    return ({ currentPin }) =>
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
    await enrol(A);
    const replace = await replacer();
    await Promise.all([
      verify(A, { pin: WRONG }),
      replace({ currentPin: '111111' }),
      replace({ currentPin: '222222' }),
    ]);
    expect(failures(A)).toBe(3);
  });

  it('serialises an enrolment behind an attempt in flight (nit 9)', async () => {
    await enrol(A);
    const replace = await replacer();
    const attempt = verify(A, { pin: WRONG });
    const replaced = replace({ currentPin: PIN_A });
    await attempt;
    await expect(replaced).resolves.toEqual({ kind: 'enrolled' });
    expect(failures(A)).toBe(0);
    await expect(verify(A, { pin: PIN_B })).resolves.toMatchObject({ kind: 'verified' });
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
    await enrol(A);
    const sealed = await store.seal(PIN_B);
    setLockout({ of: A, until: PAST(), failed: 2 });
    // Another writer replaces the secret after the attempt read the record.
    during = () => {
      during = () => undefined;
      raw.run(
        'UPDATE manager_pin_records SET pin_hash = ?, pin_salt = ?, failed_attempt_count = 0',
        [sealed.pin_hash, sealed.pin_salt],
      );
    };
    await expect(verify(A, { pin: WRONG })).resolves.toEqual({ kind: 'invalid' });
    expect(failures(A)).toBe(0);
  });

  it('keeps serving after an attempt fails unexpectedly', async () => {
    await enrol(A);
    const managerRef = refOf(A);
    raw.exec('ALTER TABLE manager_pin_records RENAME TO manager_pin_records_gone');
    await expect(
      store.verify({ scope: SCOPE, managerRef, pin: PIN_A, now: NOW }),
    ).rejects.toThrow();
    raw.exec('ALTER TABLE manager_pin_records_gone RENAME TO manager_pin_records');
    await expect(verify(A)).resolves.toMatchObject({ kind: 'verified' });
  });
});

describe('purgeOtherTerminalManagerPinRecords (RT-215 decision 5)', () => {
  it('deletes the records of every other terminal and keeps the current one', async () => {
    const old = { ...SCOPE, terminalId: 'term-old' };
    await enrol(A, { scope: old });
    await enrol(B, { scope: old });
    await enrol(A);
    expect(purgeOtherTerminalManagerPinRecords(handleFor(raw), SCOPE.terminalId)).toBe(2);
    expect(rows().map((r) => r.user_id)).toEqual([MANAGER_A]);
  });

  it('refuses an empty terminal id (it would match every record)', () => {
    expect(() => purgeOtherTerminalManagerPinRecords(handleFor(raw), '')).toThrow(/required/);
  });
});
