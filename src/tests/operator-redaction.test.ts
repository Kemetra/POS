// @vitest-environment node
import { PassThrough } from 'node:stream';
import { describe, it, vi, beforeEach } from 'vitest';
import pino from 'pino';

import { SignInHandler } from '../main/operator/sign-in-handler.js';
import { SignOutHandler } from '../main/operator/sign-out-handler.js';
import { SessionManager } from '../main/operator/session-manager.js';
import type { ClerkExchanger, ClerkExchangeResult } from '../main/operator/clerk-client.js';
import type { BackendClient, BackendSignInResponse } from '../main/operator/backend-client.js';
import { ProtoSessionStore } from '../main/operator/takeover-handler.js';

/**
 * 004-operator-session T025 — cross-process redaction smoke (extends
 * 002's). Drives the manager/admin sign-in handler through every
 * outcome category and asserts the password, identifier, and Clerk
 * JWT NEVER appear in any captured pino log line (PR-1 / FR-030).
 *
 * Sentry redaction is the responsibility of the existing 001/002
 * scrubber; this test focuses on the new operator credential surface.
 *
 * If any assertion fails, tighten the SOURCE — never the test.
 */

const SUBMITTED_PASSWORD = 'super-secret-password-9999';
const SUBMITTED_IDENTIFIER = 'leaky.manager@pharmacy.test';
const ISSUED_JWT = 'eyJhbGciOiJSUzI1NiJ9.LEAKED-JWT-PAYLOAD.fake-signature';

interface Streams {
  lines: () => string[];
}

function makeCapturingPinoLogger(): { logger: ReturnType<typeof pino>; streams: Streams } {
  const stream = new PassThrough();
  const buf: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => buf.push(chunk));

  const logger = pino(
    {
      level: 'info',
      // 004-operator-session redaction list (mirrors logger.ts).
      redact: {
        paths: [
          'password',
          '*.password',
          '*.*.password',
          'identifier',
          '*.identifier',
          '*.*.identifier',
          'pin',
          '*.pin',
          '*.*.pin',
          'jwt',
          '*.jwt',
          '*.*.jwt',
          'clerk_jwt',
          '*.clerk_jwt',
          '*.*.clerk_jwt',
          'session_token',
          '*.session_token',
          '*.*.session_token',
          'authorization',
          '*.authorization',
          '*.*.authorization',
        ],
      },
    },
    stream,
  );

  return {
    logger,
    streams: {
      lines: () => {
        const text = Buffer.concat(buf).toString('utf8');
        return text.split('\n').filter((l) => l.length > 0);
      },
    },
  };
}

const SUCCESS_BACKEND: BackendSignInResponse = {
  kind: 'signed_in',
  operator: {
    id: 'clerk-user-1',
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
  },
  operator_session: { id: 'be-1', issued_at: '2026-05-06T00:00:00.000Z' },
};

function fakeClerk(result: ClerkExchangeResult): ClerkExchanger {
  return { exchange: vi.fn(() => Promise.resolve(result)) };
}

function fakeBackend(result: BackendSignInResponse): BackendClient {
  return {
    signIn: vi.fn(() => Promise.resolve(result)),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
  };
}

function assertNoSecretIn(haystack: string, context: string): void {
  if (haystack.includes(SUBMITTED_PASSWORD)) {
    throw new Error(`[T025] password leaked in ${context}: "${SUBMITTED_PASSWORD}" found`);
  }
  if (haystack.includes(SUBMITTED_IDENTIFIER)) {
    throw new Error(`[T025] identifier leaked in ${context}: "${SUBMITTED_IDENTIFIER}" found`);
  }
  if (haystack.includes(ISSUED_JWT)) {
    throw new Error(`[T025] JWT leaked in ${context}: "${ISSUED_JWT}" found`);
  }
}

describe('T025 — operator sign-in cross-process redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const scenarios: Array<{
    label: string;
    clerk: () => ClerkExchanger;
    backend: () => BackendClient;
  }> = [
    {
      label: 'happy path (signed_in)',
      clerk: () =>
        fakeClerk({
          kind: 'ok',
          jwt: ISSUED_JWT,
          operator_id: 'clerk-user-1',
          display_name: 'Manager One',
          role: 'manager',
        }),
      backend: () => fakeBackend(SUCCESS_BACKEND),
    },
    {
      label: 'Clerk refused',
      clerk: () => fakeClerk({ kind: 'refused' }),
      backend: () => fakeBackend(SUCCESS_BACKEND),
    },
    {
      label: 'Clerk no_connection',
      clerk: () => fakeClerk({ kind: 'no_connection' }),
      backend: () => fakeBackend(SUCCESS_BACKEND),
    },
    {
      label: 'backend refused',
      clerk: () =>
        fakeClerk({
          kind: 'ok',
          jwt: ISSUED_JWT,
          operator_id: 'clerk-user-1',
          display_name: 'Manager One',
          role: 'manager',
        }),
      backend: () => fakeBackend({ kind: 'refused' }),
    },
    {
      label: 'backend no_connection',
      clerk: () =>
        fakeClerk({
          kind: 'ok',
          jwt: ISSUED_JWT,
          operator_id: 'clerk-user-1',
          display_name: 'Manager One',
          role: 'manager',
        }),
      backend: () => fakeBackend({ kind: 'no_connection' }),
    },
    {
      label: 'takeover_required',
      clerk: () =>
        fakeClerk({
          kind: 'ok',
          jwt: ISSUED_JWT,
          operator_id: 'clerk-user-1',
          display_name: 'Manager One',
          role: 'manager',
        }),
      backend: () => fakeBackend({ kind: 'takeover_required' }),
    },
  ];

  for (const scenario of scenarios) {
    it(`pino: outcome "${scenario.label}" — no password / identifier / JWT in any log line`, async () => {
      const { logger, streams } = makeCapturingPinoLogger();
      const handler = new SignInHandler({
        clerk: scenario.clerk(),
        backend: scenario.backend(),
        sessionManager: new SessionManager(),
        protoStore: new ProtoSessionStore(),
        deviceTokenAttestation: () => 'attest',
        logger,
      });
      await handler.signIn({
        kind: 'manager_admin',
        identifier: SUBMITTED_IDENTIFIER,
        password: SUBMITTED_PASSWORD,
      });
      assertNoSecretIn(streams.lines().join('\n'), `pino (outcome="${scenario.label}")`);
    });
  }

  it('sign-out: the JWT held for backend POST is not leaked', async () => {
    const { logger, streams } = makeCapturingPinoLogger();
    const sessionManager = new SessionManager();
    sessionManager.create({
      operator_id: 'op-1',
      display_name: 'Manager One',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'be-1',
    });
    const handler = new SignOutHandler({
      backend: fakeBackend(SUCCESS_BACKEND),
      sessionManager,
      jwtFor: () => ISSUED_JWT,
      logger,
    });
    await handler.signOut();
    assertNoSecretIn(streams.lines().join('\n'), 'pino (sign-out)');
  });
});
