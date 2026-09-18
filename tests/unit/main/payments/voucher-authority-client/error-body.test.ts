/**
 * 006 Wave 3 — `extractErrorCode` defensive parser tests.
 *
 * Direct unit coverage for the `unknown → string | undefined`
 * extractor used by the three voucher V-A clients. Covers the
 * non-object, missing-error-key, and non-string-code branches so the
 * client-level tests stay focused on transport / mapping semantics.
 */
import { describe, expect, it } from 'vitest';

import { extractErrorCode } from '../../../../../src/main/payments/voucher-authority-client/error-body.js';

describe('extractErrorCode', () => {
  it('returns the code on a well-formed Error envelope', () => {
    expect(extractErrorCode({ error: { code: 'voucher_expired', message: 'expired' } })).toBe(
      'voucher_expired',
    );
  });

  it('returns undefined for null', () => {
    expect(extractErrorCode(null)).toBeUndefined();
  });

  it('returns undefined for a primitive', () => {
    expect(extractErrorCode('plain string')).toBeUndefined();
    expect(extractErrorCode(42)).toBeUndefined();
    expect(extractErrorCode(undefined)).toBeUndefined();
  });

  it('returns undefined when `error` is missing', () => {
    expect(extractErrorCode({ message: 'no error key' })).toBeUndefined();
  });

  it('returns undefined when `error` is not an object', () => {
    expect(extractErrorCode({ error: 'not-an-object' })).toBeUndefined();
    expect(extractErrorCode({ error: null })).toBeUndefined();
  });

  it('returns undefined when `error.code` is missing', () => {
    expect(extractErrorCode({ error: { message: 'no code' } })).toBeUndefined();
  });

  it('returns undefined when `error.code` is not a string', () => {
    expect(extractErrorCode({ error: { code: 42 } })).toBeUndefined();
    expect(extractErrorCode({ error: { code: null } })).toBeUndefined();
  });
});
