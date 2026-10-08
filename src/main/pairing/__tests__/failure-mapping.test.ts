import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { mapFailure } from '../failure-mapping.js';

/**
 * 002-terminal-pairing T018 + T036 + T046 + T054 — `mapFailure` tests.
 *
 * `mapFailure` is the pure function the service uses to translate a
 * non-2xx backend envelope into a `PairingOutcome`. US2 (T018) lands the
 * success-path guard + the defensive default. US3 (T036) extends it
 * with the three recoverable-failure body codes documented in
 * `contracts/pairing-http.md`:
 *
 *   400 INVALID_CODE   -> 'invalid_code'
 *   410 EXPIRED_CODE   -> 'expired_code'
 *   409 ALREADY_PAIRED -> 'already_paired'
 *
 * US4 (T046) adds:
 *
 *   409 BRANCH_MISMATCH -> 'branch_mismatch'
 *
 * US5 (T054) adds:
 *
 *   429 RATE_LIMITED   -> 'rate_limited'
 *
 * Discriminator: `body.code`, not the HTTP status. The status comes
 * along for parity with the contract, but routing is body-code driven —
 * `409` is shared between `ALREADY_PAIRED` (US3) and `BRANCH_MISMATCH`
 * (US4), so the function MUST NOT key off status alone. Note also
 * that `mapFailure` is a pure status+body→outcome function: it does
 * NOT touch `retry_after_s` (which lives on the surrounding
 * `PairResult` envelope, parsed by `network.ts`).
 */

describe('mapFailure — success-path guard (T018)', () => {
  it('throws when called with status === 200 (programmer error)', () => {
    expect(() => mapFailure(200, { error: { code: 'anything' } })).toThrow(
      /programmer error|2xx|success/i,
    );
  });

  it('throws for any 2xx status (the contract is "non-success only")', () => {
    for (const status of [200, 201, 202, 204, 206, 299]) {
      expect(() => mapFailure(status, {})).toThrow(/programmer error|2xx|success/i);
    }
  });

  it('returns "unknown_error" for an unrecognised body code on a non-2xx response', () => {
    // Defensive default: any body code that US3/US4/US5 has not yet
    // taught the function to recognise becomes "unknown_error". US2 only
    // ships the guard + this default; per-outcome branches are deferred.
    expect(mapFailure(400, { error: { code: 'WHATEVER' } })).toBe('unknown_error');
    expect(mapFailure(500, {})).toBe('unknown_error');
    expect(mapFailure(409, { error: { code: 'NOT_YET_RECOGNISED' } })).toBe('unknown_error');
  });

  it('never throws for a non-2xx status (always returns a PairingOutcome)', () => {
    // The function only throws on programmer error (2xx). Every other
    // input MUST resolve to a typed outcome. This pins the catch-all
    // shape for US3+: future code MUST extend the recognised-codes
    // table without ever reintroducing a throw on non-2xx.
    for (const status of [400, 401, 403, 404, 409, 410, 422, 429, 500, 502, 503]) {
      expect(() => mapFailure(status, { error: { code: 'UNKNOWN' } })).not.toThrow();
      expect(() => mapFailure(status, {})).not.toThrow();
      expect(() => mapFailure(status, { weird: 'shape' })).not.toThrow();
    }
  });
});

/* ------------------------- T036 ------------------------- */

describe('mapFailure — recoverable failure branches (T036)', () => {
  it('INVALID_CODE -> "invalid_code"', () => {
    expect(mapFailure(400, { error: { code: 'INVALID_CODE' } })).toBe('invalid_code');
  });

  it('INVALID_CODE with the documented { error: { code, message } } envelope -> "invalid_code"', () => {
    expect(
      mapFailure(400, { error: { code: 'INVALID_CODE', message: 'Code not recognised.' } }),
    ).toBe('invalid_code');
  });

  it('EXPIRED_CODE -> "expired_code"', () => {
    expect(mapFailure(410, { error: { code: 'EXPIRED_CODE' } })).toBe('expired_code');
  });

  it('EXPIRED_CODE with the documented { error: { code, message } } envelope -> "expired_code"', () => {
    expect(mapFailure(410, { error: { code: 'EXPIRED_CODE', message: 'Code expired.' } })).toBe(
      'expired_code',
    );
  });

  it('ALREADY_PAIRED -> "already_paired"', () => {
    expect(mapFailure(409, { error: { code: 'ALREADY_PAIRED' } })).toBe('already_paired');
  });

  it('ALREADY_PAIRED with the documented { error: { code, message } } envelope -> "already_paired"', () => {
    expect(
      mapFailure(409, { error: { code: 'ALREADY_PAIRED', message: 'Code already used.' } }),
    ).toBe('already_paired');
  });

  it('routes by error.code, not HTTP status (e.g., INVALID_CODE on a non-400 status)', () => {
    // Defensive: if the backend ever returns INVALID_CODE on a different
    // status (e.g., 422), the body code MUST still drive the outcome.
    // Status is informational, not the discriminator.
    expect(mapFailure(422, { error: { code: 'INVALID_CODE' } })).toBe('invalid_code');
    expect(mapFailure(500, { error: { code: 'INVALID_CODE' } })).toBe('invalid_code');
  });

  it('shares HTTP status 409 between ALREADY_PAIRED (US3) and BRANCH_MISMATCH (US4)', () => {
    // 409 is documented for BOTH ALREADY_PAIRED and BRANCH_MISMATCH.
    // The two MUST resolve to distinct outcomes via body.code routing —
    // a status-only switch would conflate them. US4 (T046) lands the
    // BRANCH_MISMATCH branch; this test pins both 409 mappings.
    expect(mapFailure(409, { error: { code: 'ALREADY_PAIRED' } })).toBe('already_paired');
    expect(mapFailure(409, { error: { code: 'BRANCH_MISMATCH' } })).toBe('branch_mismatch');
  });

  it('unknown body shape -> "unknown_error", never throws (catch-all preserved)', () => {
    // Belt-and-braces re-assertion of the US2 catch-all from T018: any
    // body shape the function does not recognise becomes 'unknown_error',
    // and the function never throws on a non-2xx status.
    expect(mapFailure(400, { error: { code: 'WHATEVER' } })).toBe('unknown_error');
    expect(mapFailure(400, {})).toBe('unknown_error');
    expect(mapFailure(500, { weird: 'shape' })).toBe('unknown_error');
    expect(mapFailure(503, { error: { code: null as unknown as string } })).toBe('unknown_error');
    expect(() => mapFailure(400, { error: { code: 'WHATEVER' } })).not.toThrow();
    expect(() => mapFailure(500, {})).not.toThrow();
  });

  it('case-sensitive body.code matching (lowercase variants are NOT recognised)', () => {
    // The contract specifies UPPER_CASE codes verbatim. A lowercase
    // variant is treated as unknown rather than silently coerced.
    expect(mapFailure(400, { error: { code: 'invalid_code' } })).toBe('unknown_error');
    expect(mapFailure(410, { error: { code: 'expired_code' } })).toBe('unknown_error');
    expect(mapFailure(409, { error: { code: 'already_paired' } })).toBe('unknown_error');
  });
});

/* ------------------------- T046 ------------------------- */

describe('mapFailure — BRANCH_MISMATCH branch (T046)', () => {
  it('BRANCH_MISMATCH -> "branch_mismatch"', () => {
    expect(mapFailure(409, { error: { code: 'BRANCH_MISMATCH' } })).toBe('branch_mismatch');
  });

  it('BRANCH_MISMATCH with the documented { error: { code, message } } envelope -> "branch_mismatch"', () => {
    expect(
      mapFailure(409, {
        error: {
          code: 'BRANCH_MISMATCH',
          message: 'Terminal registered to a different branch.',
        },
      }),
    ).toBe('branch_mismatch');
  });

  it('routes by error.code, not HTTP status (BRANCH_MISMATCH on a non-409 status)', () => {
    // Defensive: if the backend ever returns BRANCH_MISMATCH on a
    // different status, the body code MUST still drive the outcome.
    // Status is informational, not the discriminator (status 409 is
    // shared with ALREADY_PAIRED — body.code is what splits them).
    expect(mapFailure(422, { error: { code: 'BRANCH_MISMATCH' } })).toBe('branch_mismatch');
    expect(mapFailure(500, { error: { code: 'BRANCH_MISMATCH' } })).toBe('branch_mismatch');
  });

  it('BRANCH_MISMATCH does NOT throw (catch-all invariant preserved)', () => {
    // The function only throws on programmer error (2xx status). The
    // new BRANCH_MISMATCH branch MUST keep that invariant.
    expect(() => mapFailure(409, { error: { code: 'BRANCH_MISMATCH' } })).not.toThrow();
    expect(() =>
      mapFailure(409, { error: { code: 'BRANCH_MISMATCH', message: 'x' } }),
    ).not.toThrow();
  });

  it('case-sensitive matching (lowercase "branch_mismatch" NOT recognised)', () => {
    // The contract specifies the UPPER_CASE code verbatim. Lowercase
    // variants are treated as unknown rather than silently coerced.
    expect(mapFailure(409, { error: { code: 'branch_mismatch' } })).toBe('unknown_error');
    expect(mapFailure(409, { error: { code: 'Branch_Mismatch' } })).toBe('unknown_error');
  });

  it('US3 + US4 outcomes coexist: each body.code resolves to its own outcome', () => {
    // Cross-test that adding the BRANCH_MISMATCH branch did not
    // accidentally re-route any of the three US3 outcomes.
    expect(mapFailure(400, { error: { code: 'INVALID_CODE' } })).toBe('invalid_code');
    expect(mapFailure(410, { error: { code: 'EXPIRED_CODE' } })).toBe('expired_code');
    expect(mapFailure(409, { error: { code: 'ALREADY_PAIRED' } })).toBe('already_paired');
    expect(mapFailure(409, { error: { code: 'BRANCH_MISMATCH' } })).toBe('branch_mismatch');
  });
});

/* ------------------------- T054 ------------------------- */

describe('mapFailure — RATE_LIMITED branch (T054)', () => {
  it('RATE_LIMITED -> "rate_limited"', () => {
    expect(mapFailure(429, { error: { code: 'RATE_LIMITED' } })).toBe('rate_limited');
  });

  it('RATE_LIMITED with the documented { error: { code, message } } envelope -> "rate_limited"', () => {
    expect(
      mapFailure(429, {
        error: { code: 'RATE_LIMITED', message: 'Too many attempts.' },
      }),
    ).toBe('rate_limited');
  });

  it('routes by error.code, not HTTP status (RATE_LIMITED on a non-429 status)', () => {
    // Defensive: even if the backend mis-issues RATE_LIMITED on a
    // different status, the body code drives the outcome. Note that
    // network.ts gates retry_after_s on status === 429 specifically,
    // so the timer surface won't fire here — but the outcome category
    // is still routed correctly.
    expect(mapFailure(503, { error: { code: 'RATE_LIMITED' } })).toBe('rate_limited');
    expect(mapFailure(400, { error: { code: 'RATE_LIMITED' } })).toBe('rate_limited');
  });

  it('RATE_LIMITED does NOT throw (catch-all invariant preserved)', () => {
    expect(() => mapFailure(429, { error: { code: 'RATE_LIMITED' } })).not.toThrow();
    expect(() => mapFailure(429, { error: { code: 'RATE_LIMITED', message: 'x' } })).not.toThrow();
  });

  it('case-sensitive matching (lowercase "rate_limited" NOT recognised)', () => {
    // The contract specifies the UPPER_CASE code verbatim.
    expect(mapFailure(429, { error: { code: 'rate_limited' } })).toBe('unknown_error');
    expect(mapFailure(429, { error: { code: 'Rate_Limited' } })).toBe('unknown_error');
  });

  it('mapFailure does NOT touch retry_after_s (pure status+body->outcome)', () => {
    // Belt-and-braces: the function signature accepts only (status,
    // body) — it never sees retry_after_s. This test pins the surface
    // by passing a body with a `retry_after_s` field and asserting
    // the function still routes purely on `code`. The field flows
    // around mapFailure via the surrounding PairResult envelope.
    const bodyWithExtra = {
      error: { code: 'RATE_LIMITED', message: 'slow down' },
      retry_after_s: 99, // ignored by mapFailure
    };
    expect(mapFailure(429, bodyWithExtra)).toBe('rate_limited');
  });

  it('US3 + US4 + US5 outcomes coexist: each body.code resolves to its own outcome', () => {
    // Cross-test that adding the RATE_LIMITED branch did not
    // accidentally re-route any of the previously-shipped outcomes.
    expect(mapFailure(400, { error: { code: 'INVALID_CODE' } })).toBe('invalid_code');
    expect(mapFailure(410, { error: { code: 'EXPIRED_CODE' } })).toBe('expired_code');
    expect(mapFailure(409, { error: { code: 'ALREADY_PAIRED' } })).toBe('already_paired');
    expect(mapFailure(409, { error: { code: 'BRANCH_MISMATCH' } })).toBe('branch_mismatch');
    expect(mapFailure(429, { error: { code: 'RATE_LIMITED' } })).toBe('rate_limited');
  });
});

/* ------------------------- RT-228 ------------------------- */

/**
 * RT-228 — Backend-Core returns pairing failures in the canonical envelope
 * `{ "error": { "code", "message", "request_id"? } }`
 * (`pos-terminal-pairing.openapi.yaml` `components.schemas.Error`, pinned in
 * `contracts/backend-core/`). `mapFailure` must read `error.code`; the legacy
 * flat top-level `{ code, message }` is no longer documented by the pinned
 * contract and is NOT a supported shape.
 */
describe('mapFailure — canonical { error: { code } } envelope (RT-228)', () => {
  const envelope = (code: unknown, extra: Record<string, unknown> = {}) => ({
    error: { code, message: 'server message', ...extra },
  });

  it.each([
    [404, 'INVALID_CODE', 'invalid_code'],
    [410, 'EXPIRED_CODE', 'expired_code'],
    [409, 'ALREADY_PAIRED', 'already_paired'],
    [409, 'BRANCH_MISMATCH', 'branch_mismatch'],
    [429, 'RATE_LIMITED', 'rate_limited'],
  ] as const)('%i %s in the envelope -> %s', (status, code, outcome) => {
    expect(mapFailure(status, envelope(code))).toBe(outcome);
  });

  it('accepts the optional request_id the contract allows (string or null)', () => {
    const rid = '0190f3a2-7b1c-7d2e-8a4b-3c5d6e7f8091';
    expect(mapFailure(404, envelope('INVALID_CODE', { request_id: rid }))).toBe('invalid_code');
    expect(mapFailure(404, envelope('INVALID_CODE', { request_id: null }))).toBe('invalid_code');
  });

  it('routes by error.code, not by HTTP status (409 is shared)', () => {
    expect(mapFailure(409, envelope('ALREADY_PAIRED'))).toBe('already_paired');
    expect(mapFailure(409, envelope('BRANCH_MISMATCH'))).toBe('branch_mismatch');
    expect(mapFailure(500, envelope('RATE_LIMITED'))).toBe('rate_limited');
  });

  it('400 validation_failure (documented, no dedicated outcome) -> "unknown_error"', () => {
    expect(mapFailure(400, envelope('validation_failure'))).toBe('unknown_error');
  });

  it('an unknown error.code -> "unknown_error"', () => {
    expect(mapFailure(400, envelope('SOMETHING_NEW'))).toBe('unknown_error');
    expect(mapFailure(500, envelope('INTERNAL'))).toBe('unknown_error');
  });

  it('error.code matching is case-sensitive', () => {
    expect(mapFailure(404, envelope('invalid_code'))).toBe('unknown_error');
    expect(mapFailure(429, envelope('Rate_Limited'))).toBe('unknown_error');
  });

  it('the legacy flat top-level { code } is no longer read -> "unknown_error"', () => {
    expect(mapFailure(404, { code: 'INVALID_CODE', message: 'x' })).toBe('unknown_error');
    expect(mapFailure(429, { code: 'RATE_LIMITED' })).toBe('unknown_error');
  });

  it('error.code wins over a stray top-level code', () => {
    expect(mapFailure(404, { code: 'EXPIRED_CODE', ...envelope('INVALID_CODE') })).toBe(
      'invalid_code',
    );
    expect(mapFailure(404, { code: 'INVALID_CODE', ...envelope('SOMETHING_NEW') })).toBe(
      'unknown_error',
    );
  });

  it('malformed envelopes degrade to "unknown_error" and never throw', () => {
    const bodies: Array<Record<string, unknown>> = [
      {},
      { error: null },
      { error: 'INVALID_CODE' },
      { error: ['INVALID_CODE'] },
      { error: {} },
      { error: { code: null } },
      { error: { code: 404 } },
      { error: { code: { nested: 'INVALID_CODE' } } },
      { error: { message: 'no code' } },
    ];
    for (const body of bodies) {
      expect(mapFailure(400, body)).toBe('unknown_error');
    }
  });

  it('does not read inherited properties of error (prototype-pollution safe)', () => {
    const inherited = { error: Object.create({ code: 'INVALID_CODE' }) as unknown };
    expect(mapFailure(404, inherited as Record<string, unknown>)).toBe('unknown_error');
  });

  it('covers EXACTLY the error.code enum of the pinned pos-terminal-pairing contract', () => {
    // Drift guard: re-pinning Backend-Core with a new/renamed pairing error code
    // must turn this red so the mapping (or this table) is revisited.
    const contract = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../contracts/backend-core/openapi/pos-terminal-pairing.openapi.yaml',
      ),
      'utf8',
    );
    const errorSchema = contract.slice(contract.indexOf('\n    Error:\n'));
    const enumBlock = /\n {14}enum:\n((?: {16}- .+\n)+)/.exec(errorSchema);
    expect(enumBlock).not.toBeNull();
    const documented = (enumBlock?.[1] ?? '')
      .trim()
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim());

    const expected: Record<string, string> = {
      INVALID_CODE: 'invalid_code',
      EXPIRED_CODE: 'expired_code',
      ALREADY_PAIRED: 'already_paired',
      BRANCH_MISMATCH: 'branch_mismatch',
      RATE_LIMITED: 'rate_limited',
      validation_failure: 'unknown_error',
    };
    expect([...documented].sort()).toEqual(Object.keys(expected).sort());
    for (const code of documented) {
      expect(mapFailure(400, { error: { code, message: 'm' } }), code).toBe(expected[code]);
    }
  });
});
