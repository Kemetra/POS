/**
 * RT-15 S2 — the single authorization choke point (Codex P2 on b8d70e8).
 *
 * The authorized actor captured at admission is re-checked (a) in submit after
 * every await, immediately before the journal insert, and (b) in the
 * dispatcher immediately before every POST. Losing authorization while a
 * request is awaited never journals (a) or sends (b).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { LocalReturnRefusal } from '../../../shared/returns/types.js';
import { createReturnsAuthorizer, type ReturnsSession } from '../returns-auth.js';
import {
  LINE_A,
  MANAGER_ACTOR,
  SALE_NUMBER,
  SCOPE,
  categories,
  initReturnsSql,
  returnsHarness,
  seedSyncedSale,
  sessionFor,
  type HarnessState,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;

afterEach(() => {
  h.close();
});

const ONE_A = { saleNumber: SALE_NUMBER, lines: [{ lineRef: LINE_A, quantity: 1 }] };

function journalCount(): number {
  return Number(h.db.exec('SELECT COUNT(*) FROM return_journal')[0]?.values[0]?.[0] ?? 0);
}

describe('(a) submit re-checks the admitted actor before journaling', () => {
  it.each<{ label: string; change: (st: HarnessState) => void; reason: LocalReturnRefusal }>([
    { label: 'the session locks', change: (st) => (st.locked = true), reason: 'session_changed' },
    {
      label: 'a cashier takes over',
      change: (st) => (st.role = 'cashier'),
      reason: 'role_denied',
    },
    { label: 'the manager signs out', change: (st) => (st.role = null), reason: 'session_changed' },
    {
      label: 'another manager signs in',
      change: (st) => (st.role = 'admin'),
      reason: 'session_changed',
    },
    {
      label: 'the envelope is dropped',
      change: (st) => (st.token = null),
      reason: 'session_changed',
    },
    {
      label: 'the flag is turned off',
      change: (st) => (st.enabled = false),
      reason: 'feature_disabled',
    },
  ])('when $label during the live readSale: nothing journaled or sent', async (c) => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    h.backend.onRead = () => {
      c.change(h.state);
    };

    const res = await h.service.submit(ONE_A);

    expect(res).toEqual({ kind: 'refused', reason: c.reason, ret: null });
    expect(journalCount()).toBe(0);
    expect(h.backend.returnCalls()).toHaveLength(0);
    expect(categories(h.audits)).toEqual(['sale.return.refused']);
    expect(h.audits[0]).toMatchObject({
      acting_operator_id: 'op-manager',
      payload: { operation: 'submit', reason: c.reason },
    });
  });
});

describe('lookup / quote / resolve re-check the actor after their await (Codex P2)', () => {
  const CHANGES: {
    label: string;
    change: (st: HarnessState) => void;
    reason: LocalReturnRefusal;
  }[] = [
    { label: 'a lock', change: (st) => (st.locked = true), reason: 'session_changed' },
    { label: 'a cashier switch', change: (st) => (st.role = 'cashier'), reason: 'role_denied' },
  ];
  const OPS = {
    lookup: () => h.service.lookup({ saleNumber: SALE_NUMBER }),
    quote: () => h.service.quote(ONE_A),
  };

  it.each(CHANGES.flatMap((c) => (['lookup', 'quote'] as const).map((op) => ({ ...c, op }))))(
    '$op: $label during the live readSale → $reason, no sale data',
    async (c) => {
      h = returnsHarness();
      seedSyncedSale(h.db);
      h.backend.onRead = () => {
        c.change(h.state);
      };
      await expect(OPS[c.op]()).resolves.toEqual({ kind: 'refused', reason: c.reason });
      expect(h.audits.at(-1)).toMatchObject({
        action_category: 'sale.return.refused',
        payload: { operation: c.op, reason: c.reason },
      });
    },
  );

  it('resolve: a lock during the pass withholds the tally', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    h.backend.onReturn = () => Promise.reject(new TypeError('socket hang up'));
    await h.service.submit(ONE_A);
    h.backend.onReturn = (call, backend) => {
      h.state.locked = true;
      return backend.recordIdempotently(call);
    };
    await expect(h.service.resolve()).resolves.toEqual({
      kind: 'refused',
      reason: 'session_changed',
    });
  });
});

describe('(b) the dispatcher re-checks the actor immediately before the POST', () => {
  it('a switch between the journal write and the send: not sent, the row stays pending', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    h.state.onAudit = (event) => {
      if (event.action_category === 'sale.return.attempted') h.state.role = 'cashier';
    };

    const res = await h.service.submit(ONE_A);

    // The outcome is withheld from the cashier session (no return data).
    expect(res).toEqual({ kind: 'refused', reason: 'role_denied', ret: null });
    expect(h.backend.returnCalls()).toHaveLength(0);
    expect(h.repo.listUnresolved(SCOPE)).toMatchObject([{ state: 'pending', attemptCount: 0 }]);
    expect(h.warnings).toContain('returns:send_deferred_unauthorized');

    // The manager signs back in: the resolver sends it once, under their authority.
    h.state.onAudit = null;
    h.state.role = 'manager';
    await expect(h.resolver.tick()).resolves.toMatchObject({ confirmed: 1 });
    expect(h.backend.returnCalls()).toHaveLength(1);
  });
});

describe('createReturnsAuthorizer.recheck', () => {
  const manager = sessionFor('manager');

  function authorizer(live: {
    session?: ReturnsSession | null;
    enabled?: boolean;
    locked?: boolean;
    envelope?: boolean;
  }) {
    return createReturnsAuthorizer({
      isEnabled: () => live.enabled ?? true,
      getSession: () => (live.session === undefined ? manager : live.session),
      isSessionLocked: () => live.locked ?? false,
      hasEnvelope: () => live.envelope ?? true,
    });
  }

  it.each<[string, Parameters<typeof authorizer>[0], LocalReturnRefusal | null]>([
    ['the same live manager', {}, null],
    ['flag off', { enabled: false }, 'feature_disabled'],
    ['signed out', { session: null }, 'session_changed'],
    ['a cashier', { session: sessionFor('cashier') }, 'role_denied'],
    ['locked', { locked: true }, 'session_changed'],
    ['no envelope', { envelope: false }, 'session_changed'],
    ['another terminal', { session: { ...manager, terminal_id: 'term-2' } }, 'session_changed'],
    ['another session', { session: { ...manager, operator_session_id: 's2' } }, 'session_changed'],
  ])('%s → %s', (_label, live, expected) => {
    expect(authorizer(live).recheck(MANAGER_ACTOR)).toBe(expected);
  });
});
