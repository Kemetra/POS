import { describe, expect, it } from 'vitest';

import { jwtExpiry } from '../jwt-expiry.js';
import { jwtWithExp } from './__helpers__/jwt-fixture.js';

/**
 * RT-358 (RT-247 plan §2.1) — classify a held JWT by its `exp` claim only.
 * Classification, never trust: the backend verifies every JWT it receives.
 */

const NOW_MS = Date.parse('2026-10-11T12:00:00.000Z');

describe('jwtExpiry', () => {
  it('is expired when exp is in the past', () => {
    expect(jwtExpiry(jwtWithExp(NOW_MS / 1000 - 1), NOW_MS)).toBe('expired');
  });

  it('is expired when exp is exactly now', () => {
    expect(jwtExpiry(jwtWithExp(NOW_MS / 1000), NOW_MS)).toBe('expired');
  });

  it('is valid when exp is in the future', () => {
    expect(jwtExpiry(jwtWithExp(NOW_MS / 1000 + 60), NOW_MS)).toBe('valid');
  });

  it.each([
    ['an opaque token', 'opaque-token'],
    ['an empty string', ''],
    ['two segments', 'a.b'],
    ['a non-JSON payload', 'aGVhZGVy.bm90LWpzb24.c2ln'],
    ['a payload without exp', jwtWithPayload({ sub: 'u1' })],
    ['a string exp', jwtWithPayload({ exp: '1700000000' })],
    ['a non-finite exp', jwtWithPayload({ exp: null })],
    ['a JSON array payload', jwtWithPayload([1, 2])],
  ])('is unknown for %s, and never throws', (_label, token) => {
    expect(jwtExpiry(token, NOW_MS)).toBe('unknown');
  });
});

function jwtWithPayload(payload: unknown): string {
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}
