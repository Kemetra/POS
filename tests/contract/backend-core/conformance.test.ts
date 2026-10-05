/**
 * RT-217 — the conformance judgement on fixture contracts: a known violation is
 * identified by what the client sends AND what the contract requires, so a re-pin
 * that changes a route's security can never hide behind an existing entry.
 */
import { describe, expect, it } from 'vitest';
import { BASE_URL, CLIENT_CALLS, SENTINEL, type ClientCall } from './client-registry.js';
import {
  diffAgainstKnown,
  observe,
  recordingFetch,
  sentCredential,
  violationsFor,
} from './conformance.js';
import { KNOWN_VIOLATIONS, type KnownViolation } from './known-violations.js';
import { indexContract, type ContractOperation } from './openapi-index.js';

const ROSTER = 'backendClient.listRoster';

function registered(id: string): ClientCall {
  const call = CLIENT_CALLS.find((c) => c.id === id);
  if (call === undefined) throw new Error(`${id} is not registered`);
  return call;
}

/** A one-route contract for GET /operators/roster secured by `scheme`. */
function rosterContract(scheme: { readonly name: string }): ContractOperation[] {
  return indexContract({
    name: 'fixture.yaml',
    text: [
      'paths:',
      '  /api/pos/v1/operators/roster:',
      '    get:',
      '      operationId: posOperatorRoster',
      '      security:',
      `        - ${scheme.name}: []`,
      'components:',
      '  securitySchemes:',
      `    ${scheme.name}:`,
      '      type: http',
      '      scheme: bearer',
      '',
    ].join('\n'),
  });
}

/**
 * A recorded violation used as the fixture for the identity rules. Since RT-214
 * the roster call sends the operator JWT, so judging it against a `device`-secured
 * fixture contract yields exactly this violation.
 */
const RECORDED: KnownViolation = {
  call: ROSTER,
  kind: 'credential-mismatch',
  sent: 'operator-jwt',
  requires: ['device'],
  tickets: ['fixture'],
  note: 'fixture: the roster judged against a device-secured contract',
};

async function rosterDiff(
  scheme: { readonly name: string },
  known: readonly KnownViolation[] = [RECORDED],
): Promise<ReturnType<typeof diffAgainstKnown>> {
  const found = violationsFor(await observe(registered(ROSTER)), rosterContract(scheme));
  return diffAgainstKnown(found, known);
}

describe('known-violation identity', () => {
  it('matches the recorded violation while the contract is unchanged', async () => {
    expect(await rosterDiff({ name: 'device' })).toEqual({ unexpected: [], stale: [] });
  });

  it('fails when a re-pin changes the required credential of a known-violation route', async () => {
    const diff = await rosterDiff({ name: 'operatorAuthorization' });
    expect(diff.unexpected).toHaveLength(1);
    expect(diff.unexpected[0]).toMatch(/sends operator-jwt \| requires operator-envelope/);
    expect(diff.stale).toEqual([
      `${ROSTER} | credential-mismatch | sends operator-jwt | requires device`,
    ]);
  });

  it('reports a new violation as unexpected and a fixed one as stale', async () => {
    expect((await rosterDiff({ name: 'device' }, [])).unexpected).toHaveLength(1);
    expect((await rosterDiff({ name: 'operator-identity' })).stale).toHaveLength(1);
  });
});

describe('RT-214 — the manager roster call', () => {
  it('conforms to an operator-identity route: it sends the operator JWT', async () => {
    const obs = await observe(registered(ROSTER));
    expect(obs.requests.map(sentCredential)).toEqual(['operator-jwt']);
    expect(violationsFor(obs, rosterContract({ name: 'operator-identity' }))).toEqual([]);
  });

  it('is no longer listed as a known violation', () => {
    expect(KNOWN_VIOLATIONS.filter((k) => k.call === ROSTER)).toEqual([]);
  });
});

describe('recordingFetch', () => {
  const url = `${BASE_URL}/api/pos/v1/catalog/snapshot`;
  const bearer = (token: string): HeadersInit => ({ Authorization: `Bearer ${token}` });

  async function record(input: RequestInfo | URL, init?: RequestInit) {
    const { fetch, requests } = recordingFetch();
    await fetch(input, init);
    expect(requests).toHaveLength(1);
    return requests[0] as NonNullable<(typeof requests)[0]>;
  }

  it('records the headers and method of a Request passed without init (Codex P2, PR #538)', async () => {
    const req = await record(
      new Request(url, { method: 'POST', headers: bearer(SENTINEL.device) }),
    );
    expect([req.method, sentCredential(req), req.url.pathname]).toEqual([
      'post',
      'device',
      '/api/pos/v1/catalog/snapshot',
    ]);
  });

  it('lets init.headers replace the Request headers, as fetch does', async () => {
    const req = await record(new Request(url, { headers: bearer(SENTINEL.device) }), {
      headers: bearer(SENTINEL['operator-jwt']),
    });
    expect(sentCredential(req)).toBe('operator-jwt');
  });

  it('records a plain string URL with init, normalising header case', async () => {
    const req = await record(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${SENTINEL.device}` },
    });
    expect([req.method, sentCredential(req)]).toEqual(['get', 'device']);
  });
});
