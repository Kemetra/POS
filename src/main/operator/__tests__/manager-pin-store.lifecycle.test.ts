/**
 * RT-438 (MA-1, RT-114 C3/C4 on the RT-17 credential; migration 0047) — the
 * manager PIN record's lifecycle, over the full migration stack (sql.js) with
 * the real Argon2id hashing and an authenticated safeStorage fake:
 *
 *   • policy per action kind: the RT-17 variance keeps 30 days and no age
 *     limit (the default); the approval default is 24 h after the last online
 *     sign-in and 90 days after the PIN was set;
 *   • the third consecutive lockout disables the record; a success resets the
 *     count; a disabled record answers `revoked`, is not listed, and is
 *     re-enrolled online without its old PIN;
 *   • `revoke` (self / other manager / ineligible) behaves the same way;
 *   • every lifecycle fact is reported with ids only.
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
  MANAGER_PIN_DISABLE_AFTER_LOCKOUTS,
  createManagerPinStore,
  type ManagerCredentialEvent,
  type ManagerPinScope,
  type ManagerPinStore,
} from '../manager-pin-store.js';
import {
  DEFAULT_APPROVAL_POLICY,
  SHIFT_VARIANCE_POLICY,
  credentialPolicyFor,
} from '../manager-approval-policy.js';

const SCOPE: ManagerPinScope = { tenantId: 't1', branchId: 'b1', terminalId: 'term-1' };
const A = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a', pin: '246810' };
const B = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000b', pin: '13579135' };
const WRONG = '000000';
const ONLINE_AT = '2026-10-06T07:59:00.000Z';
const NOW = '2026-10-06T08:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(Date.parse(ONLINE_AT) + ms).toISOString();

let raw: SqlJsDatabase;
let store: ManagerPinStore;
let events: ManagerCredentialEvent[];

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  raw = freshGrantDb();
  events = [];
  store = createManagerPinStore({
    db: handleFor(raw),
    safeStorage: aeadSafeStorage(),
    onEvent: (event) => events.push(event),
  });
});

afterEach(() => {
  raw.close();
});

async function enrol(
  manager: { userId: string; pin: string },
  over: { currentPin?: string; now?: string; onlineAt?: string } = {},
): Promise<unknown> {
  return store.enrol({
    scope: SCOPE,
    userId: manager.userId,
    displayName: `Manager ${manager.userId.slice(-1)}`,
    now: over.now ?? NOW,
    onlineAt: over.onlineAt ?? ONLINE_AT,
    guard: () => undefined,
    sealed: await store.seal(manager.pin),
    ...(over.currentPin === undefined ? {} : { currentPin: over.currentPin }),
  });
}

function value(userId: string, name: string): unknown {
  return raw.exec(`SELECT ${name} FROM manager_pin_records WHERE user_id = ?`, [userId])[0]
    ?.values[0]?.[0];
}

function refOf(userId: string): string {
  return value(userId, 'manager_ref') as string;
}

function verify(
  manager: { userId: string; pin: string },
  opts: { pin?: string; now?: string; policy?: typeof DEFAULT_APPROVAL_POLICY } = {},
): Promise<unknown> {
  return store.verify({
    scope: SCOPE,
    managerRef: refOf(manager.userId),
    pin: opts.pin ?? manager.pin,
    now: opts.now ?? NOW,
    ...(opts.policy === undefined ? {} : { policy: opts.policy }),
  });
}

/** One failure away from a lockout, with `lockouts` consecutive lockouts behind it. */
function primeLockout(userId: string, lockouts: number): void {
  raw.run(
    'UPDATE manager_pin_records SET failed_attempt_count = 4, lockout_count = ? WHERE user_id = ?',
    [lockouts, userId],
  );
}

describe('policy per action kind (RT-114 C4, reconciled)', () => {
  it('keeps the RT-17 variance at 30 days and no age limit; approvals at 24 h and 90 days', () => {
    expect(SHIFT_VARIANCE_POLICY).toEqual({ onlineValidityMs: 30 * DAY, maxAgeMs: null });
    expect(DEFAULT_APPROVAL_POLICY).toEqual({ onlineValidityMs: 24 * HOUR, maxAgeMs: 90 * DAY });
    expect(credentialPolicyFor('shift.variance_accept')).toBe(SHIFT_VARIANCE_POLICY);
    expect(credentialPolicyFor('cart.cancel_post_handoff')).toBe(DEFAULT_APPROVAL_POLICY);
    expect(credentialPolicyFor('recovery.cancel_held_cart')).toBe(DEFAULT_APPROVAL_POLICY);
  });

  it('an approval stops 24 h after the last online sign-in; the variance still verifies', async () => {
    await enrol(A);
    const late = at(24 * HOUR + 1);
    await expect(
      verify(A, { now: at(24 * HOUR), policy: DEFAULT_APPROVAL_POLICY }),
    ).resolves.toMatchObject({
      kind: 'verified',
    });
    await expect(verify(A, { now: late, policy: DEFAULT_APPROVAL_POLICY })).resolves.toEqual({
      kind: 'expired',
    });
    await expect(verify(A, { now: late })).resolves.toMatchObject({ kind: 'verified' });
  });

  it('an approval stops 90 days after the PIN was set, even when the manager signs in daily', async () => {
    await enrol(A);
    const day91 = at(91 * DAY);
    store.touchOnline({ scope: SCOPE, userId: A.userId, at: at(91 * DAY - HOUR) });
    await expect(verify(A, { now: day91, policy: DEFAULT_APPROVAL_POLICY })).resolves.toEqual({
      kind: 'expired',
    });
    // The RT-17 variance has no age limit.
    await expect(verify(A, { now: day91 })).resolves.toMatchObject({ kind: 'verified' });
  });

  it('list follows the policy it is given', async () => {
    await enrol(A);
    const late = at(2 * DAY);
    expect(store.list({ scope: SCOPE, now: late })).toHaveLength(1);
    expect(store.list({ scope: SCOPE, now: late, policy: DEFAULT_APPROVAL_POLICY })).toEqual([]);
  });
});

describe('disable after repeated lockouts (RT-114 C3)', () => {
  it('is the third lockout', () => {
    expect(MANAGER_PIN_DISABLE_AFTER_LOCKOUTS).toBe(3);
  });

  it('counts a lockout, and a success between lockouts resets the count', async () => {
    await enrol(A);
    primeLockout(A.userId, 0);
    await verify(A, { pin: WRONG });
    expect(value(A.userId, 'lockout_count')).toBe(1);
    expect(value(A.userId, 'disabled_at')).toBeNull();
    raw.run('UPDATE manager_pin_records SET lockout_until = ? WHERE user_id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      A.userId,
    ]);
    await expect(verify(A)).resolves.toMatchObject({ kind: 'verified' });
    expect(value(A.userId, 'lockout_count')).toBe(0);
  });

  it('the third consecutive lockout disables the record: revoked, not listed, reported', async () => {
    await enrol(A);
    events = [];
    primeLockout(A.userId, 2);
    await verify(A, { pin: WRONG });
    expect(value(A.userId, 'lockout_count')).toBe(3);
    expect(value(A.userId, 'disabled_at')).toBe(NOW);
    raw.run('UPDATE manager_pin_records SET lockout_until = NULL, failed_attempt_count = 0');
    await expect(verify(A)).resolves.toEqual({ kind: 'revoked' });
    expect(store.list({ scope: SCOPE, now: NOW })).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(['locked_out', 'disabled']);
    expect(events[1]).toEqual({
      kind: 'disabled',
      scope: SCOPE,
      userId: A.userId,
      managerRef: refOf(A.userId),
      at: NOW,
    });
  });

  it('names the session that presented the PIN, captured before the PIN work (review)', async () => {
    await enrol(A);
    events = [];
    primeLockout(A.userId, 0);
    const actor = { operatorId: 'op-cashier-a', sessionId: 'sess-a' };
    await store.verify({
      scope: SCOPE,
      managerRef: refOf(A.userId),
      pin: WRONG,
      now: NOW,
      actor,
    });
    expect(events).toEqual([expect.objectContaining({ kind: 'locked_out', actor })]);
  });

  it('a disabled record is re-enrolled online without the old PIN, keeping its handle and clearing the state', async () => {
    await enrol(A);
    const ref = refOf(A.userId);
    raw.run(
      'UPDATE manager_pin_records SET lockout_count = 3, disabled_at = ?, lockout_until = ? WHERE user_id = ?',
      [NOW, new Date(Date.now() + 60_000).toISOString(), A.userId],
    );
    await expect(enrol({ userId: A.userId, pin: '97531086' })).resolves.toEqual({
      kind: 'enrolled',
    });
    expect(refOf(A.userId)).toBe(ref);
    expect(value(A.userId, 'disabled_at')).toBeNull();
    expect(value(A.userId, 'lockout_count')).toBe(0);
    expect(value(A.userId, 'lockout_until')).toBeNull();
    await expect(verify({ userId: A.userId, pin: '97531086' })).resolves.toMatchObject({
      kind: 'verified',
    });
  });

  it('an active record still needs its current PIN to be replaced', async () => {
    await enrol(A);
    await expect(enrol({ userId: A.userId, pin: '97531086' })).resolves.toEqual({
      kind: 'current_pin_required',
    });
  });
});

describe('revoke (RT-114 C4)', () => {
  it('revokes the requester’s own record as self', async () => {
    await enrol(A);
    events = [];
    await expect(
      store.revoke({
        scope: SCOPE,
        target: { userId: A.userId },
        requesterUserId: A.userId,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: 'revoked', reason: 'self' });
    expect(value(A.userId, 'revoked_at')).toBe(NOW);
    expect(value(A.userId, 'revoke_reason')).toBe('self');
    await expect(verify(A)).resolves.toEqual({ kind: 'revoked' });
    expect(store.list({ scope: SCOPE, now: NOW })).toEqual([]);
    expect(events).toEqual([
      {
        kind: 'revoked',
        scope: SCOPE,
        userId: A.userId,
        managerRef: refOf(A.userId),
        at: NOW,
        revokeReason: 'self',
      },
    ]);
  });

  it('revokes another manager’s record by handle as other_manager, leaving the requester’s', async () => {
    await enrol(A);
    await enrol(B);
    await expect(
      store.revoke({
        scope: SCOPE,
        target: { managerRef: refOf(B.userId) },
        requesterUserId: A.userId,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: 'revoked', reason: 'other_manager' });
    expect(store.list({ scope: SCOPE, now: NOW }).map((m) => m.managerRef)).toEqual([
      refOf(A.userId),
    ]);
  });

  it('without a requester the reason is ineligible (MA-3)', async () => {
    await enrol(A);
    await expect(
      store.revoke({ scope: SCOPE, target: { userId: A.userId }, requesterUserId: null, now: NOW }),
    ).resolves.toEqual({ kind: 'revoked', reason: 'ineligible' });
  });

  it('answers not_found for an unknown, other-scope, already revoked or disabled record', async () => {
    await enrol(A);
    const unknown = {
      scope: SCOPE,
      target: { managerRef: '7f3c1e2a-0b4d-4c5e-8f60-000000000999' },
    };
    await expect(
      store.revoke({ ...unknown, requesterUserId: A.userId, now: NOW }),
    ).resolves.toEqual({
      kind: 'not_found',
    });
    await expect(
      store.revoke({
        scope: { ...SCOPE, terminalId: 'term-2' },
        target: { userId: A.userId },
        requesterUserId: A.userId,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: 'not_found' });
    const self = {
      scope: SCOPE,
      target: { userId: A.userId },
      requesterUserId: A.userId,
      now: NOW,
    };
    await store.revoke(self);
    await expect(store.revoke(self)).resolves.toEqual({ kind: 'not_found' });
    expect(value(A.userId, 'revoke_reason')).toBe('self');
  });

  it('a revoked record is re-enrolled online without its old PIN, and verifies again', async () => {
    await enrol(A);
    await store.revoke({
      scope: SCOPE,
      target: { userId: A.userId },
      requesterUserId: A.userId,
      now: NOW,
    });
    await expect(enrol({ userId: A.userId, pin: '97531086' })).resolves.toEqual({
      kind: 'enrolled',
    });
    expect(value(A.userId, 'revoked_at')).toBeNull();
    expect(value(A.userId, 'revoke_reason')).toBeNull();
    await expect(verify({ userId: A.userId, pin: '97531086' })).resolves.toMatchObject({
      kind: 'verified',
    });
  });
});

describe('revoke runs its guard after queued PIN work (review)', () => {
  it('a guard that fails once the queue drains revokes nothing', async () => {
    await enrol(A);
    let sessionStillValid = true;
    const pending = verify(A, { pin: WRONG }); // in flight: Argon2 work
    const revoked = store.revoke({
      scope: SCOPE,
      target: { userId: A.userId },
      requesterUserId: A.userId,
      now: NOW,
      guard: () => {
        if (!sessionStillValid) throw new Error('no_session');
      },
    });
    sessionStillValid = false; // the manager signs out while the verify runs
    await pending;
    await expect(revoked).rejects.toThrow('no_session');
    expect(value(A.userId, 'revoked_at')).toBeNull();
  });

  it('a passing guard revokes and the event names the revoking session', async () => {
    await enrol(A);
    events = [];
    const actor = { operatorId: 'op-mgr-a', sessionId: 'sess-mgr-a' };
    await expect(
      store.revoke({
        scope: SCOPE,
        target: { userId: A.userId },
        requesterUserId: A.userId,
        now: NOW,
        actor,
        guard: () => undefined,
      }),
    ).resolves.toEqual({ kind: 'revoked', reason: 'self' });
    expect(events).toEqual([expect.objectContaining({ kind: 'revoked', actor })]);
  });
});

describe('lifecycle events carry ids only', () => {
  it('reports an enrolment, and never a PIN, hash or seal in any event', async () => {
    await enrol(A);
    primeLockout(A.userId, 2);
    await verify(A, { pin: '864297' });
    await store.revoke({
      scope: SCOPE,
      target: { userId: A.userId },
      requesterUserId: A.userId,
      now: NOW,
    });
    expect(events[0]).toEqual({
      kind: 'enrolled',
      scope: SCOPE,
      userId: A.userId,
      managerRef: refOf(A.userId),
      at: NOW,
    });
    const text = JSON.stringify(events);
    for (const secret of [A.pin, '864297', 'argon2', 'pin_hash', 'pin_salt']) {
      expect(text).not.toContain(secret);
    }
  });
});
