import { describe, expect, it } from 'vitest';

import { REAUTH_MARK_TTL_MS, createJwtHolder } from '../jwt-holder.js';

/**
 * 004-operator-session — main-process JwtHolder tests.
 */

describe('JwtHolder', () => {
  it('returns null for an unknown session id', () => {
    const h = createJwtHolder();
    expect(h.get('unknown')).toBeNull();
  });

  it('stores and retrieves a JWT keyed by backend session id', () => {
    const h = createJwtHolder();
    h.set('be-1', 'jwt-a');
    h.set('be-2', 'jwt-b');
    expect(h.get('be-1')).toBe('jwt-a');
    expect(h.get('be-2')).toBe('jwt-b');
  });

  it('overwrites an existing entry on subsequent set', () => {
    const h = createJwtHolder();
    h.set('be-1', 'old');
    h.set('be-1', 'new');
    expect(h.get('be-1')).toBe('new');
  });

  it('clear removes the entry; further get returns null', () => {
    const h = createJwtHolder();
    h.set('be-1', 'jwt');
    h.clear('be-1');
    expect(h.get('be-1')).toBeNull();
  });

  it('clear is idempotent on an unknown id', () => {
    const h = createJwtHolder();
    expect(() => {
      h.clear('unknown');
    }).not.toThrow();
  });

  // Envelope-retention (sync-gap fix): DP-2's takeover-confirm idempotent replay
  // returns `envelope: null` meaning "use the one you already hold". POS call
  // sites normalize that to '' before calling set(). An empty set MUST NOT clobber
  // a previously-held non-empty value — otherwise the sale-sync drain loses its
  // operator credential and never POSTs. A real removal goes through clear().
  it('does NOT overwrite a held non-empty value with an empty string (retain on empty set)', () => {
    const h = createJwtHolder();
    h.set('be-1', 'real-envelope');
    h.set('be-1', ''); // replay → '' ; must be ignored, prior value retained
    expect(h.get('be-1')).toBe('real-envelope');
  });

  it('stores an empty value when nothing non-empty is held yet (no prior to protect)', () => {
    const h = createJwtHolder();
    h.set('be-1', '');
    expect(h.get('be-1')).toBe('');
  });

  it('clear still removes a retained value (explicit removal path unaffected)', () => {
    const h = createJwtHolder();
    h.set('be-1', 'real-envelope');
    h.set('be-1', ''); // retained
    h.clear('be-1');
    expect(h.get('be-1')).toBeNull();
  });

  it('RT-215: clearAll drops every held credential (device revoked)', () => {
    const h = createJwtHolder();
    h.set('be-1', 'jwt-1');
    h.set('be-2', 'jwt-2');
    h.clearAll();
    expect(h.get('be-1')).toBeNull();
    expect(h.get('be-2')).toBeNull();
    h.set('be-3', 'jwt-3'); // still usable after a later sign-in
    expect(h.get('be-3')).toBe('jwt-3');
  });
});

describe('JwtHolder — RT-215 refuseWhile (Codex P1)', () => {
  it('drops every write while the device is revoked, and stores again once it is not', () => {
    const revoked = { value: true };
    const h = createJwtHolder({ refuseWhile: () => revoked.value });
    h.set('be-1', 'late-jwt');
    expect(h.get('be-1')).toBeNull();
    revoked.value = false;
    h.set('be-1', 'jwt-after-repair');
    expect(h.get('be-1')).toBe('jwt-after-repair');
  });

  it('a throwing predicate refuses (fail closed)', () => {
    const h = createJwtHolder({
      refuseWhile: () => {
        throw new Error('boom');
      },
    });
    h.set('be-1', 'jwt');
    expect(h.get('be-1')).toBeNull();
  });
});

describe('JwtHolder — RT-358 one-shot "just re-authenticated" mark (RT-247 §2.4)', () => {
  const T0 = 1_000_000;

  it('a set with reauthenticatedAtMs marks the JWT; consumeMark returns true once', () => {
    const h = createJwtHolder();
    h.set('be-1', 'jwt-fresh', { reauthenticatedAtMs: T0 });
    expect(h.hasFreshMark('be-1', T0 + 1)).toBe(true);
    expect(h.consumeMark('be-1', T0 + 1)).toBe(true);
    expect(h.consumeMark('be-1', T0 + 2)).toBe(false);
    expect(h.hasFreshMark('be-1', T0 + 2)).toBe(false);
    expect(h.get('be-1')).toBe('jwt-fresh');
  });

  it('a plain set carries no mark and drops an earlier one', () => {
    const h = createJwtHolder();
    h.set('be-1', 'jwt-a', { reauthenticatedAtMs: T0 });
    h.set('be-1', 'jwt-b');
    expect(h.consumeMark('be-1', T0 + 1)).toBe(false);
  });

  it(`a mark older than REAUTH_MARK_TTL_MS (${String(REAUTH_MARK_TTL_MS)} ms) is ignored, and consuming it still drops it`, () => {
    const h = createJwtHolder();
    h.set('be-1', 'jwt', { reauthenticatedAtMs: T0 });
    expect(h.hasFreshMark('be-1', T0 + REAUTH_MARK_TTL_MS - 1)).toBe(true);
    expect(h.hasFreshMark('be-1', T0 + REAUTH_MARK_TTL_MS)).toBe(false);
    expect(h.consumeMark('be-1', T0 + REAUTH_MARK_TTL_MS)).toBe(false);
  });

  it('a mark from the future (clock went backwards) is not fresh', () => {
    const h = createJwtHolder();
    h.set('be-1', 'jwt', { reauthenticatedAtMs: T0 });
    expect(h.hasFreshMark('be-1', T0 - 1)).toBe(false);
  });

  it('the mark is bound to its session id', () => {
    const h = createJwtHolder();
    h.set('be-1', 'jwt-1', { reauthenticatedAtMs: T0 });
    h.set('be-2', 'jwt-2');
    expect(h.consumeMark('be-2', T0 + 1)).toBe(false);
    expect(h.consumeMark('be-1', T0 + 1)).toBe(true);
  });

  it('clear and clearAll drop the mark with the JWT', () => {
    const h = createJwtHolder();
    h.set('be-1', 'jwt-1', { reauthenticatedAtMs: T0 });
    h.clear('be-1');
    h.set('be-1', 'jwt-1b');
    expect(h.consumeMark('be-1', T0 + 1)).toBe(false);

    h.set('be-2', 'jwt-2', { reauthenticatedAtMs: T0 });
    h.clearAll();
    h.set('be-2', 'jwt-2b');
    expect(h.consumeMark('be-2', T0 + 1)).toBe(false);
  });

  it('an empty replay set neither clobbers the JWT nor its mark', () => {
    const h = createJwtHolder();
    h.set('be-1', 'jwt', { reauthenticatedAtMs: T0 });
    h.set('be-1', '');
    expect(h.get('be-1')).toBe('jwt');
    expect(h.consumeMark('be-1', T0 + 1)).toBe(true);
  });

  it('no mark is stored while the device is revoked', () => {
    const h = createJwtHolder({ refuseWhile: () => true });
    h.set('be-1', 'jwt', { reauthenticatedAtMs: T0 });
    expect(h.consumeMark('be-1', T0 + 1)).toBe(false);
  });
});
