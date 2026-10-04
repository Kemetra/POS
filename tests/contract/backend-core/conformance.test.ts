/**
 * RT-217 — the conformance judgement on fixture contracts: a known violation is
 * identified by what the client sends AND what the contract requires, so a re-pin
 * that changes a route's security can never hide behind an existing entry.
 */
import { describe, expect, it } from 'vitest';
import { CLIENT_CALLS, type ClientCall } from './client-registry.js';
import { diffAgainstKnown, observe, violationsFor } from './conformance.js';
import { KNOWN_VIOLATIONS } from './known-violations.js';
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

async function rosterDiff(scheme: {
  readonly name: string;
}): Promise<ReturnType<typeof diffAgainstKnown>> {
  const found = violationsFor(await observe(registered(ROSTER)), rosterContract(scheme));
  return diffAgainstKnown(
    found,
    KNOWN_VIOLATIONS.filter((k) => k.call === ROSTER),
  );
}

describe('known-violation identity', () => {
  it('matches the recorded roster violation while the contract is unchanged', async () => {
    expect(await rosterDiff({ name: 'operator-identity' })).toEqual({ unexpected: [], stale: [] });
  });

  it('fails when a re-pin changes the required credential of a known-violation route', async () => {
    const diff = await rosterDiff({ name: 'device' });
    expect(diff.unexpected).toHaveLength(1);
    expect(diff.unexpected[0]).toMatch(/sends none \| requires device/);
    expect(diff.stale).toEqual([
      `${ROSTER} | credential-mismatch | sends none | requires operator-jwt`,
    ]);
  });

  it('reports a new violation as unexpected and a fixed one as stale', async () => {
    const found = violationsFor(
      await observe(registered(ROSTER)),
      rosterContract({ name: 'device' }),
    );
    expect(diffAgainstKnown(found, []).unexpected).toHaveLength(1);
    expect(
      diffAgainstKnown(
        [],
        KNOWN_VIOLATIONS.filter((k) => k.call === ROSTER),
      ).stale,
    ).toHaveLength(1);
  });
});
