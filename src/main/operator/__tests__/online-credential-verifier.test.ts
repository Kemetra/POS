import { describe, expect, it } from 'vitest';

import type { ClerkExchanger } from '../clerk-client.js';
import { createDescopeExchanger } from '../descope-client.js';
import { OnlineCredentialVerifier } from '../online-credential-verifier.js';

/**
 * RT-792 — the online re-auth / unlock identity check is provider-neutral.
 *
 * After the RT-790 cutover Backend-Core returns the Descope userId as
 * `operator.id`, so the held session's `operator_id` is that userId. The
 * verifier's unchanged rule — the exchanged `operator_id` must equal the
 * session's — then works with the Descope exchanger as it did with Clerk.
 */

const PROJECT_ID = 'P2abcdefghijklmnopqrstuvwxyz';
const SESSION_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJVMSJ9.c2Vzc2lvbg';

function descopeReturning(userId: string): ClerkExchanger {
  const body = { sessionJwt: SESSION_JWT, refreshJwt: 'r', user: { userId, name: 'M' } };
  return createDescopeExchanger({
    projectId: PROJECT_ID,
    fetch: () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  });
}

describe('OnlineCredentialVerifier with the Descope exchanger', () => {
  it('verifies when the Descope userId equals the session operator_id', async () => {
    const verifier = new OnlineCredentialVerifier({ clerk: descopeReturning('U2manager') });
    const verdict = await verifier.verify('U2manager', 'm@x.test', 'pw');
    expect(verdict).toEqual({ kind: 'verified', jwt: SESSION_JWT });
  });

  it("refuses another account's valid credentials with the generic invalid_input", async () => {
    const verifier = new OnlineCredentialVerifier({ clerk: descopeReturning('U2someoneElse') });
    const verdict = await verifier.verify('U2manager', 'other@x.test', 'pw');
    expect(verdict).toEqual({ kind: 'refused', category: 'invalid_input', stage: 'identity' });
  });

  it('refuses a held pre-cutover Clerk id against a Descope userId', async () => {
    const verifier = new OnlineCredentialVerifier({ clerk: descopeReturning('U2manager') });
    const verdict = await verifier.verify('user_clerk123', 'm@x.test', 'pw');
    expect(verdict.kind).toBe('refused');
  });
});
