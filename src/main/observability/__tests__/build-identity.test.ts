import { describe, expect, it, vi } from 'vitest';

import {
  BUILD_IDENTITY_HEADERS,
  TOKEN_READ_TIMEOUT_MS,
  isReportingRequest,
  parseBuildIdentity,
  withBuildIdentity,
  type BuildIdentity,
} from '../build-identity.js';

/**
 * RT-719 (RT-709 O-8) — the POS reports its build to Backend-Core with three
 * OPTIONAL request headers on the device-token requests of the thirteen
 * "reporting" operations (`pos-terminal-pairing.openapi.yaml`, "Build identity
 * report"). Unknown is never a default: a value the build does not have is a
 * header that is not sent, and a header never fails or changes a request.
 */

const COMMIT = 'a'.repeat(39) + '1';
const PIN = 'b'.repeat(39) + '2';
const IDENTITY: BuildIdentity = { commit: COMMIT, contractPin: PIN };
const DEVICE_TOKEN = 'sentinel-device-token';
const BASE = 'https://backend-core.example';
const REF = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b';
const ID = '0190a3c4-0000-4000-8000-000000000001';

/** The thirteen reporting operations of the contract, by the route POS calls. */
const REPORTING: ReadonlyArray<readonly [string, string, string]> = [
  ['posGetCatalogSnapshot', 'GET', '/api/pos/v1/catalog/snapshot'],
  ['posGetCatalogDeltas', 'GET', '/api/pos/v1/catalog/deltas'],
  ['posCreateCashierAdmission', 'POST', '/api/pos/v1/cashier-admissions'],
  ['posEndCashierAdmission', 'POST', `/api/pos/v1/cashier-admissions/${ID}/end`],
  ['posListCashierAdmissionRoster', 'GET', '/api/pos/v1/cashier-admissions/roster'],
  ['openShift', 'POST', '/api/pos/v1/shifts'],
  ['recordCashMovement', 'POST', `/api/pos/v1/shifts/${ID}/cash-movements`],
  ['closeShift', 'POST', `/api/pos/v1/shifts/${ID}/close`],
  ['listSaleHistory', 'GET', '/api/pos/v1/sale-history'],
  ['readSaleHistoryDetail', 'GET', `/api/pos/v1/sale-history/${REF}`],
  ['recordSaleReprint', 'POST', `/api/pos/v1/sale-history/${REF}/reprints`],
  ['posGetCashVariancePolicy', 'GET', '/api/pos/v1/store/cash-variance-policy'],
  ['captureSale', 'POST', '/api/pos/v1/sales'],
];

/** Near neighbours that are NOT reporting operations (the contract says "nowhere else"). */
const NOT_REPORTING: ReadonlyArray<readonly [string, string, string]> = [
  ['forcedCloseShift', 'POST', `/api/pos/v1/shifts/${ID}/forced-close`],
  ['listStuckShifts', 'GET', '/api/pos/v1/shifts/stuck'],
  ['readSale', 'GET', `/api/pos/v1/sales/${REF}`],
  ['voidSale', 'POST', `/api/pos/v1/sales/${REF}/void`],
  ['returnSale', 'POST', `/api/pos/v1/sales/${REF}/returns`],
  ['refundSale', 'POST', `/api/pos/v1/sales/${REF}/refund`],
  ['posPairTerminal', 'POST', '/api/pos/v1/terminals/pair'],
  ['posRotateTerminalToken', 'POST', '/api/pos/v1/terminals/rotate'],
  ['posReportDeviceHeartbeat', 'POST', '/api/pos/v1/terminals/heartbeat'],
  ['posValidateTrackedLine', 'POST', '/api/pos/v1/tracked-lines/validate'],
  ['posListTrackedLots', 'GET', '/api/pos/v1/tracked-lots'],
  ['operatorSignIn', 'POST', '/api/pos/v1/operators/sign-in'],
  ['operatorSignOut', 'POST', '/api/pos/v1/operators/sign-out'],
  ['operatorRoster', 'GET', '/api/pos/v1/operators/roster'],
  ['voucherValidate', 'POST', '/api/pos/v1/vouchers/validate'],
  ['liveness', 'GET', '/api/health/live'],
  // Wrong verb on a reporting path is not the reporting operation.
  ['catalogSnapshotPost', 'POST', '/api/pos/v1/catalog/snapshot'],
  ['salesGet', 'GET', '/api/pos/v1/sales'],
  ['shiftsGet', 'GET', '/api/pos/v1/shifts'],
  // Prefix / suffix lookalikes.
  ['snapshotSuffix', 'GET', '/api/pos/v1/catalog/snapshot/extra'],
  ['salesPrefix', 'POST', '/x/api/pos/v1/sales'],
];

describe('isReportingRequest', () => {
  it('names exactly the thirteen contract operations', () => {
    expect(REPORTING).toHaveLength(13);
  });

  it.each(REPORTING)('%s is a reporting operation', (_op, method, path) => {
    expect(isReportingRequest(method, path)).toBe(true);
  });

  it.each(NOT_REPORTING)('%s is not a reporting operation', (_op, method, path) => {
    expect(isReportingRequest(method, path)).toBe(false);
  });

  it('tolerates a trailing slash and a lower-case method', () => {
    expect(isReportingRequest('get', '/api/pos/v1/sale-history/')).toBe(true);
  });
});

interface Harness {
  inner: ReturnType<typeof vi.fn>;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  headersOf: (call?: number) => Headers;
}

function harness(
  opts: {
    identity?: () => BuildIdentity | null;
    readDeviceToken?: () => Promise<string | null>;
    baseUrl?: string;
    response?: Response | Error;
  } = {},
): Harness {
  const response = opts.response ?? new Response(null, { status: 200 });
  const inner = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  const fetchImpl = withBuildIdentity(inner, {
    baseUrl: opts.baseUrl ?? BASE,
    identity: opts.identity ?? (() => IDENTITY),
    readDeviceToken: opts.readDeviceToken ?? (() => Promise.resolve(DEVICE_TOKEN)),
  });
  const headersOf = (call = 0): Headers => {
    const init = inner.mock.calls[call]?.[1];
    const input = inner.mock.calls[call]?.[0];
    return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  };
  return { inner, fetchImpl, headersOf };
}

const deviceCall = (method: string, path: string, extra: Record<string, string> = {}) =>
  [
    `${BASE}${path}`,
    { method, headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, ...extra } },
  ] as const;

describe('withBuildIdentity — which requests carry the headers', () => {
  it.each(REPORTING)('%s carries the commit and the contract pin', async (_op, method, path) => {
    const h = harness();
    await h.fetchImpl(...deviceCall(method, path));
    expect(h.headersOf().get('x-pos-build-commit')).toBe(COMMIT);
    expect(h.headersOf().get('x-pos-contract-pin')).toBe(PIN);
  });

  it.each(NOT_REPORTING)('%s carries none of them', async (_op, method, path) => {
    const h = harness();
    await h.fetchImpl(...deviceCall(method, path));
    for (const name of BUILD_IDENTITY_HEADERS) expect(h.headersOf().has(name)).toBe(false);
  });

  it('ignores the query string when it matches the route', async () => {
    const h = harness();
    await h.fetchImpl(...deviceCall('GET', '/api/pos/v1/sale-history?limit=20&cursor=abc'));
    expect(h.headersOf().get('x-pos-build-commit')).toBe(COMMIT);
  });

  it('matches under a base URL that carries a path prefix, and only there', async () => {
    const h = harness({ baseUrl: 'https://gw.example/bc/' });
    await h.fetchImpl('https://gw.example/bc/api/pos/v1/shifts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    await h.fetchImpl('https://gw.example/other/api/pos/v1/shifts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    expect(h.headersOf(0).get('x-pos-build-commit')).toBe(COMMIT);
    expect(h.headersOf(1).has('x-pos-build-commit')).toBe(false);
  });

  it('never sends the app version: POS has no signed release yet (contract: send only when it does)', async () => {
    const h = harness();
    await h.fetchImpl(...deviceCall('POST', '/api/pos/v1/sales'));
    expect(h.headersOf().has('x-pos-app-version')).toBe(false);
    expect(BUILD_IDENTITY_HEADERS).not.toContain('X-POS-App-Version');
  });
});

describe('withBuildIdentity — device credential only', () => {
  it('sends nothing on a reporting route called with an operator credential (sale history, capture)', async () => {
    const h = harness();
    await h.fetchImpl(`${BASE}/api/pos/v1/sale-history`, {
      method: 'GET',
      headers: { Authorization: 'Bearer sentinel-operator-envelope' },
    });
    await h.fetchImpl(`${BASE}/api/pos/v1/sales`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sentinel-operator-envelope' },
    });
    expect(h.headersOf(0).has('x-pos-build-commit')).toBe(false);
    expect(h.headersOf(1).has('x-pos-build-commit')).toBe(false);
  });

  it('sends nothing without an Authorization header', async () => {
    const h = harness();
    await h.fetchImpl(`${BASE}/api/pos/v1/shifts`, { method: 'POST' });
    expect(h.headersOf().has('x-pos-build-commit')).toBe(false);
  });

  it('sends nothing when the terminal holds no sendable device token', async () => {
    const h = harness({ readDeviceToken: () => Promise.resolve(null) });
    await h.fetchImpl(...deviceCall('POST', '/api/pos/v1/shifts'));
    expect(h.headersOf().has('x-pos-build-commit')).toBe(false);
  });

  it('does not read the device token for a route that is not a reporting operation', async () => {
    const readDeviceToken = vi.fn(() => Promise.resolve(DEVICE_TOKEN));
    const h = harness({ readDeviceToken });
    await h.fetchImpl(...deviceCall('POST', '/api/pos/v1/terminals/rotate'));
    expect(readDeviceToken).not.toHaveBeenCalled();
  });
});

describe('withBuildIdentity — unknown is never a default', () => {
  it('sends no header at all when the build has no identity', async () => {
    const h = harness({ identity: () => null });
    await h.fetchImpl(...deviceCall('GET', '/api/pos/v1/catalog/snapshot'));
    for (const name of BUILD_IDENTITY_HEADERS) expect(h.headersOf().has(name)).toBe(false);
  });

  it('sends the commit without a pin when the build has no valid pin', async () => {
    const h = harness({ identity: () => ({ commit: COMMIT, contractPin: null }) });
    await h.fetchImpl(...deviceCall('GET', '/api/pos/v1/catalog/snapshot'));
    expect(h.headersOf().get('x-pos-build-commit')).toBe(COMMIT);
    expect(h.headersOf().has('x-pos-contract-pin')).toBe(false);
  });
});

describe('withBuildIdentity — a header never fails or changes a request', () => {
  it('sends the request unchanged when the device token read rejects', async () => {
    const h = harness({ readDeviceToken: () => Promise.reject(new Error('secret store down')) });
    const res = await h.fetchImpl(...deviceCall('POST', '/api/pos/v1/shifts'));
    expect(res.status).toBe(200);
    expect(h.inner).toHaveBeenCalledTimes(1);
    expect(h.headersOf().has('x-pos-build-commit')).toBe(false);
  });

  it('does not wait on a device token read that never answers', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ readDeviceToken: () => new Promise<string | null>(() => undefined) });
      const sent = h.fetchImpl(...deviceCall('POST', '/api/pos/v1/shifts'));
      await vi.advanceTimersByTimeAsync(TOKEN_READ_TIMEOUT_MS);
      const res = await sent;
      expect(res.status).toBe(200);
      expect(h.inner).toHaveBeenCalledTimes(1);
      expect(h.headersOf().has('x-pos-build-commit')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the request unchanged when the identity getter throws', async () => {
    const h = harness({
      identity: () => {
        throw new Error('boom');
      },
    });
    const res = await h.fetchImpl(...deviceCall('POST', '/api/pos/v1/shifts'));
    expect(res.status).toBe(200);
    expect(h.headersOf().has('x-pos-build-commit')).toBe(false);
  });

  it('passes the response through and rethrows a transport error', async () => {
    const response = new Response('{"ok":true}', { status: 201 });
    const ok = harness({ response });
    await expect(ok.fetchImpl(...deviceCall('POST', '/api/pos/v1/sales'))).resolves.toBe(response);

    const failure = new TypeError('network down');
    const bad = harness({ response: failure });
    await expect(bad.fetchImpl(...deviceCall('POST', '/api/pos/v1/sales'))).rejects.toBe(failure);
  });

  it('keeps the method, body, signal and every other header', async () => {
    const h = harness();
    const signal = new AbortController().signal;
    await h.fetchImpl(`${BASE}/api/pos/v1/sales`, {
      method: 'POST',
      body: '{"a":1}',
      signal,
      headers: {
        Authorization: `Bearer ${DEVICE_TOKEN}`,
        'Idempotency-Key': 'k'.repeat(20),
        'X-Request-Id': 'rid',
      },
    });
    const init = h.inner.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBe(signal);
    expect(h.headersOf().get('idempotency-key')).toBe('k'.repeat(20));
    expect(h.headersOf().get('x-request-id')).toBe('rid');
  });

  it.each([
    ['Headers instance', () => new Headers({ Authorization: `Bearer ${DEVICE_TOKEN}` })],
    ['tuple array', () => [['Authorization', `Bearer ${DEVICE_TOKEN}`]] as [string, string][]],
  ])('reads the credential from a %s', async (_name, make) => {
    const h = harness();
    await h.fetchImpl(`${BASE}/api/pos/v1/shifts`, { method: 'POST', headers: make() });
    expect(h.headersOf().get('x-pos-build-commit')).toBe(COMMIT);
  });

  it('overwrites a header already set by a caller rather than sending two values', async () => {
    const h = harness();
    await h.fetchImpl(
      ...deviceCall('POST', '/api/pos/v1/shifts', { 'X-POS-Build-Commit': 'f'.repeat(40) }),
    );
    expect(h.headersOf().get('x-pos-build-commit')).toBe(COMMIT);
  });

  it('never throws on an unparsable URL', async () => {
    const h = harness();
    await expect(h.fetchImpl('not a url', { method: 'GET' })).resolves.toBeInstanceOf(Response);
  });
});

describe('parseBuildIdentity — the stamp the build wrote', () => {
  const stamp = (o: unknown): string => JSON.stringify(o);

  it('reads a valid commit and pin', () => {
    expect(parseBuildIdentity(stamp({ commit: COMMIT, contractPin: PIN }))).toEqual(IDENTITY);
  });

  it('is unknown (null) without a valid commit, whatever the pin says', () => {
    for (const commit of [
      undefined,
      '',
      'A'.repeat(40),
      'a'.repeat(39),
      'a'.repeat(41),
      'g'.repeat(40),
      7,
    ]) {
      expect(parseBuildIdentity(stamp({ commit, contractPin: PIN }))).toBeNull();
    }
  });

  it('drops an invalid pin but keeps the commit; nothing is repaired or truncated', () => {
    for (const contractPin of [undefined, null, '', 'B'.repeat(40), `${PIN} `, `${PIN}0`, 42]) {
      expect(parseBuildIdentity(stamp({ commit: COMMIT, contractPin }))).toEqual({
        commit: COMMIT,
        contractPin: null,
      });
    }
  });

  it.each([
    ['empty text', ''],
    ['not JSON', 'commit: abc'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['null', 'null'],
  ])('is unknown for %s', (_name, text) => {
    expect(parseBuildIdentity(text)).toBeNull();
  });

  it('ignores any other field the file carries (no hostname, path or user can leak)', () => {
    const parsed = parseBuildIdentity(
      stamp({ commit: COMMIT, contractPin: PIN, hostname: 'pc-1', builtBy: 'someone' }),
    );
    expect(parsed).toEqual(IDENTITY);
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['commit', 'contractPin']);
  });
});
