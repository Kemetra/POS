import { describe, expect, it, vi } from 'vitest';

import type { ClerkExchangeResult } from '../clerk-client.js';
import {
  createDescopeExchanger,
  isDescopeProjectId,
  isRegionalDescopeProjectId,
} from '../descope-client.js';

/**
 * RT-792 — Descope password sign-in exchanger (RT-790 approach A).
 *
 * Mirrors `clerk-client.test.ts`. Verifies:
 *  - One POST to `https://api.descope.com/v1/auth/password/signin` with
 *    `Authorization: Bearer <projectId>` and JSON `{ loginId, password }`.
 *  - `sessionJwt` → `jwt`, `user.userId` → `operator_id`, name/email →
 *    `display_name`, role defaults to `manager` (Backend-Core is authoritative).
 *  - The `refreshJwt` is discarded: it never appears in the result.
 *  - Non-2xx and malformed bodies collapse to `{ kind: 'refused' }`
 *    (no factor distinction); transport failure and timeout → `no_connection`.
 *  - PR-1: the password never reaches a thrown error or a returned value.
 */

const PROJECT_ID = 'P2abcdefghijklmnopqrstuvwxyz';
const SIGN_IN_URL = 'https://api.descope.com/v1/auth/password/signin';
const SESSION_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJVMSJ9.c2Vzc2lvbg';
const REFRESH_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJVMSJ9.cmVmcmVzaA';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function stringifyInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function bodyAsString(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body;
  throw new Error('test fixture: body was not a string');
}

function cannedFetch(response: Response): { fetchImpl: FetchImpl; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fetchImpl: FetchImpl = (input, init) => {
    captured.push({ url: stringifyInput(input), init: init ?? {} });
    return Promise.resolve(response);
  };
  return { fetchImpl, captured };
}

/** The Descope password sign-in 200 body (JWT response in body). */
function signInBody(user: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionJwt: SESSION_JWT,
    refreshJwt: REFRESH_JWT,
    cookieDomain: '',
    cookiePath: '/',
    user: {
      userId: 'U2abc',
      loginIds: ['sara@x.test'],
      name: 'Sara K.',
      email: 'sara@x.test',
      ...user,
    },
    firstSeen: false,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function exchangerFor(fetchImpl: FetchImpl, timeoutMs?: number) {
  return createDescopeExchanger({
    projectId: PROJECT_ID,
    fetch: fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('isDescopeProjectId', () => {
  it('accepts a Descope project id', () => {
    expect(isDescopeProjectId(PROJECT_ID)).toBe(true);
  });

  it('refuses empty, short, non-P or unsafe values', () => {
    expect(isDescopeProjectId('')).toBe(false);
    expect(isDescopeProjectId('P123')).toBe(false);
    expect(isDescopeProjectId('X2abcdefghijklmnopqrstuvwxyz')).toBe(false);
    expect(isDescopeProjectId('P2abcdefghijklmnop/qrstuvwxyz')).toBe(false);
    expect(isDescopeProjectId('P2abcdefghijklmnop qrstuvwxyz')).toBe(false);
    expect(isDescopeProjectId(`P${'a'.repeat(80)}`)).toBe(false);
  });

  it('flags a 32+ character id as a regional project', () => {
    expect(isRegionalDescopeProjectId(PROJECT_ID)).toBe(false);
    expect(isRegionalDescopeProjectId(`Peuc1${'a'.repeat(27)}`)).toBe(true);
  });
});

describe('createDescopeExchanger — request shape', () => {
  it('POSTs JSON { loginId, password } to the password sign-in endpoint with the project id', async () => {
    const { fetchImpl, captured } = cannedFetch(jsonResponse(signInBody()));
    await exchangerFor(fetchImpl).exchange({ identifier: 'sara@x.test', password: 'p455' });

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call?.url).toBe(SIGN_IN_URL);
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${PROJECT_ID}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(bodyAsString(call?.init.body))).toEqual({
      loginId: 'sara@x.test',
      password: 'p455',
    });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    // A redirect would replay the password body elsewhere.
    expect(call?.init.redirect).toBe('error');
  });

  it('trims surrounding whitespace from the identifier, never from the password', async () => {
    const { fetchImpl, captured } = cannedFetch(jsonResponse(signInBody()));
    await exchangerFor(fetchImpl).exchange({ identifier: '  sara@x.test \t', password: ' p ' });

    expect(JSON.parse(bodyAsString(captured[0]?.init.body))).toEqual({
      loginId: 'sara@x.test',
      password: ' p ',
    });
  });
});

describe('createDescopeExchanger — success mapping', () => {
  it('maps sessionJwt, userId and name; role defaults to manager', async () => {
    const { fetchImpl } = cannedFetch(jsonResponse(signInBody()));
    const result = await exchangerFor(fetchImpl).exchange({ identifier: 'i', password: 'p' });

    expect(result).toEqual<ClerkExchangeResult>({
      kind: 'ok',
      jwt: SESSION_JWT,
      operator_id: 'U2abc',
      display_name: 'Sara K.',
      role: 'manager',
    });
  });

  it('discards the refreshJwt: it is nowhere in the result', async () => {
    const { fetchImpl } = cannedFetch(jsonResponse(signInBody()));
    const result = await exchangerFor(fetchImpl).exchange({ identifier: 'i', password: 'p' });
    expect(JSON.stringify(result)).not.toContain(REFRESH_JWT);
  });

  it('never maps a Descope role name: the role stays manager (never cashier)', async () => {
    const { fetchImpl } = cannedFetch(jsonResponse(signInBody({ roleNames: ['cashier'] })));
    const result = await exchangerFor(fetchImpl).exchange({ identifier: 'i', password: 'p' });
    expect(result.kind === 'ok' ? result.role : null).toBe('manager');
  });

  it('falls back from name to email, then to the user id', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: '  ' }, 'sara@x.test'],
      [{ name: undefined, email: '' }, 'U2abc'],
    ];
    for (const [user, expected] of cases) {
      const { fetchImpl } = cannedFetch(jsonResponse(signInBody(user)));
      const result = await exchangerFor(fetchImpl).exchange({ identifier: 'i', password: 'p' });
      expect(result.kind === 'ok' ? result.display_name : null).toBe(expected);
    }
  });

  it('passes the userId and sessionJwt through unchanged (never trimmed)', async () => {
    const { fetchImpl } = cannedFetch(jsonResponse(signInBody({ userId: ' U2abc ' })));
    const result = await exchangerFor(fetchImpl).exchange({ identifier: 'i', password: 'p' });
    expect(result.kind === 'ok' ? [result.operator_id, result.jwt] : null).toEqual([
      ' U2abc ',
      SESSION_JWT,
    ]);
  });
});

describe('createDescopeExchanger — generic refusal (PR-2)', () => {
  it.each([400, 401, 403, 404, 429, 500])('collapses HTTP %i to refused', async (status) => {
    const { fetchImpl } = cannedFetch(
      jsonResponse({ errorCode: 'E062108', errorDescription: 'User not found' }, status),
    );
    const result = await exchangerFor(fetchImpl).exchange({ identifier: 'i', password: 'p' });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'refused' });
  });

  it('wrong password and unknown user give the same result', async () => {
    const wrong = cannedFetch(jsonResponse({ errorCode: 'E062901' }, 401));
    const unknown = cannedFetch(jsonResponse({ errorCode: 'E062108' }, 400));
    const a = await exchangerFor(wrong.fetchImpl).exchange({ identifier: 'i', password: 'p' });
    const b = await exchangerFor(unknown.fetchImpl).exchange({ identifier: 'i', password: 'p' });
    expect(a).toEqual(b);
  });

  it('returns refused on a malformed JSON body', async () => {
    const { fetchImpl } = cannedFetch(new Response('not json', { status: 200 }));
    const result = await exchangerFor(fetchImpl).exchange({ identifier: 'i', password: 'p' });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'refused' });
  });

  it.each<[string, unknown]>([
    ['a non-object body', 'just a string'],
    ['a null body', null],
    ['no sessionJwt', { ...signInBody(), sessionJwt: undefined }],
    ['an empty sessionJwt (token held in a cookie)', { ...signInBody(), sessionJwt: '' }],
    ['no user', { sessionJwt: SESSION_JWT }],
    ['no userId', signInBody({ userId: undefined })],
    ['an empty userId', signInBody({ userId: '' })],
    ['a non-string userId', signInBody({ userId: 42 })],
    ['a non-string sessionJwt', { ...signInBody(), sessionJwt: 42 }],
    ['an array user', { sessionJwt: SESSION_JWT, user: ['U2abc'] }],
  ])('returns refused on %s', async (_label, body) => {
    const { fetchImpl } = cannedFetch(jsonResponse(body));
    const result = await exchangerFor(fetchImpl).exchange({ identifier: 'i', password: 'p' });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'refused' });
  });
});

describe('createDescopeExchanger — transport', () => {
  it('returns no_connection on a network rejection', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    const result = await exchangerFor(fetchImpl).exchange({ identifier: 'i', password: 'p' });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'no_connection' });
  });

  it('returns no_connection when the request times out', async () => {
    const fetchImpl: FetchImpl = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const result = await exchangerFor(fetchImpl, 5).exchange({ identifier: 'i', password: 'p' });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'no_connection' });
  });

  it('returns no_connection when the timeout cuts off the response body', async () => {
    const fetchImpl: FetchImpl = (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(init.signal?.reason);
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const result = await exchangerFor(fetchImpl, 5).exchange({ identifier: 'i', password: 'p' });
    expect(result).toEqual<ClerkExchangeResult>({ kind: 'no_connection' });
  });
});

describe('createDescopeExchanger — PR-1 redaction', () => {
  const SECRET_PASSWORD = 'p455-must-not-leak';

  it('a thrown transport error does NOT carry the password', async () => {
    let thrown: unknown = null;
    const fetchImpl = vi.fn(() => {
      const err = new Error('ECONNREFUSED');
      thrown = err;
      return Promise.reject(err);
    });
    const result = await exchangerFor(fetchImpl).exchange({
      identifier: 'i',
      password: SECRET_PASSWORD,
    });
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(
      SECRET_PASSWORD,
    );
    expect(JSON.stringify(result)).not.toContain(SECRET_PASSWORD);
  });

  it('no result (ok or refused) carries the password', async () => {
    for (const response of [jsonResponse(signInBody()), jsonResponse({}, 401)]) {
      const { fetchImpl } = cannedFetch(response);
      const result = await exchangerFor(fetchImpl).exchange({
        identifier: 'i',
        password: SECRET_PASSWORD,
      });
      expect(JSON.stringify(result)).not.toContain(SECRET_PASSWORD);
    }
  });
});
