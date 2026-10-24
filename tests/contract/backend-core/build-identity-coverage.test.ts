/**
 * RT-719 — the build identity headers against the REAL POS clients.
 *
 * `src/main/observability/__tests__/build-identity.test.ts` pins the matcher by
 * hand-written routes. This suite drives every registered client call (RT-217
 * `CLIENT_CALLS`, the production clients against a recording fetch) through
 * `withBuildIdentity`, and checks that the routes the POS really sends are the
 * ones that report: on the device credential, and never on an operator one.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILD_IDENTITY_HEADERS,
  withBuildIdentity,
} from '../../../src/main/observability/build-identity.js';
import { BASE_URL, CLIENT_CALLS, SENTINEL } from './client-registry.js';
import { recordingFetch, sentCredential, type ObservedRequest } from './conformance.js';

const COMMIT = 'a'.repeat(39) + '1';
const PIN = 'b'.repeat(39) + '2';

const reports = (r: ObservedRequest): boolean => r.headers.has('x-pos-build-commit');
const label = (r: ObservedRequest): string => `${r.method.toUpperCase()} ${r.url.pathname}`;

async function observeThroughWrapper(): Promise<ObservedRequest[]> {
  const all: ObservedRequest[] = [];
  for (const call of CLIENT_CALLS) {
    const { fetch, requests } = recordingFetch();
    const wrapped = withBuildIdentity(fetch, {
      baseUrl: BASE_URL,
      identity: () => ({ commit: COMMIT, contractPin: PIN }),
      readDeviceToken: () => Promise.resolve(SENTINEL.device),
    });
    await call.invoke(wrapped);
    all.push(...requests);
  }
  return all;
}

/** Method + contract path template of the calls that are the thirteen operations. */
const REPORTING_CALL_TEMPLATES = [
  'get /api/pos/v1/catalog/snapshot',
  'get /api/pos/v1/cashier-admissions/roster',
  'post /api/pos/v1/cashier-admissions',
  'post /api/pos/v1/shifts',
  'post /api/pos/v1/sales',
];

describe('build identity headers on the real POS clients', () => {
  it('reports on a request iff it is a reporting route sent with the device credential', async () => {
    const requests = await observeThroughWrapper();
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      const credential = sentCredential(r);
      if (credential !== 'device') {
        expect(reports(r), `${label(r)} with ${credential} must not report`).toBe(false);
      }
      if (reports(r)) {
        expect(r.headers.get('x-pos-build-commit')).toBe(COMMIT);
        expect(r.headers.get('x-pos-contract-pin')).toBe(PIN);
        expect(r.headers.has('x-pos-app-version')).toBe(false);
      }
    }
  });

  it('reports on the device-credential routes the POS sends for the reporting operations', async () => {
    const reporting = (await observeThroughWrapper()).filter(reports);
    const seen = new Set(reporting.map((r) => `${r.method} ${r.url.pathname}`));
    const templated = [...seen].map((s) =>
      s.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27}(?=\/|$)/g, '/{id}'),
    );
    for (const expected of REPORTING_CALL_TEMPLATES) {
      expect(
        templated.some((s) => s === expected),
        `${expected} must report; got ${JSON.stringify(templated.sort())}`,
      ).toBe(true);
    }
  });

  it('never reports on the operator, pairing, rotation, void, returns or voucher routes', async () => {
    const requests = await observeThroughWrapper();
    const forbidden =
      /\/(operators|terminals|vouchers|health)\/|\/forced-close$|\/shifts\/stuck$|\/(void|returns|refund)$/;
    const wrongly = requests.filter((r) => forbidden.test(r.url.pathname) && reports(r));
    expect(wrongly.map(label)).toEqual([]);
  });

  it('sends nothing at all when the build has no identity', async () => {
    const all: ObservedRequest[] = [];
    for (const call of CLIENT_CALLS) {
      const { fetch, requests } = recordingFetch();
      const wrapped = withBuildIdentity(fetch, {
        baseUrl: BASE_URL,
        identity: () => null,
        readDeviceToken: () => Promise.resolve(SENTINEL.device),
      });
      await call.invoke(wrapped);
      all.push(...requests);
    }
    for (const r of all) {
      for (const name of BUILD_IDENTITY_HEADERS) expect(r.headers.has(name)).toBe(false);
    }
  });
});
