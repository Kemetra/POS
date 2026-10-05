import { describe, expect, it } from 'vitest';

import { createJwtHolder } from '../jwt-holder.js';

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
